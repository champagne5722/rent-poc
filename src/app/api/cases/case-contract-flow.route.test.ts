import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { getDepositLedger, listPeriods } from '@/lib/case-ledger';
import { getCase, listCaseEvents, listCaseMembers } from '@/lib/case-store';
import { DATA_DIR } from '@/lib/db';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsContext, setupRouteDb, TEST_PARTY_ID, TEST_USER_ID, type RouteDb } from '@/lib/pg/route-test-kit';
import { POST as advance } from '../mock/advance/route';
import { POST as createProperty } from '../properties/route';
import { PUT, DELETE } from '../contracts/[id]/route';
import { POST as copy } from '../contracts/[id]/copy/route';
import { POST as send } from '../contracts/[id]/send/route';
import { POST as voidContract } from '../contracts/[id]/void/route';
import { POST as create } from '../contracts/route';

// 建約先建案件，案件訂閱合約的送簽、完成、拒簽、撤回（MIL-115，ADR-0016 決議 11、12，ADR-0023 決議 1）。
// 接縫是 route：用 route 建約、送簽、模擬簽署，再從資料庫讀案件。簽署模組用 mock 模式與 PGlite。

vi.mock('@/lib/db', async (importOriginal) => {
  const os = await import('node:os');
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  return {
    ...(await importOriginal<typeof import('@/lib/db')>()),
    DATA_DIR: fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'case-flow-')),
  };
});

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(async () => {
  await kit.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
});

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, payload?: unknown) =>
  new NextRequest('http://localhost/api/x', { method, body: payload === undefined ? undefined : JSON.stringify(payload) });

const SIGNATURE_FIELDS = [
  { id: 'f1', signer: 'party_a', page: 0, x: 0.6, y: 0.8, w: 0.2, h: 0.1 },
  { id: 'f2', signer: 'party_b', page: 0, x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
];
const READY_FIELDS = {
  landlordName: '林房東',
  landlordEmail: 'landlord@example.com',
  tenantName: '王租客',
  tenantEmail: 'Tenant@Example.com',
  startDate: '2026-09-01',
  endDate: '2027-08-31',
  rent: 21000,
};

async function newDraft(fields: Record<string, unknown> = READY_FIELDS): Promise<{ contractId: string; caseId: string | null }> {
  const propertyRes = await createProperty(
    new NextRequest('http://localhost/api/properties', {
      method: 'POST',
      body: JSON.stringify({ name: '大安區溫馨兩房', address: '台北市大安區某路 1 號', default_rent: 20000, equipment: [] }),
    }),
  );
  const propertyId = (await json(propertyRes)).data.id;
  const res = await create(new NextRequest('http://localhost/api/contracts', { method: 'POST', body: JSON.stringify({ property_id: propertyId }) }));
  expect(res.status).toBe(201);
  const contractId = (await json(res)).data.id;
  await PUT(req('PUT', { fields, signature_fields: SIGNATURE_FIELDS }), ctx(contractId));
  const caseId = await caseIdOfContract(contractId);
  return { contractId, caseId };
}

const caseIdOfContract = (contractId: string) =>
  withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => (await tx.query<{ case_id: string | null }>('SELECT case_id FROM org.contracts WHERE id = $1', [contractId])).rows[0].case_id);

const readCase = (caseId: string) =>
  withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => ({
    record: await getCase(tx, caseId),
    events: await listCaseEvents(tx, caseId),
    members: await listCaseMembers(tx, caseId),
  }));

const mockAdvance = (contractId: string, event: string, reason?: string) =>
  advance(new NextRequest('http://localhost/api/mock/advance', { method: 'POST', body: JSON.stringify({ contract_id: contractId, event, reason }) }));

describe('建約第一步建立自管租賃案件', () => {
  it('建約同時建立 draft 案件，合約掛在案件下，建立者是出租人成員', async () => {
    const { contractId, caseId } = await newDraft();
    expect(caseId).not.toBeNull();
    const { record, events, members } = await readCase(caseId!);
    expect(record).toMatchObject({
      kind: 'lease',
      state: 'draft',
      businessType: 'self_managed',
      orgId: kit.orgA,
      currentContractId: contractId,
      title: '大安區溫馨兩房（台北市大安區某路 1 號）',
    });
    expect(record?.rentalUnitId).toBeTruthy();
    expect(members.map((m) => [m.partyId, m.relation])).toEqual([[TEST_PARTY_ID, 'lessor']]);
    expect(events.map((e) => e.type)).toEqual(['created', 'contract_attached']);
  });

  it('執業主體組織建約：本票不建案件，合約沒有 case_id（MIL-116 接手）', async () => {
    actAsContext({ kind: 'org', orgId: kit.orgA, orgKind: 'practice', userId: TEST_USER_ID, partyId: TEST_PARTY_ID, role: 'admin', requestId: 't' });
    const { caseId } = await newDraft();
    expect(caseId).toBeNull();
  });
});

