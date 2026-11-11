import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateCase, seedMandateCase, seedPracticeOrg } from '@/lib/case-store/entry-test-kit';
import { createPropertyAt } from '@/lib/ownership/test-kit';
import { actAs, actAsContext, setupRouteDb, TEST_PARTY_ID, TEST_USER_ID, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import { GET as getCases } from '../cases/route';
import { POST as createContract } from '../contracts/route';
import { GET as getOne } from './[id]/route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-209：物件頁的入口資料。接縫是 GET /api/properties/[id] 的 `available_case_kinds`，
// 與 GET /api/cases?property_id= 的物件案件列表。兩者對別的組織的物件，回應等同不存在。

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
const snap = async (res: Response) => ({ status: res.status, body: await res.text() });
const readProperty = (id: string) => getOne(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id }) });
const readCases = (propertyId?: string) =>
  getCases(new NextRequest(`http://localhost/api/cases${propertyId === undefined ? '' : `?property_id=${propertyId}`}`));
const create = (propertyId: string, caseKind: string) =>
  createContract(new NextRequest('http://localhost/api/contracts', { method: 'POST', body: JSON.stringify({ property_id: propertyId, case_kind: caseKind }) }));

function actAsPractice(): void {
  actAsContext({ kind: 'org', orgId: kit.orgA, orgKind: 'practice', userId: TEST_USER_ID, partyId: TEST_PARTY_ID, role: 'admin', requestId: 'test' });
}

describe('GET /api/properties/[id] 的 available_case_kinds', () => {
  it('屋主組織：已核對是 lease，沒有通過核對是空陣列', async () => {
    const verified = await createPropertyAt(kit, 'verified');
    const pending = await createPropertyAt(kit, 'pending_verification');
    const unsubmitted = await createPropertyAt(kit, 'unsubmitted');
    expect((await json(await readProperty(verified))).data.available_case_kinds).toEqual(['lease']);
    expect((await json(await readProperty(pending))).data.available_case_kinds).toEqual([]);
    expect((await json(await readProperty(unsubmitted))).data.available_case_kinds).toEqual([]);
  });

  it('執業主體組織：包租案件，自家有效的包租案件涵蓋後多出轉租案件，有委託管理案件後多出租賃案件', async () => {
    await seedPracticeOrg(kit, { orgId: kit.orgA });
    actAsPractice();
    const propertyId = await createPropertyAt(kit, 'verified');
    const kinds = async () => (await json(await readProperty(propertyId))).data.available_case_kinds;
    expect(await kinds()).toEqual(['master_lease']);

    const master = (await json(await create(propertyId, 'master_lease'))).data.case_id;
    expect(await kinds()).toEqual(['master_lease']);
    await activateCase(kit, kit.orgA, master);
    expect(await kinds()).toEqual(['master_lease', 'sublease']);

    await seedMandateCase(kit, { orgId: kit.orgA, propertyId });
    expect(await kinds()).toEqual(['lease', 'master_lease', 'sublease']);
  });

  it('資格不足的執業主體組織：空陣列', async () => {
    await seedPracticeOrg(kit, { orgId: kit.orgA, withManager: false });
    actAsPractice();
    const propertyId = await createPropertyAt(kit, 'verified');
    expect((await json(await readProperty(propertyId))).data.available_case_kinds).toEqual([]);
  });

  it('別的組織的物件與不存在的物件：回應逐位元相同，不洩漏節點狀態', async () => {
    const foreign = await createPropertyAt(kit, 'verified', { orgId: kit.orgB });
    const expected = await snap(await readProperty(newUlid()));
    expect(expected.status).toBe(404);
    expect(await snap(await readProperty(foreign))).toEqual(expected);
    expect(await snap(await readProperty('not-a-ulid'))).toEqual(expected);
  });

  it('既有的物件欄位照舊，available_case_kinds 只是多出的欄位', async () => {
    const propertyId = await createPropertyAt(kit, 'verified', { name: '舊欄位檢查' });
    const { data } = await json(await readProperty(propertyId));
    expect(data).toMatchObject({ id: propertyId, name: '舊欄位檢查', verification_status: 'verified' });
  });
});

describe('GET /api/cases?property_id=', () => {
  it('只回這個物件的案件，帶案件種類、狀態與連結', async () => {
    await seedPracticeOrg(kit, { orgId: kit.orgA });
    actAsPractice();
    const target = await createPropertyAt(kit, 'verified', { name: '目標物件' });
    const other = await createPropertyAt(kit, 'verified', { name: '別的物件' });
    const master = (await json(await create(target, 'master_lease'))).data.case_id;
    await activateCase(kit, kit.orgA, master);
    const sub = (await json(await create(target, 'sublease'))).data.case_id;
    await create(other, 'master_lease');

    const rows = (await json(await readCases(target))).data as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id).sort()).toEqual([master, sub].sort());
    const byId = Object.fromEntries(rows.map((r) => [r.id as string, r]));
    expect(byId[master]).toMatchObject({ caseKind: 'master_lease', state: 'active', propertyId: target, linkedMasterLeaseCaseId: null, isHost: true });
    expect(byId[sub]).toMatchObject({ caseKind: 'sublease', state: 'draft', propertyId: target, linkedMasterLeaseCaseId: master });

    expect(((await json(await readCases())).data as unknown[]).length).toBe(3);
  });

  it('自己的物件還沒有案件：空陣列', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    expect((await json(await readCases(propertyId))).data).toEqual([]);
  });

  it('別的組織的物件、不存在的物件、格式錯誤：回應逐位元相同，與物件不存在相同', async () => {
    const foreign = await createPropertyAt(kit, 'verified', { orgId: kit.orgB });
    actAs(kit.orgB);
    await create(foreign, 'lease');
    actAs(kit.orgA);
    const expected = await snap(await readProperty(newUlid()));
    expect(await snap(await readCases(foreign))).toEqual(expected);
    expect(await snap(await readCases(newUlid()))).toEqual(expected);
    expect(await snap(await readCases('not-a-ulid'))).toEqual(expected);
  });
});
