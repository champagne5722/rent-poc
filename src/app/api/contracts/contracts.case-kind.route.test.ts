import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { routingForNewCase } from '@/lib/case-store';
import { activateCase, seedMandateCase, seedPracticeOrg } from '@/lib/case-store/entry-test-kit';
import { PROPERTY_NOT_VERIFIED_CODE, PROPERTY_NOT_VERIFIED_MESSAGE } from '@/lib/ownership/gate';
import { createPropertyAt } from '@/lib/ownership/test-kit';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsContext, setupRouteDb, TEST_PARTY_ID, TEST_USER_ID, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import type { OrgRole } from '@/lib/request-context';
import { GET as getProperty } from '../properties/[id]/route';
import { POST } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-209：從物件與案件種類建立案件。接縫是 POST /api/contracts 帶 `case_kind` 的公開回應。
// 不帶 `case_kind` 的舊路徑由 contracts.route.test.ts 與 contracts.gate.route.test.ts 驗證，這裡不重複。

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
const post = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://localhost/api/contracts', { method: 'POST', body: JSON.stringify(body) }));
const create = (propertyId: unknown, caseKind: unknown, extra: Record<string, unknown> = {}) =>
  post({ property_id: propertyId, case_kind: caseKind, ...extra });

function actAsOrg(orgId: string, orgKind: 'owner' | 'practice', role: OrgRole = 'admin'): void {
  actAsContext({ kind: 'org', orgId, orgKind, userId: TEST_USER_ID, partyId: TEST_PARTY_ID, role, requestId: 'test' });
}

/** GET /api/properties/[id] 對「不存在」的回應。看不到物件的回應必須與它逐位元相同。 */
async function notFoundSnapshot(): Promise<{ status: number; body: string }> {
  return snap(await getProperty(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: newUlid() }) }));
}

const NOT_VERIFIED = { status: 409, body: JSON.stringify({ error: PROPERTY_NOT_VERIFIED_MESSAGE, code: PROPERTY_NOT_VERIFIED_CODE }) };

const rows = <T>(orgId: string, sql: string, params: unknown[] = []) =>
  withTx({ kind: 'org', orgId, partyId: TEST_PARTY_ID }, async (tx) => (await tx.query<T>(sql, params)).rows);
const counts = async (orgId = kit.orgA) => ({
  cases: (await rows<{ n: number }>(orgId, 'SELECT count(*)::int AS n FROM org.cases'))[0].n,
  contracts: (await rows<{ n: number }>(orgId, 'SELECT count(*)::int AS n FROM org.contracts'))[0].n,
});

describe('看不到物件、沒有權限、不存在：回應逐位元相同', () => {
  it('沒帶物件、格式錯誤、不存在、別的組織的物件，都與物件不存在的回應相同', async () => {
    actAsOrg(kit.orgB, 'owner');
    const foreign = await createPropertyAt(kit, 'verified', { orgId: kit.orgB });
    actAs(kit.orgA);
    const expected = await notFoundSnapshot();
    expect(expected.status).toBe(404);
    for (const propertyId of [undefined, '', 'not-a-ulid', newUlid(), foreign]) {
      expect(await snap(await create(propertyId, 'lease'))).toEqual(expected);
    }
    expect(await counts(kit.orgA)).toEqual({ cases: 0, contracts: 0 });
    expect(await counts(kit.orgB)).toEqual({ cases: 0, contracts: 0 });
  });

  it('同組織的 viewer 沒有寫入權限：與不存在相同', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    const expected = await notFoundSnapshot();
    actAsOrg(kit.orgA, 'owner', 'viewer');
    expect(await snap(await create(propertyId, 'lease'))).toEqual(expected);
    expect(await counts()).toEqual({ cases: 0, contracts: 0 });
  });

  it('案件種類格式錯誤或是委託管理案件：400，不建任何資料', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    for (const caseKind of ['management', 'nope', 1, null]) {
      expect((await create(propertyId, caseKind)).status).toBe(400);
    }
    expect(await counts()).toEqual({ cases: 0, contracts: 0 });
  });

  it('合約類型與案件種類不符：400', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    expect((await create(propertyId, 'lease', { contract_type: 'management' })).status).toBe(400);
    expect((await create(propertyId, 'lease', { contract_type: 'master_lease' })).status).toBe(400);
    expect((await create(propertyId, 'master_lease', { contract_type: 'lease' })).status).toBe(400);
    expect((await create(propertyId, 'sublease', { contract_type: 'master_lease' })).status).toBe(400);
    expect(await counts()).toEqual({ cases: 0, contracts: 0 });
  });

  it('合約類型與案件種類相符：照案件種類建立', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    expect((await create(propertyId, 'lease', { contract_type: 'lease' })).status).toBe(201);
  });
});

