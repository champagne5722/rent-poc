import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContract } from '../contracts';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { insertSignTask } from '../signing-module/sign-task-store';
import {
  completeSignSnapshot,
  insertSignatureRecords,
  listPendingSignRecords,
  listSignatureRecords,
} from './repository';
import type { SignatureRecordInput } from './types';
import { buildCredentialSnapshot } from './snapshot';
import { createSeedPracticeRegistry } from '../practice-registry';
import type { ContractFields } from '../types';

// 簽章紀錄的 repository（MIL-70）：只為執業人員寫一列、參照簽署人列、寫入後不得修改。
// 資料庫是 PGlite（app_rw），trigger 是 plpgsql（db/migrations/0009_signature_records.sql）。

let kit: RouteDb;
let contractId: string;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);

const AT_SEND = '2026-11-09T12:00:00+08:00';
const AT_SIGN = '2026-11-10T09:30:00+08:00';
const RULE_ID = 'lease.master_lease.practitioner';

async function inputOf(overrides: Partial<SignatureRecordInput> = {}): Promise<SignatureRecordInput> {
  const registry = createSeedPracticeRegistry({ today: () => '2026-11-09' });
  const chen = (await registry.getPractitioner('pr-chen', { licenseKind: 'master_lease' }))!;
  return {
    signerIndex: 1,
    ruleId: RULE_ID,
    statuteRef: '租賃條例 §32 第 2、3 款',
    ruleVersion: 1,
    practitionerId: 'pr-chen',
    employmentId: chen.employmentId,
    entityId: 'org-pe-beichen',
    licenseKind: 'master_lease',
    concurrentRoles: [],
    snapshotAtSend: buildCredentialSnapshot(chen, AT_SEND),
    ...overrides,
  };
}

beforeEach(async () => {
  await kit.reset();
  contractId = await inA(async (tx) => {
    const id = await createContract(tx, { property_id: null, fields: {} as ContractFields });
    await insertSignTask(tx, {
      provider: 'mock',
      taskRef: 'task-1',
      subject: { type: 'contract', id },
      signers: [
        { role: 'party_b', name: '王租客', email: 'tenant@example.com' },
        { role: 'practitioner', name: '陳怡君', email: 'chen.yijun@beichen.example.com' },
        { role: 'party_a', name: '王建國', email: 'wang@example.com' },
      ],
    });
    return id;
  });
});

const insert = async (...records: SignatureRecordInput[]) => inA((tx) => insertSignatureRecords(tx, contractId, records));
const list = () => inA((tx) => listSignatureRecords(tx, contractId));
const complete = (snapshot: Parameters<typeof completeSignSnapshot>[3]) =>
  inA((tx) => completeSignSnapshot(tx, contractId, RULE_ID, snapshot));
const pending = () => inA((tx) => listPendingSignRecords(tx, contractId));

describe('寫入與讀回', () => {
  it('只為執業人員寫一列，並參照簽署人列', async () => {
    await insert(await inputOf());
    const records = await list();
    expect(records).toHaveLength(1);
    const { rows } = await inA((tx) =>
      tx.query<{ role: string; email: string }>('SELECT role, email FROM org.signers WHERE id = $1', [records[0].signerId]),
    );
    expect(rows[0]).toMatchObject({ role: 'practitioner', email: 'chen.yijun@beichen.example.com' });
  });

  it('法定欄位齊全：款次、規則、版本、執業人員、任職、執業主體、兼任角色', async () => {
    await insert(await inputOf({ concurrentRoles: ['party_a'] }));
    const [record] = await list();
    expect(record).toMatchObject({
      contractId,
      statuteRef: '租賃條例 §32 第 2、3 款',
      ruleId: RULE_ID,
      ruleVersion: 1,
      practitionerId: 'pr-chen',
      employmentId: 'emp-pr-chen',
      entityId: 'org-pe-beichen',
      concurrentRoles: ['party_a'],
    });
  });

  it('送簽時就有 snapshot_at_send，snapshot_at_sign 還是空的', async () => {
    await insert(await inputOf());
    const [record] = await list();
    expect(record.snapshotAtSend.decidedAt).toBe(AT_SEND);
    expect(record.snapshotAtSign).toBeNull();
  });

  it('沒有兼任時兼任角色是空陣列', async () => {
    await insert(await inputOf());
    expect((await list())[0].concurrentRoles).toEqual([]);
  });

  it('簽署人位置不存在時拒絕寫入', async () => {
    const orphan = await inputOf({ signerIndex: 9 });
    await expect(insert(orphan)).rejects.toThrow();
    expect(await list()).toEqual([]);
  });
});

