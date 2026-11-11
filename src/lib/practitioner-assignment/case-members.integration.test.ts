import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContractSubscriber } from '../contract-signing';
import { createContract, getContract } from '../contracts';
import { createLocalFileStore } from '../file-store/local-file-store';
import { withTx } from '../pg/database';
import { createVerifiedProperty } from '../ownership/test-kit';
import { actAs, setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { createSeedPracticeRegistry, type PracticeRegistryResolution } from '../practice-registry';
import { loadContractRoutingFacts } from '../signature-routing/repository';
import type { SigningDb } from '../signing-module/db';
import { createMockProvider } from '../signing-module/mock-adapter';
import { createSigningModule } from '../signing-module/module';
import type { ContractFields, ContractRoutingConditions, SignatureField } from '../types';
import { copyAssignments, getAssignments, replaceAssignments } from './repository';
import { loadSendInputs, prepareContractSend } from './send';
import type { PractitionerAssignmentInput } from './seats';
import { resolveAssignmentFacts } from './service';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// 整合測試（MIL-200 票面第 12 條）：合約掛在案件下，簽章人員存成案件成員。
// 走簽署模組介面，配 Mock adapter：三位簽署人，以及居間加包租的四位簽署人，都從送簽走到完成。
// 簽署事件經 webhook 進來。資料庫是 PGlite。執業人員資料來自 seed adapter，
// seed 的 party 沒有對應的 control.parties 列，所以測試先補上，案件成員的外鍵才成立。

const SEND_AT = '2026-11-09T12:00:00+08:00';
const SIGNABLE_AT = '2026-11-10T09:30:00+08:00';

const CHEN_EMAIL = 'chen.yijun@beichen.example.com';
const WANG_EMAIL = 'wang.jianguo@beichen.example.com';
const ZHAO_EMAIL = 'zhao.jingji@yunding.example.com';
const TENANT_EMAIL = 'tenant@example.com';

const MANAGER_SLOT = 'lease.master_lease.practitioner';
const BROKER_SLOT = 'lease.broker';

const seed: PracticeRegistryResolution = {
  available: true,
  registry: createSeedPracticeRegistry({ today: () => '2026-11-09' }),
};

let kit: RouteDb;
let dataDir: string;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-members-integration-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);
const statusOf = async (id: string) => (await inA((tx) => getContract(tx, id)))?.status;

const dbForA = (): SigningDb => ({
  requestOrg: async () => ({ kind: 'org', orgId: kit.orgA }),
  inOrg: (ctx, fn) => withTx(ctx, fn),
  inControl: (fn) => withTx({ kind: 'control' }, fn),
});

const document = {
  fileName: '租賃合約-測試物件',
  pdf: new Uint8Array([37, 80, 68, 70]),
  pageSize: { width: 595.28, height: 841.89 },
};

const sig = (id: string, signer: SignatureField['signer'], slot: string, x: number): SignatureField => ({
  id,
  signer,
  slot,
  page: 1,
  x,
  y: 0.8,
  w: 0.15,
  h: 0.1,
});
const FIELD_B = sig('b', 'party_b', 'lease.master_lease.party_b', 0.05);
const FIELD_P = sig('p', 'practitioner', MANAGER_SLOT, 0.3);
const FIELD_A = sig('a', 'party_a', 'lease.master_lease.party_a', 0.55);
const FIELD_K = sig('k', 'practitioner', BROKER_SLOT, 0.8);

const routing = (brokerMediated: boolean): ContractRoutingConditions => ({
  businessType: 'master_lease',
  lesseeIsMasterLessor: false,
  brokerMediated,
});

const managerAssignment: PractitionerAssignmentInput = {
  slot: MANAGER_SLOT,
  entityId: 'org-pe-beichen',
  practitionerId: 'pr-chen',
  partySignerId: 'ps-wang',
};
const brokerAssignment: PractitionerAssignmentInput = {
  slot: BROKER_SLOT,
  entityId: 'org-pe-yunding',
  practitionerId: 'pr-zhao',
  partySignerId: null,
};

const unixOf = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** 建一個案件與掛在它下面的草稿合約。轉租案件：分流條件是包租業者轉租給承租人。 */
async function newCasedContract(options: { brokerMediated: boolean; fields: SignatureField[] }): Promise<{ id: string; caseId: string }> {
  const propertyId = await createVerifiedProperty(kit);
  const caseId = newUlid();
  const id = await inA(async (tx) => {
    await tx.query(
      `INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, current_setting('app.org_id', true), 'lease', 'draft', 'master_lease', '測試案件')`,
      [caseId],
    );
    return createContract(tx, {
      property_id: propertyId,
      fields: {
        routing: routing(options.brokerMediated),
        landlordName: '王建國',
        landlordEmail: WANG_EMAIL,
        tenantName: '王租客',
        tenantEmail: TENANT_EMAIL,
      } as ContractFields,
      signature_fields: options.fields,
      case_id: caseId,
    });
  });
  return { id, caseId };
}