describe('物件未核對：409 property_not_verified', () => {
  it.each(['unsubmitted', 'pending_verification', 'failed'] as const)('屋主組織，%s：拒絕且沒有建任何資料', async (stage) => {
    const propertyId = await createPropertyAt(kit, stage);
    expect(await snap(await create(propertyId, 'lease'))).toEqual(NOT_VERIFIED);
    expect(await counts()).toEqual({ cases: 0, contracts: 0 });
  });

  it('執業主體組織：同一個回應，不論案件種類', async () => {
    await seedPracticeOrg(kit, { orgId: kit.orgA });
    actAsOrg(kit.orgA, 'practice');
    const propertyId = await createPropertyAt(kit, 'pending_verification');
    for (const caseKind of ['lease', 'master_lease', 'sublease']) {
      expect(await snap(await create(propertyId, caseKind))).toEqual(NOT_VERIFIED);
    }
  });

  it('別的組織已核對同一物件，不影響這個組織的回應', async () => {
    actAsOrg(kit.orgB, 'owner');
    await createPropertyAt(kit, 'verified', { orgId: kit.orgB });
    actAs(kit.orgA);
    const mine = await createPropertyAt(kit, 'pending_verification');
    expect(await snap(await create(mine, 'lease'))).toEqual(NOT_VERIFIED);
  });
});

describe('組織種類與案件種類', () => {
  it('屋主組織建包租案件或轉租案件：409 host_org_not_allowed', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    for (const caseKind of ['master_lease', 'sublease']) {
      const res = await create(propertyId, caseKind);
      expect(res.status).toBe(409);
      expect((await json(res)).code).toBe('host_org_not_allowed');
    }
    expect(await counts()).toEqual({ cases: 0, contracts: 0 });
  });

  it('執業主體組織的業別沒有通過驗證：409 practice_entity_not_verified', async () => {
    await seedPracticeOrg(kit, { orgId: kit.orgA, licenses: { master_lease: 'pending' } });
    actAsOrg(kit.orgA, 'practice');
    const propertyId = await createPropertyAt(kit, 'verified');
    const res = await create(propertyId, 'master_lease');
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('practice_entity_not_verified');
    expect(await counts()).toEqual({ cases: 0, contracts: 0 });
  });

  it('沒有可簽章的專任管理人員：409 no_signable_manager', async () => {
    await seedPracticeOrg(kit, { orgId: kit.orgA, withManager: false });
    actAsOrg(kit.orgA, 'practice');
    const propertyId = await createPropertyAt(kit, 'verified');
    const res = await create(propertyId, 'master_lease');
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('no_signable_manager');
  });
});

