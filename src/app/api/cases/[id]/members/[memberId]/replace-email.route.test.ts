import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeLogin, requestLoginCode, resolveRequestContext } from '@/lib/auth/login-flow';
import { findOrCreateParty, insertCaseMember } from '@/lib/case-store';
import { createMockMailer, type MockMailer } from '@/lib/mailer/mock-mailer';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsContext, setupRouteDb, TEST_PARTY_ID, TEST_USER_ID, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import { listTenantCases, loadSignedPdf, loadTenantCaseDetail } from '@/lib/tenant';
import { Forbidden } from '@/lib/authorize';
import { PATCH as replaceEmail } from './route';

// 更新承租人 email（MIL-121，P0-21 AC5）。連線是 PGlite 的 app_rw，RLS 生效。

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

let kit: RouteDb;
let mailer: MockMailer;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
  mailer = createMockMailer();
});

const PAST = new Date('2026-01-01T00:00:00.000Z');
const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ctx = (id: string, memberId: string) => ({ params: Promise.resolve({ id, memberId }) });
const req = (payload: unknown) => new NextRequest('http://localhost/api/cases', { method: 'PATCH', body: JSON.stringify(payload) });
const snap = async (res: Response) => ({ status: res.status, body: await res.text() });
const NOT_FOUND = { status: 404, body: JSON.stringify({ error: '案件不存在' }) };

async function seedCase(state = 'active') {
  const caseId = newUlid();
  await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
    await tx.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'route-test@example.com', '測試帳號') ON CONFLICT DO NOTHING`, [TEST_PARTY_ID]);
    await tx.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', $3, 'self_managed', '測試案件')`, [caseId, kit.orgA, state]);
  });
  return caseId;
}

async function addMember(caseId: string, relation: 'lessor' | 'lessee' | 'co_lessee', email: string, name: string) {
  return withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
    const partyId = await findOrCreateParty(tx, email, name);
    await insertCaseMember(tx, caseId, { partyId, relation }, PAST);
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM org.case_members WHERE case_id = $1 AND party_id = $2', [caseId, partyId]);
    return { partyId, memberId: rows[0].id };
  });
}

const membersOf = (caseId: string) =>
  withTx({ kind: 'org', orgId: kit.orgA }, async (tx) =>
    (
      await tx.query<{ relation: string; email: string; active: boolean }>(
        `SELECT m.relation, p.email, upper_inf(m.valid_period) AS active FROM org.case_members m JOIN control.parties p ON p.id = m.party_id
          WHERE m.case_id = $1 ORDER BY m.id`,
        [caseId],
      )
    ).rows,
  );

const asParty = (partyId: string) => ({ kind: 'party' as const, userId: TEST_USER_ID, partyId, requestId: 't' });