/** 走存指派的路徑：先查登錄補出席位資料，補上 seed party 的 control.parties 列，再整批寫成案件成員。 */
async function assignOnCase(id: string, assignments: PractitionerAssignmentInput[]): Promise<void> {
  const routingLoad = await inA((tx) => loadContractRoutingFacts(tx, id));
  if (!routingLoad.ok) throw new Error(routingLoad.reason);
  const resolved = await resolveAssignmentFacts(routingLoad.facts, assignments, seed);
  if (!resolved.ok) throw new Error(resolved.error);
  // seed 的 partyId 不是 ULID，control.parties 放不下。換成真實的 ULID 再寫成案件成員
  const seats = [];
  for (const s of resolved.value.seats) {
    const partyId = newUlid();
    await kit.asOwner((db) =>
      db.query('INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)', [partyId, `${partyId.toLowerCase()}@seed.test`, '測試執業人員']),
    );
    seats.push({ ...s, partyId });
  }
  await inA((tx) => replaceAssignments(tx, id, assignments, seats));
}

async function send(options: { brokerMediated: boolean; assignments: PractitionerAssignmentInput[]; fields: SignatureField[] }) {
  const { id, caseId } = await newCasedContract(options);
  await assignOnCase(id, options.assignments);
  const { contract, inputs } = await inA(async (tx) => ({ contract: (await getContract(tx, id))!, inputs: await loadSendInputs(tx, id) }));
  const prepared = await prepareContractSend(contract, inputs, seed, SEND_AT);
  if (!prepared.ok) throw new Error(prepared.error);
  const signing = createSigningModule({
    provider: createMockProvider(),
    subscribers: { contract: createContractSubscriber({ registry: () => seed }) },
    files: createLocalFileStore(dataDir),
    db: dbForA(),
  });
  const subject = { type: 'contract', id } as const;
  await signing.send(subject, document, prepared.signers, { context: prepared.sendContext });
  const taskRef = (
    await inA((tx) => tx.query<{ ref: string }>('SELECT provider_task_ref AS ref FROM org.sign_tasks WHERE subject_id = $1', [id]))
  ).rows[0].ref;
  const deliver = (action: string, email: string, at: string) =>
    signing.ingestWebhook(
      JSON.stringify({ resource_id: taskRef, resource_type: 'task', action_name: action, event_email: email, event_datetime: unixOf(at) }),
      new Headers(),
    );
  return { id, caseId, prepared, signing, subject, deliver };
}

const seatRows = (caseId: string) =>
  inA((tx) =>
    tx.query<{ slot: string; relation: string; entity_id: string; employment_id: string; party_signer_id: string | null }>(
      `SELECT slot, relation, entity_id, employment_id, party_signer_id FROM org.case_members WHERE case_id = $1 AND slot IS NOT NULL ORDER BY slot`,
      [caseId],
    ),
  ).then((r) => r.rows);

describe('案件下的合約：三位簽署人（乙方、專任管理人員、甲方）走到完成', () => {
  it('簽署人依序是乙方、執業人員、甲方，執業人員的 email 取自登錄帳號，指派存成案件成員', async () => {
    const { caseId, prepared } = await send({ brokerMediated: false, assignments: [managerAssignment], fields: [FIELD_B, FIELD_P, FIELD_A] });
    expect(prepared.ok && prepared.signers.map((s) => [s.role, s.email])).toEqual([
      ['party_b', TENANT_EMAIL],
      ['practitioner', CHEN_EMAIL],
      ['party_a', WANG_EMAIL],
    ]);
    expect(await seatRows(caseId)).toEqual([
      { slot: MANAGER_SLOT, relation: 'practitioner', entity_id: 'org-pe-beichen', employment_id: 'pr-chen', party_signer_id: 'ps-wang' },
    ]);
  });

  it('指派不在合約的指派表，送簽前提查案件成員', async () => {
    const { id } = await send({ brokerMediated: false, assignments: [managerAssignment], fields: [FIELD_B, FIELD_P, FIELD_A] });
    const legacy = await inA((tx) => tx.query('SELECT 1 FROM org.contract_practitioner_assignments WHERE contract_id = $1', [id]));
    expect(legacy.rows).toHaveLength(0);
    expect(await inA((tx) => getAssignments(tx, id))).toEqual([expect.objectContaining({ slot: MANAGER_SLOT, practitionerId: 'pr-chen', partySignerId: 'ps-wang' })]);
  });

  it('每一位簽完，合約狀態跟著走，三位簽完合約完成', async () => {
    const { id, deliver } = await send({ brokerMediated: false, assignments: [managerAssignment], fields: [FIELD_B, FIELD_P, FIELD_A] });
    expect(await statusOf(id)).toBe('awaiting_tenant');
    await deliver('signed', TENANT_EMAIL, SIGNABLE_AT);
    expect(await statusOf(id)).toBe('awaiting_practitioner');
    await deliver('signed', CHEN_EMAIL, SIGNABLE_AT);
    expect(await statusOf(id)).toBe('awaiting_landlord');
    await deliver('completed', 'Server', '2026-11-10T10:00:00+08:00');
    expect(await statusOf(id)).toBe('completed');
  });
});