describe('四種正常路徑', () => {
  it('屋主組織：租賃案件，業務類型自管，合約掛在案件下', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    const res = await create(propertyId, 'lease');
    expect(res.status).toBe(201);
    const body = (await json(res)).data;
    expect(body).toMatchObject({ case_kind: 'lease' });
    const [row] = await rows<{ kind: string; case_kind: string; business_type: string; current_contract_id: string; property_id: string; state: string }>(
      kit.orgA,
      'SELECT kind, case_kind, business_type, current_contract_id, property_id, state FROM org.cases WHERE id = $1',
      [body.case_id],
    );
    expect(row).toEqual({ kind: 'lease', case_kind: 'lease', business_type: 'self_managed', current_contract_id: body.id, property_id: propertyId, state: 'draft' });
    const [contract] = await rows<{ case_id: string; contract_type: string; fields: { routing: unknown } }>(
      kit.orgA,
      'SELECT case_id, contract_type, fields FROM org.contracts WHERE id = $1',
      [body.id],
    );
    expect(contract).toMatchObject({ case_id: body.case_id, contract_type: 'lease' });
    expect(contract.fields.routing).toEqual({ businessType: 'self_managed', lesseeIsMasterLessor: false, brokerMediated: false });
  });

  it('執業主體組織：包租案件，分流條件是承租人為包租業者', async () => {
    // 居間只限自己兼營經紀業（MIL-200）：有已驗證的經紀業別才能勾選居間
    await seedPracticeOrg(kit, { orgId: kit.orgA, licenses: { brokerage: 'verified' } });
    actAsOrg(kit.orgA, 'practice');
    const propertyId = await createPropertyAt(kit, 'verified');
    const res = await create(propertyId, 'master_lease', { routing: { brokerMediated: true } });
    expect(res.status).toBe(201);
    const body = (await json(res)).data;
    const [row] = await rows<{ case_kind: string; business_type: string; linked_master_lease_case_id: string | null }>(
      kit.orgA,
      'SELECT case_kind, business_type, linked_master_lease_case_id FROM org.cases WHERE id = $1',
      [body.case_id],
    );
    expect(row).toEqual({ case_kind: 'master_lease', business_type: 'self_managed', linked_master_lease_case_id: null });
    const [contract] = await rows<{ contract_type: string; fields: { routing: unknown; templateId?: string; templateVersion?: number } }>(
      kit.orgA,
      'SELECT contract_type, fields FROM org.contracts WHERE id = $1',
      [body.id],
    );
    // 包租案件建包租合約，綁包租範本（MIL-199）。合約的分流快照與案件的分流條件一致
    expect(contract.contract_type).toBe('master_lease');
    expect(contract.fields).toMatchObject({ templateId: 'master-lease-agreement', templateVersion: 1 });
    expect(contract.fields.routing).toEqual({ businessType: 'self_managed', lesseeIsMasterLessor: true, brokerMediated: true });
    expect(contract.fields.routing).toEqual(routingForNewCase('practice', 'master_lease', true));
  });

  it('執業主體組織：轉租案件掛在自家有效的包租案件底下', async () => {
    await seedPracticeOrg(kit, { orgId: kit.orgA });
    actAsOrg(kit.orgA, 'practice');
    const propertyId = await createPropertyAt(kit, 'verified');
    const master = (await json(await create(propertyId, 'master_lease'))).data;
    // 包租案件還是草稿時，轉租案件被拒
    expect((await create(propertyId, 'sublease')).status).toBe(409);
    await activateCase(kit, kit.orgA, master.case_id);

    const res = await create(propertyId, 'sublease');
    expect(res.status).toBe(201);
    const body = (await json(res)).data;
    const [row] = await rows<{ case_kind: string; business_type: string; linked_master_lease_case_id: string }>(
      kit.orgA,
      'SELECT case_kind, business_type, linked_master_lease_case_id FROM org.cases WHERE id = $1',
      [body.case_id],
    );
    expect(row).toEqual({ case_kind: 'sublease', business_type: 'master_lease', linked_master_lease_case_id: master.case_id });
    // 轉租案件建轉租合約，綁轉租範本（MIL-199）。合約的分流快照與案件的分流條件一致
    const [contract] = await rows<{ contract_type: string; fields: { routing: unknown; templateId?: string; templateVersion?: number } }>(
      kit.orgA,
      'SELECT contract_type, fields FROM org.contracts WHERE id = $1',
      [body.id],
    );
    expect(contract.contract_type).toBe('sublease');
    expect(contract.fields).toMatchObject({ templateId: 'sublease-agreement', templateVersion: 1 });
    expect(contract.fields.routing).toEqual({ businessType: 'master_lease', lesseeIsMasterLessor: false, brokerMediated: false });
    expect(contract.fields.routing).toEqual(routingForNewCase('practice', 'sublease', false));
  });

  it('執業主體組織：代管的租賃案件掛在自家有效的委託管理案件底下', async () => {
    await seedPracticeOrg(kit, { orgId: kit.orgA });
    actAsOrg(kit.orgA, 'practice');
    const propertyId = await createPropertyAt(kit, 'verified');
    // 沒有委託管理案件時拒絕
    const blocked = await create(propertyId, 'lease');
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).code).toBe('no_valid_mandate');
    const mandate = await seedMandateCase(kit, { orgId: kit.orgA, propertyId });

    const res = await create(propertyId, 'lease');
    expect(res.status).toBe(201);
    const body = (await json(res)).data;
    const [row] = await rows<{ case_kind: string; business_type: string; linked_mandate_case_id: string }>(
      kit.orgA,
      'SELECT case_kind, business_type, linked_mandate_case_id FROM org.cases WHERE id = $1',
      [body.case_id],
    );
    expect(row).toEqual({ case_kind: 'lease', business_type: 'managed', linked_mandate_case_id: mandate });
  });
});