describe('PATCH /api/cases/[id]/members/[memberId]', () => {
  it('承租人換 email：舊列關閉不刪，新 email 加一列同關係的新成員，email 轉小寫', async () => {
    const caseId = await seedCase();
    const old = await addMember(caseId, 'lessee', 'old@example.com', '王租客');
    const res = await replaceEmail(req({ email: 'New@Example.com' }), ctx(caseId, old.memberId));
    expect(res.status).toBe(200);
    expect(await membersOf(caseId)).toEqual([
      { relation: 'lessee', email: 'old@example.com', active: false },
      { relation: 'lessee', email: 'new@example.com', active: true },
    ]);
    // control.parties 的 email 不改：舊 party 仍是舊 email，新 party 是另一個人
    const parties = await withTx({ kind: 'control' }, async (tx) => (await tx.query('SELECT email FROM control.parties')).rows.map((r) => (r as { email: string }).email));
    expect(parties).toEqual(expect.arrayContaining(['old@example.com', 'new@example.com']));
  });

  it('新 party 沿用舊成員的姓名；有填姓名時用新姓名', async () => {
    const caseId = await seedCase();
    const a = await addMember(caseId, 'lessee', 'a@example.com', '王租客');
    await replaceEmail(req({ email: 'a2@example.com' }), ctx(caseId, a.memberId));
    const b = await addMember(caseId, 'co_lessee', 'b@example.com', '李共同');
    await replaceEmail(req({ email: 'b2@example.com', name: '李新名' }), ctx(caseId, b.memberId));
    const names = await withTx({ kind: 'control' }, async (tx) =>
      (await tx.query<{ email: string; display_name: string }>(`SELECT email, display_name FROM control.parties WHERE email IN ('a2@example.com', 'b2@example.com') ORDER BY email`)).rows,
    );
    expect(names).toEqual([
      { email: 'a2@example.com', display_name: '王租客' },
      { email: 'b2@example.com', display_name: '李新名' },
    ]);
  });

  it('共同承租人也能更新，關係沿用 co_lessee', async () => {
    const caseId = await seedCase();
    const co = await addMember(caseId, 'co_lessee', 'co@example.com', '共同');
    expect((await replaceEmail(req({ email: 'co2@example.com' }), ctx(caseId, co.memberId))).status).toBe(200);
    expect((await membersOf(caseId)).filter((m) => m.active)).toEqual([{ relation: 'co_lessee', email: 'co2@example.com', active: true }]);
  });

  it('寫案件事件 member_replaced 與稽核事件 case_member.replace_email，payload 只有 ID（P0-21 AC5）', async () => {
    const caseId = await seedCase();
    const old = await addMember(caseId, 'lessee', 'old@example.com', '王租客');
    const res = await replaceEmail(req({ email: 'new@example.com' }), ctx(caseId, old.memberId));
    const newPartyId = (await json(res)).data.partyId as string;

    const events = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) =>
      (await tx.query<{ type: string; payload: Record<string, unknown>; actor_party_id: string | null }>(`SELECT type, payload, actor_party_id FROM org.case_events WHERE case_id = $1`, [caseId])).rows,
    );
    expect(events).toEqual([{ type: 'member_replaced', payload: { relation: 'lessee', fromPartyId: old.partyId, toPartyId: newPartyId }, actor_party_id: TEST_PARTY_ID }]);
    expect(JSON.stringify(events)).not.toContain('@example.com');

    const audit = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) =>
      (await tx.query<{ action: string; payload: Record<string, unknown> }>(`SELECT action, payload FROM audit.events WHERE action = 'case_member.replace_email'`)).rows,
    );
    expect(audit).toEqual([{ action: 'case_member.replace_email', payload: { relation: 'lessee', from_party_id: old.partyId, to_party_id: newPartyId } }]);
  });

  it('舊 email 立即失效：讀不到案件與下載，新 email 看得到', async () => {
    const caseId = await seedCase();
    await addMember(caseId, 'lessor', 'lessor@example.com', '出租人');
    const old = await addMember(caseId, 'lessee', 'old@example.com', '王租客');
    const res = await replaceEmail(req({ email: 'new@example.com' }), ctx(caseId, old.memberId));
    const newPartyId = (await json(res)).data.partyId as string;

    expect(await listTenantCases(asParty(old.partyId))).toEqual([]);
    await expect(loadTenantCaseDetail(asParty(old.partyId), caseId)).rejects.toBeInstanceOf(Forbidden);
    await expect(loadSignedPdf(asParty(old.partyId), caseId, { read: async () => null } as never)).rejects.toBeInstanceOf(Forbidden);
    expect((await listTenantCases(asParty(newPartyId))).map((c) => c.id)).toEqual([caseId]);
    expect((await loadTenantCaseDetail(asParty(newPartyId), caseId)).relation).toBe('lessee');
  });

  it('舊 email 已登入的 session，下一個請求就失效；新 email 登入後有承租人身分', async () => {
    const caseId = await seedCase();
    const old = await addMember(caseId, 'lessee', 'old@example.com', '王租客');
    const T0 = new Date('2026-11-09T10:00:00Z');
    const deps = (ms = 0) => ({ now: new Date(T0.getTime() + ms), secret: 'test-secret', mailer, env: {} });
    const code = () => mailer.sent.at(-1)!.text.match(/\d{6}/)![0];

    await requestLoginCode('old@example.com', deps());
    const oldLogin = await completeLogin('old@example.com', code(), deps());
    if (oldLogin.status !== 'ok') throw new Error('登入失敗');
    expect(oldLogin.identity).toEqual({ kind: 'party' });
    expect(await resolveRequestContext(oldLogin.token, deps(1000).now, 'r1')).toMatchObject({ kind: 'party' });

    // 出租人更新 email（org 脈絡的請求）
    actAs(kit.orgA);
    expect((await replaceEmail(req({ email: 'new@example.com' }), ctx(caseId, old.memberId))).status).toBe(200);

    await expect(resolveRequestContext(oldLogin.token, deps(2000).now, 'r2')).rejects.toMatchObject({ reason: 'membership_lost' });

    await requestLoginCode('new@example.com', deps(3000));
    const newLogin = await completeLogin('new@example.com', code(), deps(3000));
    if (newLogin.status !== 'ok') throw new Error('登入失敗');
    expect(newLogin.identity).toEqual({ kind: 'party' });
    expect(newLogin.landing).toBe('/tenant');
    // 舊 email 再登入：沒有任何身分
    await requestLoginCode('old@example.com', deps(70_000));
    const again = await completeLogin('old@example.com', code(), deps(70_000));
    if (again.status !== 'ok') throw new Error('登入失敗');
    expect(again.identity).toBeNull();
  });

  it('新 email 已是同案件的有效成員：409，不建重複列', async () => {
    const caseId = await seedCase();
    const a = await addMember(caseId, 'lessee', 'a@example.com', 'A');
    await addMember(caseId, 'co_lessee', 'b@example.com', 'B');
    const res = await replaceEmail(req({ email: 'b@example.com' }), ctx(caseId, a.memberId));
    expect(res.status).toBe(409);
    expect((await json(res)).error).toContain('已經是案件的有效成員');
    expect((await membersOf(caseId)).filter((m) => m.active)).toHaveLength(2);
  });

  it('新 email 與目前相同、成員不存在、不是承租人關係、舊列已結束：不改任何資料', async () => {
    const caseId = await seedCase();
    const lessor = await addMember(caseId, 'lessor', 'lessor@example.com', '出租人');
    const a = await addMember(caseId, 'lessee', 'a@example.com', 'A');
    expect((await replaceEmail(req({ email: 'A@example.com' }), ctx(caseId, a.memberId))).status).toBe(409);
    expect((await replaceEmail(req({ email: 'x@example.com' }), ctx(caseId, newUlid()))).status).toBe(404);
    expect((await replaceEmail(req({ email: 'x@example.com' }), ctx(caseId, lessor.memberId))).status).toBe(409);
    await replaceEmail(req({ email: 'a2@example.com' }), ctx(caseId, a.memberId));
    expect((await replaceEmail(req({ email: 'a3@example.com' }), ctx(caseId, a.memberId))).status).toBe(409);
    expect((await membersOf(caseId)).filter((m) => m.relation === 'lessee')).toEqual([
      { relation: 'lessee', email: 'a@example.com', active: false },
      { relation: 'lessee', email: 'a2@example.com', active: true },
    ]);
  });

  it('email 格式不符 400', async () => {
    const caseId = await seedCase();
    const a = await addMember(caseId, 'lessee', 'a@example.com', 'A');
    expect((await replaceEmail(req({ email: 'bad' }), ctx(caseId, a.memberId))).status).toBe(400);
    expect((await replaceEmail(req({}), ctx(caseId, a.memberId))).status).toBe(400);
  });

  it('viewer、別的組織、不存在的案件被拒，回應與案件不存在相同；結案後也被拒', async () => {
    const caseId = await seedCase();
    const a = await addMember(caseId, 'lessee', 'a@example.com', 'A');
    actAsContext({ kind: 'org', orgId: kit.orgA, orgKind: 'owner', userId: TEST_USER_ID, partyId: TEST_PARTY_ID, role: 'viewer', requestId: 't' });
    expect(await snap(await replaceEmail(req({ email: 'x@example.com' }), ctx(caseId, a.memberId)))).toEqual(NOT_FOUND);
    actAs(kit.orgB);
    expect(await snap(await replaceEmail(req({ email: 'x@example.com' }), ctx(caseId, a.memberId)))).toEqual(NOT_FOUND);
    actAs(kit.orgA);
    expect(await snap(await replaceEmail(req({ email: 'x@example.com' }), ctx(newUlid(), a.memberId)))).toEqual(NOT_FOUND);
    await withTx({ kind: 'org', orgId: kit.orgA }, (tx) => tx.query(`UPDATE org.cases SET state = 'closed' WHERE id = $1`, [caseId]));
    expect(await snap(await replaceEmail(req({ email: 'x@example.com' }), ctx(caseId, a.memberId)))).toEqual(NOT_FOUND);
  });
});