describe('案件下的合約：居間加包租的四位簽署人走到完成', () => {
  it('依序是乙方、專任管理人員、甲方、經紀人，兩位執業人員各是一列案件成員（practitioner 與 broker）', async () => {
    const { caseId, prepared } = await send({
      brokerMediated: true,
      assignments: [managerAssignment, brokerAssignment],
      fields: [FIELD_B, FIELD_P, FIELD_A, FIELD_K],
    });
    expect(prepared.ok && prepared.signers.map((s) => [s.role, s.email])).toEqual([
      ['party_b', TENANT_EMAIL],
      ['practitioner', CHEN_EMAIL],
      ['party_a', WANG_EMAIL],
      ['practitioner', ZHAO_EMAIL],
    ]);
    expect((await seatRows(caseId)).map((r) => [r.slot, r.relation])).toEqual([
      [BROKER_SLOT, 'broker'],
      [MANAGER_SLOT, 'practitioner'],
    ]);
  });

  it('四位依序簽完，合約完成', async () => {
    const { id, deliver } = await send({
      brokerMediated: true,
      assignments: [managerAssignment, brokerAssignment],
      fields: [FIELD_B, FIELD_P, FIELD_A, FIELD_K],
    });
    for (const email of [TENANT_EMAIL, CHEN_EMAIL, WANG_EMAIL, ZHAO_EMAIL]) await deliver('signed', email, SIGNABLE_AT);
    await deliver('completed', 'Server', '2026-11-10T10:00:00+08:00');
    expect(await statusOf(id)).toBe('completed');
  });
});

