import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContract, getContract, saveDraft } from '../contracts';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import type { OrgTx } from '../pg/with-tx';
import { createSeedPracticeRegistry, type PracticeRegistryResolution } from '../practice-registry';
import { defaultStatusAnnex, type StatusAnnex } from '../status-annex';
import { statusAnnexPageMap, statusAnnexSendReasons } from '../status-annex/server';
import type { ContractFields, ContractRoutingConditions, SignatureField } from '../types';
import { replaceAssignments } from './repository';
import { loadSendInputs, prepareContractSend } from './send';

// 現況確認附件頁的簽署區域併入送簽前的原因清單（MIL-71）。
// prepareContractSend 收頁面地圖，伺服器端的 statusAnnexSendReasons 由 PDF 版面算出地圖後檢查。
// 資料庫是 PGlite（MIL-85）。

const AT = '2026-11-09T12:00:00+08:00';
const seed: PracticeRegistryResolution = {
  available: true,
  registry: createSeedPracticeRegistry({ today: () => '2026-11-09' }),
};

let kit: RouteDb;

beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

const inA = <T,>(fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: kit.orgA }, fn);

beforeEach(() => kit.reset());

const MASTER: ContractRoutingConditions = { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false };
const SLOT = 'lease.master_lease.practitioner';

const box = (id: string, signer: SignatureField['signer'], page: number, slot: string): SignatureField => ({
  id,
  signer,
  slot,
  page,
  x: 0.1,
  y: 0.8,
  w: 0.2,
  h: 0.1,
});

const BODY_BOXES = [
  box('b', 'party_b', 1, 'lease.master_lease.party_b'),
  box('p', 'practitioner', 1, SLOT),
  box('a', 'party_a', 1, 'lease.master_lease.party_a'),
];

function filledAnnex(): StatusAnnex {
  const annex = defaultStatusAnnex();
  return { ...annex, rows: annex.rows.map((r) => ({ ...r, status: 'normal' as const })) };
}

function newContract(signatureFields: SignatureField[], extra: object = {}): Promise<string> {
  const fields = {
    routing: MASTER,
    landlordName: '王建國',
    landlordEmail: 'wang.jianguo@beichen.example.com',
    tenantName: '王租客',
    tenantEmail: 'tenant@example.com',
    propertyName: '測試物件',
    propertyAddress: '台北市中正區測試路 1 號',
    propertyType: '整層住家',
    propertySize: 25,
    equipmentAnnex: [],
    rent: 25000,
    deposit: 50000,
    startDate: '2027-01-01',
    endDate: '2027-12-31',
    payDay: 5,
    extra: '',
    statusAnnex: filledAnnex(),
    ...extra,
  };
  return inA((tx) =>
    createContract(tx, { property_id: null, fields: fields as unknown as ContractFields, signature_fields: signatureFields }),
  );
}

const load = (id: string) => inA((tx) => getContract(tx, id).then((c) => c!));

async function prepare(id: string, pages: typeof PAGES) {
  const { contract, inputs } = await inA(async (tx) => ({
    contract: (await getContract(tx, id))!,
    inputs: await loadSendInputs(tx, id),
  }));
  return prepareContractSend(contract, inputs, seed, AT, { pages });
}

const ASSIGN = { slot: SLOT, entityId: 'org-pe-beichen', practitionerId: 'pr-chen', partySignerId: 'ps-wang' };
const PAGES = { pageCount: 3, signaturePage: 1, statusAnnexPage: 2 };

describe('prepareContractSend 收到頁面地圖時檢查附件頁', () => {
  it('執業人員在附件頁沒有簽署區域：擋下，原因併入既有的原因清單', async () => {
    const id = await newContract(BODY_BOXES);
    await inA((tx) => replaceAssignments(tx, id, [ASSIGN]));
    const prepared = await prepare(id, PAGES);
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.reasons.map((r) => r.code)).toEqual(['status_annex_signature_missing']);
    expect(prepared.error).toContain('請在現況確認附件頁為執業人員（租賃住宅管理人員）放置簽名框');
  });

  it('與其他原因一起列出：沒有指派執業人員也沒有附件頁簽署區域', async () => {
    const id = await newContract(BODY_BOXES);
    const prepared = await prepare(id, PAGES);
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(['practitioner_not_assigned', 'status_annex_signature_missing']),
    );
  });

  it('附件頁有執業人員的簽署區域時通過', async () => {
    const id = await newContract([...BODY_BOXES, box('p2', 'practitioner', 2, SLOT)]);
    await inA((tx) => replaceAssignments(tx, id, [ASSIGN]));
    const prepared = await prepare(id, PAGES);
    expect(prepared.ok).toBe(true);
  });
});

describe('statusAnnexSendReasons：由 PDF 版面算出附件頁，再檢查簽署區域', () => {
  it('包租租賃合約：附件頁在最後一頁，沒有框時擋下', async () => {
    const id = await newContract(BODY_BOXES);
    const contract = await load(id);
    const pages = await statusAnnexPageMap(contract);
    expect(pages?.statusAnnexPage).toBe(pages!.pageCount - 1);
    const reasons = await statusAnnexSendReasons(contract);
    expect(reasons.map((r) => r.code)).toEqual(['status_annex_signature_missing']);
  });

  it('框放在簽名頁以外、附件頁的頁碼上就通過', async () => {
    const id = await newContract(BODY_BOXES);
    const pages = (await statusAnnexPageMap(await load(id)))!;
    await inA(async (tx) => {
      const current = (await getContract(tx, id, 'update'))!;
      await saveDraft(tx, id, {
        fields: current.fields,
        signature_fields: [...BODY_BOXES, box('p2', 'practitioner', pages.statusAnnexPage!, SLOT)],
      });
    });
    expect(await statusAnnexSendReasons(await load(id))).toEqual([]);
  });

  it('不必附附件的合約不產 PDF、不檢查', async () => {
    const id = await newContract([], { routing: { businessType: 'self_managed', lesseeIsMasterLessor: false, brokerMediated: false } });
    const contract = await load(id);
    expect(await statusAnnexPageMap(contract)).toBeUndefined();
    expect(await statusAnnexSendReasons(contract)).toEqual([]);
  });

  it('沒有分流條件的舊合約讀入不報錯，也不檢查', async () => {
    const id = await newContract([], { routing: undefined, statusAnnex: undefined });
    expect(await statusAnnexSendReasons(await load(id))).toEqual([]);
  });
});
