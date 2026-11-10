import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceOwnership, createPropertyAt, lapseOwnership, verifyProperty, type OwnershipStage } from '@/lib/ownership/test-kit';
import { PROPERTY_NOT_VERIFIED_CODE, PROPERTY_NOT_VERIFIED_MESSAGE } from '@/lib/ownership/gate';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsContext, setupRouteDb, TEST_PARTY_ID, TEST_USER_ID, type RouteDb } from '@/lib/pg/route-test-kit';
import { createProperty, parsePropertyInput } from '@/lib/properties';
import { GET as getOne } from './[id]/route';
import { POST as copy } from './[id]/copy/route';
import { GET as getList, POST } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-205：物件通過平台的文件核對後才能建立案件與合約（ADR-0028 決議 5）。
// 接縫是 POST /api/contracts 的公開回應。有案件的路（屋主組織）由 createLeaseCase 自己檢查，
// 沒有案件的路（代管業者與包租業者的組織）由 route 用同一個讀取入口檢查。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
});

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const create = (propertyId: string, extra: Record<string, unknown> = {}) =>
  POST(new NextRequest('http://localhost/api/contracts', { method: 'POST', body: JSON.stringify({ property_id: propertyId, ...extra }) }));
const snap = async (res: Response) => ({ status: res.status, body: await res.text() });

const BLOCKED = { status: 409, body: JSON.stringify({ error: PROPERTY_NOT_VERIFIED_MESSAGE, code: PROPERTY_NOT_VERIFIED_CODE }) };

const countRows = (table: 'org.cases' | 'org.contracts', orgId = kit.orgA) =>
  withTx({ kind: 'org', orgId, partyId: TEST_PARTY_ID }, async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

/** 代管業者或包租業者的組織：沒有案件的路。組織種類取自請求脈絡。 */
function actAsPracticeOrg(orgId: string): void {
  actAsContext({ kind: 'org', orgId, orgKind: 'practice', userId: TEST_USER_ID, partyId: TEST_PARTY_ID, role: 'admin', requestId: 'test' });
}

/** 沒有建號的既有物件（ADR-0028 決議 9 之前登錄的資料）。 */
async function legacyPropertyWithoutKey(orgId: string): Promise<string> {
  const parsed = parsePropertyInput({ name: '舊物件', address: '台北市大安區某路 9 號', equipment: [] });
  if (!parsed.ok) throw new Error(parsed.error);
  return withTx({ kind: 'org', orgId, partyId: TEST_PARTY_ID }, (tx) => createProperty(tx, parsed.value));
}

const NOT_VERIFIED_STAGES: Array<{ name: string; stage: OwnershipStage | 'unsubmitted' }> = [
  { name: '剛登錄，沒有節點', stage: 'unsubmitted' },
  { name: '待驗證', stage: 'pending_verification' },
  { name: '驗證失敗', stage: 'failed' },
];

describe('屋主組織建約（有案件的路）', () => {
  it.each(NOT_VERIFIED_STAGES)('$name：拒絕，回 409 與固定的原因，沒有建案件與合約', async ({ stage }) => {
    const propertyId = await createPropertyAt(kit, stage);
    expect(await snap(await create(propertyId))).toEqual(BLOCKED);
    expect(await countRows('org.cases')).toBe(0);
    expect(await countRows('org.contracts')).toBe(0);
    expect((await json(await getList())).data).toEqual([]);
  });

  it('已失效：拒絕', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    await lapseOwnership(kit, propertyId);
    expect(await snap(await create(propertyId))).toEqual(BLOCKED);
    expect(await countRows('org.cases')).toBe(0);
  });

  it('已驗證：建立案件與合約', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    const res = await create(propertyId);
    expect(res.status).toBe(201);
    expect(await countRows('org.cases')).toBe(1);
    expect(await countRows('org.contracts')).toBe(1);
  });

  it('驗證失敗後補件重新通過：能建立', async () => {
    const propertyId = await createPropertyAt(kit, 'failed');
    expect((await create(propertyId)).status).toBe(409);
    await verifyProperty(kit, propertyId);
    expect((await create(propertyId)).status).toBe(201);
  });

  it('既有的沒有建號的物件：不能建立新案件，原因與其他未核對的物件相同', async () => {
    const propertyId = await legacyPropertyWithoutKey(kit.orgA);
    expect(await snap(await create(propertyId))).toEqual(BLOCKED);
    expect(await countRows('org.cases')).toBe(0);
  });

  it('原因不因別的組織有沒有核對過而不同：別的組織的物件已核對，這個組織的未核對物件仍回同一個回應', async () => {
    actAs(kit.orgB);
    await createPropertyAt(kit, 'verified');
    actAs(kit.orgA);
    const unsubmitted = await createPropertyAt(kit, 'unsubmitted');
    const pending = await createPropertyAt(kit, 'pending_verification');
    const noKey = await legacyPropertyWithoutKey(kit.orgA);
    const bodies = [];
    for (const id of [unsubmitted, pending, noKey]) bodies.push(await snap(await create(id)));
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toEqual(BLOCKED);
  });

  it('呼叫端不能繞過：分流條件說承租人是包租業者（過渡路徑）也一樣被擋', async () => {
    const propertyId = await createPropertyAt(kit, 'pending_verification');
    const res = await create(propertyId, { routing: { businessType: 'self_managed', lesseeIsMasterLessor: true, brokerMediated: false } });
    expect(await snap(res)).toEqual(BLOCKED);
    expect(await countRows('org.cases')).toBe(0);
  });
});