describe('案件訂閱合約', () => {
  it('送簽：案件進入 signing，租期同步，承租人依乙方 email 成為 lessee（email 正規化）', async () => {
    const { contractId, caseId } = await newDraft();
    expect((await send(req('POST'), ctx(contractId))).status).toBe(200);

    const { record, members, events } = await readCase(caseId!);
    expect(record).toMatchObject({ state: 'signing', stateVersion: 1, leaseStart: '2026-09-01', leaseEnd: '2027-08-31', monthlyRent: 21000 });
    const lessee = members.find((m) => m.relation === 'lessee');
    expect(lessee).toMatchObject({ email: 'tenant@example.com', displayName: '王租客', validUntil: null });
    expect(events.map((e) => e.type)).toEqual(['created', 'contract_attached', 'contract_sent', 'member_added']);
  });

  it('兩位簽完：案件 active。乙方簽完不動案件', async () => {
    const { contractId, caseId } = await newDraft();
    await send(req('POST'), ctx(contractId));
    await mockAdvance(contractId, 'signed');
    expect((await readCase(caseId!)).record?.state).toBe('signing');
    await mockAdvance(contractId, 'completed');
    const { record, events } = await readCase(caseId!);
    expect(record).toMatchObject({ state: 'active', stateVersion: 2 });
    expect(events.at(-1)).toMatchObject({ type: 'contract_completed', fromState: 'signing', toState: 'active', actorPartyId: null });
  });

  it('全員完成：同交易建立押金台帳與全部應收期別，約定金額取合約的押金（MIL-123）', async () => {
    const { contractId, caseId } = await newDraft();
    await send(req('POST'), ctx(contractId));
    const ledgerOf = () =>
      withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => ({ ledger: await getDepositLedger(tx, caseId!), periods: await listPeriods(tx, caseId!) }));

    await mockAdvance(contractId, 'signed');
    expect(await ledgerOf()).toEqual({ ledger: null, periods: [] });

    await mockAdvance(contractId, 'completed');
    const { ledger, periods } = await ledgerOf();
    // 押金是建約時由物件的預設租金兩倍帶入（20000 的兩倍），付款日預設每月 5 日
    expect(ledger).toMatchObject({ caseId, expectedAmount: 40000, status: 'open' });
    expect(periods).toHaveLength(12);
    expect(periods[0]).toMatchObject({ periodKey: '2026-09', periodStart: '2026-09-01', periodEnd: '2026-09-30', dueDate: '2026-09-05', amount: 21000, state: 'active' });
    expect(periods[11]).toMatchObject({ periodKey: '2027-08', periodEnd: '2027-08-31', dueDate: '2027-08-05' });
  });

  it('案件拒絕完成事件時，不建押金台帳（案件不在 signing）', async () => {
    const { contractId, caseId } = await newDraft();
    await send(req('POST'), ctx(contractId));
    // 製造不一致：案件已不在 signing，合約仍在簽署中
    await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => tx.query(`UPDATE org.cases SET state = 'draft' WHERE id = $1`, [caseId]));
    await mockAdvance(contractId, 'signed');
    await mockAdvance(contractId, 'completed');
    const { events } = await readCase(caseId!);
    expect(events.find((e) => e.type === 'input_rejected' && e.payload.inputType === 'contract_completed')).toBeTruthy();
    const ledger = await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => getDepositLedger(tx, caseId!));
    expect(ledger).toBeNull();
  });

  it('拒簽：案件回 draft，之後複製的新草稿留在同一案件，目前合約改指向它（P0-09 AC7）', async () => {
    const { contractId, caseId } = await newDraft();
    await send(req('POST'), ctx(contractId));
    await mockAdvance(contractId, 'declined', '租金認知有落差');
    expect((await readCase(caseId!)).record?.state).toBe('draft');

    const copied = await copy(req('POST'), ctx(contractId));
    expect(copied.status).toBe(201);
    const newId = (await json(copied)).data.id;
    expect(await caseIdOfContract(newId)).toBe(caseId);
    const { record, events } = await readCase(caseId!);
    expect(record).toMatchObject({ state: 'draft', currentContractId: newId });
    expect(events.at(-1)).toMatchObject({ type: 'contract_attached', payload: { contractId: newId, derivedFrom: null } });
  });

  it('撤回：案件回 draft，複製的新草稿記衍生關聯，可以再送簽', async () => {
    const { contractId, caseId } = await newDraft();
    await send(req('POST'), ctx(contractId));
    expect((await voidContract(req('POST'), ctx(contractId))).status).toBe(200);
    expect((await readCase(caseId!)).record?.state).toBe('draft');

    const newId = (await json(await copy(req('POST'), ctx(contractId)))).data.id;
    const { events } = await readCase(caseId!);
    expect(events.at(-1)).toMatchObject({ type: 'contract_attached', payload: { contractId: newId, derivedFrom: contractId } });

    expect((await send(req('POST'), ctx(newId))).status).toBe(200);
    const { record, members } = await readCase(caseId!);
    expect(record?.state).toBe('signing');
    // 承租人只有一列有效：重送不重複加入
    expect(members.filter((m) => m.relation === 'lessee')).toHaveLength(1);
  });

  it('舊合約的事件不再推進案件：案件只認目前的合約', async () => {
    const { contractId, caseId } = await newDraft();
    await send(req('POST'), ctx(contractId));
    await voidContract(req('POST'), ctx(contractId));
    const newId = (await json(await copy(req('POST'), ctx(contractId)))).data.id;
    await send(req('POST'), ctx(newId));
    // 舊合約已撤回，簽署任務結束，再來的事件被簽署模組擋下，案件維持 signing
    await mockAdvance(contractId, 'completed');
    expect((await readCase(caseId!)).record?.state).toBe('signing');
  });

  it('案件拒絕送簽時，合約照常轉移，案件寫 input_rejected（法律事實優先）', async () => {
    const { contractId, caseId } = await newDraft();
    // 製造不一致：案件已不在 draft，但合約仍是草稿
    await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => tx.query(`UPDATE org.cases SET state = 'aborted' WHERE id = $1`, [caseId]));
    const res = await send(req('POST'), ctx(contractId));
    // aborted 是終態，authorize 以 case_closed_read_only 拒絕（不是 state_not_allowed），所以送簽被擋
    expect(res.status).toBe(404);

    await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => tx.query(`UPDATE org.cases SET state = 'active' WHERE id = $1`, [caseId]));
    const sent = await send(req('POST'), ctx(contractId));
    expect(sent.status).toBe(200);
    const { record, events } = await readCase(caseId!);
    expect(record?.state).toBe('active');
    expect(events.find((e) => e.type === 'input_rejected')).toMatchObject({
      payload: { inputType: 'contract_sent', state: 'active', contractId },
    });
    const contract = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => (await tx.query<{ status: string }>('SELECT status FROM org.contracts WHERE id = $1', [contractId])).rows[0]);
    expect(contract.status).toBe('awaiting_tenant');
  });

  it('乙方 email 格式不符：送簽前檢查擋下，案件維持 draft，不建承租人成員', async () => {
    const { contractId, caseId } = await newDraft({ ...READY_FIELDS, tenantEmail: 'not-an-email' });
    const res = await send(req('POST'), ctx(contractId));
    expect(res.status).toBe(400);
    const { record, members } = await readCase(caseId!);
    expect(record?.state).toBe('draft');
    expect(members.filter((m) => m.relation === 'lessee')).toEqual([]);
  });
});