describe('案件成員的寫入與讀取', () => {
  it('整批取代：改派與取消都不留舊的席位成員，一般成員不受影響', async () => {
    const { id, caseId } = await newCasedContract({ brokerMediated: true, fields: [] });
    await kit.asOwner((db) =>
      db.query(
        `INSERT INTO control.parties (id, email, display_name) VALUES ('00000000000000000000000090', 'lessee@seed.test', '承租人') ON CONFLICT DO NOTHING`,
      ),
    );
    await inA((tx) =>
      tx.query(
        `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, current_setting('app.org_id', true), $2, '00000000000000000000000090', 'lessee')`,
        [newUlid(), caseId],
      ),
    );
    await assignOnCase(id, [managerAssignment, brokerAssignment]);
    expect(await seatRows(caseId)).toHaveLength(2);
    await assignOnCase(id, [brokerAssignment]);
    expect((await seatRows(caseId)).map((r) => r.slot)).toEqual([BROKER_SLOT]);
    await assignOnCase(id, []);
    expect(await seatRows(caseId)).toEqual([]);
    const lessee = await inA((tx) => tx.query(`SELECT 1 FROM org.case_members WHERE case_id = $1 AND relation = 'lessee'`, [caseId]));
    expect(lessee.rows).toHaveLength(1);
  });

  it('缺少席位成員資料時整批拒絕，原本的指派不變', async () => {
    const { id } = await newCasedContract({ brokerMediated: false, fields: [] });
    await assignOnCase(id, [managerAssignment]);
    await expect(inA((tx) => replaceAssignments(tx, id, [brokerAssignment], []))).rejects.toThrow(/缺少席位成員資料/);
    expect((await inA((tx) => getAssignments(tx, id))).map((a) => a.slot)).toEqual([MANAGER_SLOT]);
  });

  it('同一個席位同一時間只有一列有效（資料庫的唯一鍵）', async () => {
    const { id, caseId } = await newCasedContract({ brokerMediated: false, fields: [] });
    await assignOnCase(id, [managerAssignment]);
    const [row] = await seatRows(caseId);
    await kit.asOwner((db) =>
      db.query(
        `INSERT INTO control.parties (id, email, display_name) VALUES ('00000000000000000000000091', 'other@seed.test', '另一位') ON CONFLICT DO NOTHING`,
      ),
    );
    await expect(
      inA((tx) =>
        tx.query(
          `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation, slot, entity_id, employment_id)
           VALUES ($1, current_setting('app.org_id', true), $2, '00000000000000000000000091', 'practitioner', $3, $4, 'pr-lin')`,
          [newUlid(), caseId, row.slot, row.entity_id],
        ),
      ),
    ).rejects.toThrow(/case_members_active_slot|duplicate key/);
  });

  it('席位欄的 CHECK：有席位但不是 practitioner 或 broker 的成員被擋', async () => {
    const { caseId } = await newCasedContract({ brokerMediated: false, fields: [] });
    await expect(
      inA((tx) =>
        tx.query(
          `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation, slot, entity_id, employment_id)
           VALUES ($1, current_setting('app.org_id', true), $2, '00000000000000000000000004', 'lessee', 's', 'e', 'm')`,
          [newUlid(), caseId],
        ),
      ),
    ).rejects.toThrow(/case_members_seat_columns/);
  });

  it('複製為新草稿：同一案件的合約共用案件的席位成員，不複製', async () => {
    const { id, caseId } = await newCasedContract({ brokerMediated: false, fields: [] });
    await assignOnCase(id, [managerAssignment]);
    const second = await inA((tx) =>
      createContract(tx, { property_id: null, fields: {} as ContractFields, case_id: caseId }),
    );
    await inA((tx) => copyAssignments(tx, id, second));
    expect((await inA((tx) => getAssignments(tx, second))).map((a) => a.slot)).toEqual([MANAGER_SLOT]);
    expect(await seatRows(caseId)).toHaveLength(1);
  });

  it('沒有案件的合約仍用舊表，行為不變', async () => {
    const id = await inA((tx) => createContract(tx, { property_id: null, fields: {} as ContractFields }));
    await inA((tx) => replaceAssignments(tx, id, [managerAssignment]));
    expect(await inA((tx) => getAssignments(tx, id))).toEqual([expect.objectContaining({ slot: MANAGER_SLOT, practitionerId: 'pr-chen' })]);
    const legacy = await inA((tx) => tx.query('SELECT 1 FROM org.contract_practitioner_assignments WHERE contract_id = $1', [id]));
    expect(legacy.rows).toHaveLength(1);
  });

  it('搬資料搬不動的舊列留在舊表：案件裡沒有那個席位時仍讀得到', async () => {
    const { id } = await newCasedContract({ brokerMediated: false, fields: [] });
    await inA((tx) =>
      tx.query(
        `INSERT INTO org.contract_practitioner_assignments (id, org_id, contract_id, slot, entity_id, practitioner_id)
         VALUES ($1, current_setting('app.org_id', true), $2, $3, 'org-pe-other', 'pr-x')`,
        [newUlid(), id, MANAGER_SLOT],
      ),
    );
    expect(await inA((tx) => getAssignments(tx, id))).toEqual([expect.objectContaining({ slot: MANAGER_SLOT, entityId: 'org-pe-other' })]);
    // 這一次整批取代把舊表的列一併換掉
    await assignOnCase(id, [managerAssignment]);
    const legacy = await inA((tx) => tx.query('SELECT 1 FROM org.contract_practitioner_assignments WHERE contract_id = $1', [id]));
    expect(legacy.rows).toHaveLength(0);
  });
});

describe('分流條件取自案件（票面第 11 條）', () => {
  it('合約掛在案件下：案件種類讀案件，不讀合約快照；快照不被改寫', async () => {
    const { id } = await newCasedContract({ brokerMediated: false, fields: [] });
    const load = await inA((tx) => loadContractRoutingFacts(tx, id));
    expect(load).toMatchObject({ ok: true, facts: { caseKind: 'sublease', documentType: 'lease', brokerMediated: false } });
    // 把案件改成包租案件：分流事實跟著案件，合約的快照原樣不動
    await inA((tx) =>
      tx.query(`UPDATE org.cases SET case_kind = 'master_lease', business_type = 'self_managed' WHERE id = (SELECT case_id FROM org.contracts WHERE id = $1)`, [id]),
    );
    const after = await inA((tx) => loadContractRoutingFacts(tx, id));
    expect(after).toMatchObject({ ok: true, facts: { caseKind: 'master_lease', brokerMediated: false } });
    expect((await inA((tx) => getContract(tx, id)))?.fields.routing).toEqual(routing(false));
  });

  it('沒有案件的合約仍由快照推導', async () => {
    const id = await inA((tx) => createContract(tx, { property_id: null, fields: { routing: routing(true) } as ContractFields }));
    expect(await inA((tx) => loadContractRoutingFacts(tx, id))).toMatchObject({
      ok: true,
      facts: { caseKind: 'sublease', brokerMediated: true },
    });
  });
});