describe('補 snapshot_at_sign', () => {
  it('補一次，其他欄位與 snapshot_at_send 不變', async () => {
    await insert(await inputOf());
    const [before] = await list();
    const registry = createSeedPracticeRegistry({ today: () => '2026-11-10' });
    const chen = (await registry.getPractitioner('pr-chen', { licenseKind: 'master_lease' }))!;
    const written = await complete(buildCredentialSnapshot(chen, AT_SIGN));
    expect(written).toBe(true);
    const [after] = await list();
    expect(after.snapshotAtSign?.decidedAt).toBe(AT_SIGN);
    expect({ ...after, snapshotAtSign: null }).toEqual({ ...before, snapshotAtSign: null });
  });

  it('已補過就不再寫入，回 false', async () => {
    await insert(await inputOf());
    const first = buildCredentialSnapshot(
      (await createSeedPracticeRegistry({ today: () => '2026-11-09' }).getPractitioner('pr-chen', { licenseKind: 'master_lease' }))!,
      AT_SIGN,
    );
    expect(await complete(first)).toBe(true);
    expect(await complete({ ...first, decidedAt: '2030-01-01T00:00:00+08:00' })).toBe(false);
    expect((await list())[0].snapshotAtSign?.decidedAt).toBe(AT_SIGN);
  });

  it('待補清單帶簽署人 email，已補的不在清單內', async () => {
    await insert(await inputOf());
    expect(await pending()).toEqual([
      { ruleId: RULE_ID, practitionerId: 'pr-chen', licenseKind: 'master_lease', signerEmail: 'chen.yijun@beichen.example.com' },
    ]);
    await complete({ decidedAt: AT_SIGN, unavailable: true, reason: 'x' });
    expect(await pending()).toEqual([]);
  });
});

describe('寫入後不得修改（資料庫層擋下，不只是 repository 沒有開放）', () => {
  const update = (assignment: string) => inA((tx) => tx.query(`UPDATE org.signature_records SET ${assignment}`));

  async function seeded() {
    await insert(await inputOf());
  }

  it.each([
    ['id', `'${newUlid()}'`],
    ['statute_ref', "'x'"],
    ['rule_id', "'x'"],
    ['rule_version', '9'],
    ['practitioner_id', "'x'"],
    ['employment_id', "'x'"],
    ['entity_id', "'x'"],
    ['license_kind', "'x'"],
    ['concurrent_roles', `'["party_a"]'::jsonb`],
    ['signer_id', `'${newUlid()}'`],
    ['contract_id', `'${newUlid()}'`],
    ['snapshot_at_send', "'{}'::jsonb"],
    ['created_at', "now() + interval '1 day'"],
  ])('改 %s 被擋下', async (column, value) => {
    await seeded();
    await expect(update(`${column} = ${value}`)).rejects.toThrow(/簽章紀錄寫入後不得修改/);
  });

  it('snapshot_at_sign 補上之後不得再改或清空', async () => {
    await seeded();
    await complete({ decidedAt: AT_SIGN, unavailable: true, reason: 'x' });
    await expect(update(`snapshot_at_sign = '{}'::jsonb`)).rejects.toThrow(/簽章紀錄寫入後不得修改/);
    await expect(update('snapshot_at_sign = NULL')).rejects.toThrow(/簽章紀錄寫入後不得修改/);
  });

  it('不得刪除', async () => {
    await seeded();
    await expect(inA((tx) => tx.query('DELETE FROM org.signature_records'))).rejects.toThrow(/簽章紀錄不得刪除/);
  });

  it('同一份合約同一席位只有一列', async () => {
    await seeded();
    const again = await inputOf();
    await expect(insert(again)).rejects.toThrow();
  });

  it('紀錄存在時，刪除合約被外鍵擋下', async () => {
    await seeded();
    await expect(inA((tx) => tx.query('DELETE FROM org.contracts WHERE id = $1', [contractId]))).rejects.toThrow();
  });
});

describe('migration 0009', () => {
  it('MIL-69 的判定事實快照暫存表已移除，由簽章紀錄的 snapshot_at_send 承接', async () => {
    const { rows } = await kit.asOwner((db) =>
      db.query<{ t: string | null }>("SELECT to_regclass('org.contract_credential_snapshots')::text AS t"),
    );
    expect(rows[0].t).toBeNull();
  });
});