describe('刪除草稿', () => {
  it('刪除草稿合約後，沒有合約的 draft 案件被放棄（aborted）', async () => {
    const { contractId, caseId } = await newDraft();
    expect((await DELETE(req('DELETE'), ctx(contractId))).status).toBe(200);
    const { record, events } = await readCase(caseId!);
    expect(record).toMatchObject({ state: 'aborted', currentContractId: null });
    expect(events.at(-1)).toMatchObject({ type: 'aborted', fromState: 'draft', toState: 'aborted' });
  });

  it('案件下還有撤回留下的舊合約時，刪除新草稿不放棄案件，目前合約清空，可以再複製舊合約', async () => {
    const { contractId, caseId } = await newDraft();
    await send(req('POST'), ctx(contractId));
    await voidContract(req('POST'), ctx(contractId));
    const draftId = (await json(await copy(req('POST'), ctx(contractId)))).data.id;
    expect((await DELETE(req('DELETE'), ctx(draftId))).status).toBe(200);
    const { record } = await readCase(caseId!);
    expect(record).toMatchObject({ state: 'draft', currentContractId: null });
    const again = await copy(req('POST'), ctx(contractId));
    expect(again.status).toBe(201);
    expect((await readCase(caseId!)).record?.currentContractId).toBe((await json(again)).data.id);
  });
});