describe('代管業者與包租業者的組織建約（沒有案件的路）', () => {
  beforeEach(() => actAsPracticeOrg(kit.orgA));

  it.each(NOT_VERIFIED_STAGES)('$name：拒絕，與屋主組織同一個回應，沒有建合約', async ({ stage }) => {
    const propertyId = await createPropertyAt(kit, stage);
    expect(await snap(await create(propertyId))).toEqual(BLOCKED);
    expect(await countRows('org.contracts')).toBe(0);
  });

  it('已失效：拒絕', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    await lapseOwnership(kit, propertyId);
    expect(await snap(await create(propertyId))).toEqual(BLOCKED);
  });

  it('沒有建號的既有物件：拒絕', async () => {
    expect(await snap(await create(await legacyPropertyWithoutKey(kit.orgA)))).toEqual(BLOCKED);
  });

  it('已驗證：建立沒有案件的合約，合約不掛案件', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    const res = await create(propertyId, { routing: { businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false } });
    expect(res.status).toBe(201);
    expect(await countRows('org.contracts')).toBe(1);
    expect(await countRows('org.cases')).toBe(0);
  });
});

describe('新規則生效前已建立的合約不受影響', () => {
  it('節點之後失效：讀取合約與列表、複製草稿都照常，只有新建被擋', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    const created = await create(propertyId);
    const id = (await json(created)).data.id as string;
    await lapseOwnership(kit, propertyId);

    const ctx = { params: Promise.resolve({ id }) };
    expect((await getOne(new NextRequest('http://localhost/x'), ctx)).status).toBe(200);
    expect((await json(await getList())).data).toHaveLength(1);
    // 撤回後複製為新草稿留在原案件，不檢查核對
    await withTx({ kind: 'org', orgId: kit.orgA, partyId: TEST_PARTY_ID }, (tx) => tx.query(`UPDATE org.contracts SET status = 'voided' WHERE id = $1`, [id]));
    expect((await copy(new NextRequest('http://localhost/x', { method: 'POST' }), ctx)).status).toBe(201);
    expect(await snap(await create(propertyId))).toEqual(BLOCKED);
  });
});

describe('advanceOwnership 的接縫', () => {
  it('同一個物件重複推到已驗證不出錯，也不重複建節點', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    await advanceOwnership(kit, propertyId, 'verified');
    expect((await create(propertyId)).status).toBe(201);
  });
});
