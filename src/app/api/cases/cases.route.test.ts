import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachContract, findOrCreateParty, insertCaseMember } from '@/lib/case-store';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsContext, setupRouteDb, TEST_PARTY_ID, TEST_USER_ID, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import type { OrgRole } from '@/lib/request-context';
import { GET as getList } from './route';
import { GET as getOne } from './[id]/route';
import { POST as addMember } from './[id]/members/route';

// 案件清單、詳情與加入共同承租人的 route（MIL-115）。連線是 PGlite 的 app_rw，RLS 生效。

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

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
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, payload?: unknown) =>
  new NextRequest('http://localhost/api/cases', { method, body: payload === undefined ? undefined : JSON.stringify(payload) });
const snap = async (res: Response) => ({ status: res.status, body: await res.text() });
const NOT_FOUND = { status: 404, body: JSON.stringify({ error: '案件不存在' }) };
const PAST = new Date('2026-01-01T00:00:00.000Z');

/** 直接寫案件（不經 createLeaseCase 的物件檢查）：測試只關心案件、成員與清單的讀取。 */
async function insertPlainCase(orgId: string, title: string, businessType = 'self_managed'): Promise<string> {
  const caseId = newUlid();
  await withTx({ kind: 'org', orgId }, async (tx) => {
    await tx.query(
      `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, lease_start, lease_end, monthly_rent)
       VALUES ($1, $2, 'lease', 'active', $4, $3, '2026-01-01', '2026-12-31', 20000)`,
      [caseId, orgId, title, businessType],
    );
    await tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'route-test@example.com', '測試帳號') ON CONFLICT DO NOTHING`, [TEST_PARTY_ID]);
  });
  return caseId;
}

async function addMemberRow(orgId: string, caseId: string, relation: 'lessor' | 'lessee' | 'owner', email: string, name: string) {
  return withTx({ kind: 'org', orgId }, async (tx) => {
    const partyId = await findOrCreateParty(tx, email, name);
    await insertCaseMember(tx, caseId, { partyId, relation }, PAST);
    return partyId;
  });
}

const asOrg = (orgId: string, partyId: string, role: OrgRole = 'admin') =>
  actAsContext({ kind: 'org', orgId, orgKind: 'owner', userId: TEST_USER_ID, partyId, role, requestId: 't' });

describe('GET /api/cases', () => {
  it('列出主辦組織的案件，新的在前，帶承租人名稱與目前合約狀態', async () => {
    const older = await insertPlainCase(kit.orgA, '舊案件');
    const newer = await insertPlainCase(kit.orgA, '新案件');
    await addMemberRow(kit.orgA, newer, 'lessee', 'tenant@example.com', '王租客');
    const res = await getList();
    expect(res.status).toBe(200);
    const rows = (await json(res)).data;
    expect(rows.map((r: { id: string }) => r.id)).toEqual([newer, older]);
    expect(rows[0]).toMatchObject({ title: '新案件', state: 'active', isHost: true, lesseeNames: '王租客', contractStatus: null, leaseEnd: '2026-12-31', monthlyRent: 20000, orgName: 'A 組織' });
    expect(rows[1].lesseeNames).toBeNull();
  });

  it('別的組織的案件不在清單裡；沒有案件時是空陣列', async () => {
    await insertPlainCase(kit.orgB, 'B 的案件');
    expect((await json(await getList())).data).toEqual([]);
  });

  it('屋主是別組織案件的 lessor：清單看得到，isHost 是 false', async () => {
    const caseId = await insertPlainCase(kit.orgA, '代管案件');
    const lessor = await addMemberRow(kit.orgA, caseId, 'lessor', 'owner@example.com', '陳屋主');
    asOrg(kit.orgB, lessor);
    const rows = (await json(await getList())).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: caseId, isHost: false, orgName: 'A 組織' });
  });

  it('只是 owner 關係：清單看得到案件與租期，看不到承租人名稱', async () => {
    const caseId = await insertPlainCase(kit.orgA, '包租案件', 'master_lease');
    await addMemberRow(kit.orgA, caseId, 'lessee', 'tenant2@example.com', '承租人二');
    const owner = await addMemberRow(kit.orgA, caseId, 'owner', 'ownerrel@example.com', '所有權人');
    asOrg(kit.orgB, owner);
    const rows = (await json(await getList())).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ leaseEnd: '2026-12-31', monthlyRent: 20000, lesseeNames: null });
  });

  it('viewer 讀得到清單', async () => {
    await insertPlainCase(kit.orgA, '案件');
    asOrg(kit.orgA, TEST_PARTY_ID, 'viewer');
    expect((await getList()).status).toBe(200);
  });
});

describe('案件種類（MIL-195，ADR-0030）', () => {
  async function insertKinded(orgId: string, title: string, kind: string, businessType: string | null, caseKind: string, linked: string | null = null) {
    const caseId = newUlid();
    await withTx({ kind: 'org', orgId }, async (tx) => {
      await tx.query(
        `INSERT INTO org.cases (id, org_id, kind, state, business_type, title, case_kind, linked_master_lease_case_id)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, $7)`,
        [caseId, orgId, kind, businessType, title, caseKind, linked],
      );
    });
    return caseId;
  }

  it('清單每一列帶案件種類，四種都有', async () => {
    await insertKinded(kit.orgA, '租賃', 'lease', 'self_managed', 'lease');
    await insertKinded(kit.orgA, '委託管理', 'management', null, 'management');
    await insertKinded(kit.orgA, '包租', 'lease', 'self_managed', 'master_lease');
    await insertKinded(kit.orgA, '轉租', 'lease', 'master_lease', 'sublease');
    const rows = (await json(await getList())).data as { title: string; caseKind: string }[];
    expect(Object.fromEntries(rows.map((r) => [r.title, r.caseKind]))).toEqual({
      租賃: 'lease',
      委託管理: 'management',
      包租: 'master_lease',
      轉租: 'sublease',
    });
  });

  it('不經案件種類欄位寫入的舊資料（業務類型 master_lease）讀成轉租案件', async () => {
    await insertPlainCase(kit.orgA, '舊轉租', 'master_lease');
    const rows = (await json(await getList())).data as { caseKind: string; businessType: string }[];
    expect(rows[0]).toMatchObject({ caseKind: 'sublease', businessType: 'master_lease' });
  });

  it('詳情帶案件種類；主辦組織看得到轉租案件連到的包租案件', async () => {
    const master = await insertKinded(kit.orgA, '包租', 'lease', 'self_managed', 'master_lease');
    const sub = await insertKinded(kit.orgA, '轉租', 'lease', 'master_lease', 'sublease', master);
    const body = (await json(await getOne(req('GET'), ctx(sub)))).data;
    expect(body.case).toMatchObject({ caseKind: 'sublease', linkedMasterLeaseCaseId: master });
  });

  it('別組織的成員讀轉租案件：看得到案件種類，看不到連到的包租案件', async () => {
    const master = await insertKinded(kit.orgA, '包租', 'lease', 'self_managed', 'master_lease');
    const sub = await insertKinded(kit.orgA, '轉租', 'lease', 'master_lease', 'sublease', master);
    const lessor = await addMemberRow(kit.orgA, sub, 'lessor', 'sub-lessor@example.com', '包租業者');
    asOrg(kit.orgB, lessor);
    const body = (await json(await getOne(req('GET'), ctx(sub)))).data;
    expect(body.isHost).toBe(false);
    expect(body.case.caseKind).toBe('sublease');
    expect(body.case).not.toHaveProperty('linkedMasterLeaseCaseId');
  });
});

describe('GET /api/cases/[id]', () => {
  it('主辦組織：案件、成員、合約、事件與是否可管理成員', async () => {
    const id = await insertPlainCase(kit.orgA, '詳情案件');
    await addMemberRow(kit.orgA, id, 'lessor', 'l@example.com', '出租人');
    const contractId = newUlid();
    await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
      await tx.query('INSERT INTO org.contracts (id, org_id, case_id) VALUES ($1, $2, $3)', [contractId, kit.orgA, id]);
      await attachContract(tx, id, contractId, { now: PAST });
    });
    const res = await getOne(req('GET'), ctx(id));
    expect(res.status).toBe(200);
    const body = (await json(res)).data;
    expect(body).toMatchObject({ isHost: true, orgName: 'A 組織', canManageMembers: true });
    expect(body.case).toMatchObject({ id, title: '詳情案件', currentContractId: contractId });
    expect(body.members.map((m: { relation: string }) => m.relation)).toEqual(['lessor']);
    expect(body.contracts).toEqual([expect.objectContaining({ id: contractId, isCurrent: true, status: 'draft' })]);
    expect(body.events.map((e: { type: string }) => e.type)).toEqual(['contract_attached']);
  });

  it('viewer 讀得到，但不能管理成員', async () => {
    const id = await insertPlainCase(kit.orgA, '案件');
    asOrg(kit.orgA, TEST_PARTY_ID, 'viewer');
    const body = (await json(await getOne(req('GET'), ctx(id)))).data;
    expect(body.canManageMembers).toBe(false);
  });

  it('lessor 以自己的組織身分讀別組織的案件（唯讀版本）：成員與事件讀得到，不能管理成員', async () => {
    const id = await insertPlainCase(kit.orgA, '代管案件');
    const lessor = await addMemberRow(kit.orgA, id, 'lessor', 'owner@example.com', '陳屋主');
    await addMemberRow(kit.orgA, id, 'lessee', 'tenant@example.com', '王租客');
    asOrg(kit.orgB, lessor);
    const body = (await json(await getOne(req('GET'), ctx(id)))).data;
    expect(body).toMatchObject({ isHost: false, canManageMembers: false, orgName: 'A 組織' });
    expect(body.members.map((m: { relation: string }) => m.relation).sort()).toEqual(['lessee', 'lessor']);
  });

  it('owner 關係只讀得到案件本身：成員、合約、事件都是空的（P0-09 AC5）', async () => {
    const id = await insertPlainCase(kit.orgA, '包租案件', 'master_lease');
    await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => tx.query('INSERT INTO org.contracts (id, org_id, case_id) VALUES ($1, $2, $3)', [newUlid(), kit.orgA, id]));
    const owner = await addMemberRow(kit.orgA, id, 'owner', 'ownerrel@example.com', '所有權人');
    asOrg(kit.orgB, owner);
    const body = (await json(await getOne(req('GET'), ctx(id)))).data;
    expect(body.case).toMatchObject({ leaseEnd: '2026-12-31', monthlyRent: 20000 });
    expect(body.contracts).toEqual([]);
    expect(body.events).toEqual([]);
    // 自己的成員列讀得到（self_read），別人的讀不到
    expect(body.members.map((m: { relation: string }) => m.relation)).toEqual(['owner']);
  });

  it('別的組織、不是成員、不存在、格式錯誤的 ID，回應逐位元相同', async () => {
    const id = await insertPlainCase(kit.orgA, '案件');
    asOrg(kit.orgB, newUlid());
    const results = [await snap(await getOne(req('GET'), ctx(id))), await snap(await getOne(req('GET'), ctx(newUlid()))), await snap(await getOne(req('GET'), ctx('not-a-ulid')))];
    for (const r of results) expect(r).toEqual(NOT_FOUND);
  });
});

describe('POST /api/cases/[id]/members', () => {
  const body = { email: 'Co@Example.com', name: '共同承租人' };

  it('出租人加入共同承租人：201，成員與事件都有', async () => {
    const id = await insertPlainCase(kit.orgA, '案件');
    const res = await addMember(req('POST', body), ctx(id));
    expect(res.status).toBe(201);
    const detail = (await json(await getOne(req('GET'), ctx(id)))).data;
    expect(detail.members).toEqual([expect.objectContaining({ relation: 'co_lessee', email: 'co@example.com', displayName: '共同承租人' })]);
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(['member_added']);
  });

  it('重複加入 409；email 格式不符或沒填姓名 400', async () => {
    const id = await insertPlainCase(kit.orgA, '案件');
    await addMember(req('POST', body), ctx(id));
    expect((await addMember(req('POST', body), ctx(id))).status).toBe(409);
    expect((await addMember(req('POST', { email: 'bad', name: 'x' }), ctx(id))).status).toBe(400);
    expect((await addMember(req('POST', { email: 'ok@example.com', name: ' ' }), ctx(id))).status).toBe(400);
  });

  it('viewer 被拒（與不存在同一個回應）；別的組織也一樣', async () => {
    const id = await insertPlainCase(kit.orgA, '案件');
    asOrg(kit.orgA, TEST_PARTY_ID, 'viewer');
    expect(await snap(await addMember(req('POST', body), ctx(id)))).toEqual(NOT_FOUND);
    asOrg(kit.orgB, newUlid());
    expect(await snap(await addMember(req('POST', body), ctx(id)))).toEqual(NOT_FOUND);
  });

  it('lessor 不屬於主辦組織時不能管理成員', async () => {
    const id = await insertPlainCase(kit.orgA, '案件');
    const lessor = await addMemberRow(kit.orgA, id, 'lessor', 'owner@example.com', '陳屋主');
    asOrg(kit.orgB, lessor);
    expect(await snap(await addMember(req('POST', body), ctx(id)))).toEqual(NOT_FOUND);
  });

  it('結案後不能再加成員', async () => {
    const id = await insertPlainCase(kit.orgA, '案件');
    await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => tx.query(`UPDATE org.cases SET state = 'closed' WHERE id = $1`, [id]));
    expect(await snap(await addMember(req('POST', body), ctx(id)))).toEqual(NOT_FOUND);
  });
});