describe('呼叫端不能偽造上層案件與分流旗標', () => {
  it('body 帶 lesseeIsMasterLessor 或上層案件的 ID：被忽略，案件種類只由 case_kind 決定', async () => {
    const propertyId = await createPropertyAt(kit, 'verified');
    const res = await create(propertyId, 'lease', {
      routing: { businessType: 'managed', lesseeIsMasterLessor: true, brokerMediated: false },
      linked_master_lease_case_id: newUlid(),
      linked_mandate_case_id: newUlid(),
    });
    expect(res.status).toBe(201);
    const body = (await json(res)).data;
    const [row] = await rows<{ case_kind: string; business_type: string; linked_master_lease_case_id: string | null; linked_mandate_case_id: string | null }>(
      kit.orgA,
      'SELECT case_kind, business_type, linked_master_lease_case_id, linked_mandate_case_id FROM org.cases WHERE id = $1',
      [body.case_id],
    );
    expect(row).toEqual({ case_kind: 'lease', business_type: 'self_managed', linked_master_lease_case_id: null, linked_mandate_case_id: null });
  });

  it('轉租案件：別的組織的包租案件與沒有包租案件，被拒的原因文字相同', async () => {
    await seedPracticeOrg(kit, { orgId: kit.orgA });
    actAsOrg(kit.orgA, 'practice');
    const propertyId = await createPropertyAt(kit, 'verified');
    const none = await snap(await create(propertyId, 'sublease'));
    expect(none.status).toBe(409);

    // B 在同一個租賃單位上有 active 的包租案件
    const [unit] = await rows<{ rental_unit_id: string }>(kit.orgA, 'SELECT rental_unit_id FROM org.properties WHERE id = $1', [propertyId]);
    await withTx({ kind: 'org', orgId: kit.orgB, partyId: TEST_PARTY_ID }, (tx) =>
      tx.query(
        `INSERT INTO org.cases (id, org_id, kind, state, business_type, case_kind, rental_unit_id, title)
         VALUES ($1, $2, 'lease', 'active', 'self_managed', 'master_lease', $3, '別組織的包租案件')`,
        [newUlid(), kit.orgB, unit.rental_unit_id],
      ),
    );
    expect(await snap(await create(propertyId, 'sublease'))).toEqual(none);
    expect(await counts()).toEqual({ cases: 0, contracts: 0 });
  });
});

describe('居間只限主辦組織自己兼營經紀業（MIL-200，ADR-0029 決議 3）', () => {
  const BLOCKED = { status: 409, body: JSON.stringify({ error: '這個組織不能勾選居間', code: 'broker_not_allowed' }) };

  it('屋主組織送 brokerMediated: true 被擋，什麼都不寫', async () => {
    actAsOrg(kit.orgA, 'owner');
    const propertyId = await createPropertyAt(kit, 'verified');
    expect(await snap(await create(propertyId, 'lease', { routing: { brokerMediated: true } }))).toEqual(BLOCKED);
    expect(await counts()).toEqual({ cases: 0, contracts: 0 });
  });

  it('屋主組織不送 brokerMediated 照常建立', async () => {
    actAsOrg(kit.orgA, 'owner');
    const propertyId = await createPropertyAt(kit, 'verified');
    expect((await create(propertyId, 'lease', { routing: { brokerMediated: false } })).status).toBe(201);
  });

  it('業者組織沒有登錄經紀業別：被擋，與屋主組織同一個回應', async () => {
    await seedPracticeOrg(kit, { orgId: kit.orgA });
    actAsOrg(kit.orgA, 'practice');
    const propertyId = await createPropertyAt(kit, 'verified');
    expect(await snap(await create(propertyId, 'master_lease', { routing: { brokerMediated: true } }))).toEqual(BLOCKED);
  });

  it('業者組織的經紀業別登錄了但還沒驗證：被擋', async () => {
    await seedPracticeOrg(kit, { orgId: kit.orgA, licenses: { brokerage: 'pending' } });
    actAsOrg(kit.orgA, 'practice');
    const propertyId = await createPropertyAt(kit, 'verified');
    expect(await snap(await create(propertyId, 'master_lease', { routing: { brokerMediated: true } }))).toEqual(BLOCKED);
    expect(await counts()).toEqual({ cases: 0, contracts: 0 });
  });

  it('只看自己組織的登錄：別的組織有已驗證的經紀業別，不影響這個組織', async () => {
    await seedPracticeOrg(kit, { orgId: kit.orgB, licenses: { brokerage: 'verified' }, withManager: false });
    await seedPracticeOrg(kit, { orgId: kit.orgA });
    actAsOrg(kit.orgA, 'practice');
    const propertyId = await createPropertyAt(kit, 'verified');
    expect(await snap(await create(propertyId, 'master_lease', { routing: { brokerMediated: true } }))).toEqual(BLOCKED);
  });
});
