import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '@/lib/auth/config';
import { resolveRequestContext } from '@/lib/auth/login-flow';
import { setMailer } from '@/lib/mailer';
import { createMockMailer, type MockMailer } from '@/lib/mailer/mock-mailer';
import { actAsContext, setupRouteDb, type RouteDb } from '@/lib/pg/route-test-kit';
import { POST as identityRoute } from '../auth/identity/route';
import { GET as identitiesRoute } from '../auth/identities/route';
import { POST as otpRoute } from '../auth/otp/route';
import { POST as verifyRoute } from '../auth/verify/route';
import { POST as ownerOnboarding } from '../onboarding/owner/route';
import { POST as practiceOnboarding } from '../onboarding/practice/route';
import { DELETE as cancelInvitationRoute } from './invitations/[id]/route';
import { DELETE as removeMemberRoute, PATCH as patchMemberRoute } from './members/[userId]/route';
import { GET as listMembersRoute, POST as inviteRoute } from './members/route';

// MIL-106：建組織、邀請、成員管理、身分切換的 route 層。連線是 PGlite 的 app_rw。
// 成員管理 route 用 requestContext()，這裡換成 stub，脈絡取自真實的 session（resolveRequestContext）。

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
  mailer = createMockMailer();
  setMailer(mailer);
  vi.stubEnv('PLATFORM_OPERATOR_EMAILS', 'ops@example.com');
});
afterEach(() => {
  setMailer(undefined);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (route: (r: Request) => Promise<Response>, method: string, url: string, body?: unknown, token?: string) =>
  route(
    new Request(`http://localhost${url}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
    }),
  );
// 路徑參數的 route：第二個參數是 { params }
const callWithParams = <P extends Record<string, string>>(
  route: (r: never, ctx: { params: Promise<P> }) => Promise<Response>,
  method: string,
  params: P,
  body?: unknown,
) =>
  route(new Request('http://localhost/x', { method, body: body === undefined ? undefined : JSON.stringify(body) }) as never, {
    params: Promise.resolve(params),
  });

let tick = 0;
/** 走完整個登入流程（寄碼、驗證），回傳 session token 與 verify 回應。 */
async function login(email: string) {
  // 每次登入往後走 2 分鐘，避開每分鐘 1 次的限制
  tick += 1;
  vi.useFakeTimers({ now: Date.now() + tick * 120_000, toFake: ['Date'] });
  expect((await call(otpRoute, 'POST', '/api/auth/otp', { email })).status).toBe(200);
  const code = mailer.sent.at(-1)!.text.match(/\d{6}/)![0];
  const res = await call(verifyRoute, 'POST', '/api/auth/verify', { email, code });
  expect(res.status).toBe(200);
  const token = res.headers.get('set-cookie')!.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))![1];
  return { token, body: await json(res) };
}

/** 之後的 requestContext() 回傳這個 session 的脈絡。 */
async function actAsSession(token: string) {
  actAsContext(await resolveRequestContext(token, new Date(), 'test'));
}

async function ownerAdmin(email = 'admin@example.com') {
  const { token } = await login(email);
  const res = await call(ownerOnboarding, 'POST', '/api/onboarding/owner', { name: '屋主組織' }, token);
  expect(res.status).toBe(200);
  await actAsSession(token);
  return token;
}

describe('登入落地', () => {
  it('沒有身分的帳號登入後導向建組織；平台營運者落工作台；屋主建完組織落 /owner', async () => {
    const fresh = await login('new@example.com');
    expect(fresh.body.data.redirectTo).toBe('/login?notice=no-identity');
    expect((await login('ops@example.com')).body.data.redirectTo).toBe('/');

    const built = await call(ownerOnboarding, 'POST', '/api/onboarding/owner', { name: '我的屋主組織' }, fresh.token);
    expect(await json(built)).toEqual({ data: { redirectTo: '/owner' } });
    expect((await login('new@example.com')).body.data.redirectTo).toBe('/owner');
  });
});

describe('POST /api/onboarding/owner', () => {
  it('沒有登入回 401；本文不是 JSON 回 400；名稱空白回 400 並指出欄位', async () => {
    expect((await call(ownerOnboarding, 'POST', '/api/onboarding/owner', { name: 'x' })).status).toBe(401);
    const { token } = await login('new@example.com');
    expect((await ownerOnboarding(new Request('http://localhost/x', { method: 'POST', body: 'x', headers: { cookie: `${SESSION_COOKIE}=${token}` } }))).status).toBe(400);
    const res = await call(ownerOnboarding, 'POST', '/api/onboarding/owner', { name: ' ' }, token);
    expect(res.status).toBe(400);
    expect((await json(res)).field).toBe('name');
  });

  it('已經有身分的帳號回 409', async () => {
    const { token } = await login('ops@example.com');
    expect((await call(ownerOnboarding, 'POST', '/api/onboarding/owner', { name: 'x' }, token)).status).toBe(409);
  });
});

const practice = (over: Record<string, unknown> = {}) => ({
  name: '安心代管有限公司',
  taxId: '12345678',
  entityType: 'company',
  kinds: ['management'],
  ...over,
});

describe('POST /api/onboarding/practice', () => {
  it('個體商號選代管被拒：400，指出 kinds 與 company_required，說明租賃線限公司', async () => {
    const { token } = await login('mgr@example.com');
    const res = await call(practiceOnboarding, 'POST', '/api/onboarding/practice', practice({ entityType: 'firm' }), token);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ field: 'kinds', code: 'company_required', error: expect.stringContaining('公司') });
  });

  it('登錄成功落工作台；第二個組織認領同一統編，回應逐位元相同', async () => {
    const first = await login('first@example.com');
    const second = await login('second@example.com');
    const r1 = await call(practiceOnboarding, 'POST', '/api/onboarding/practice', practice(), first.token);
    const r2 = await call(practiceOnboarding, 'POST', '/api/onboarding/practice', practice({ name: '別家公司' }), second.token);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(r1.status);
    expect(await r2.text()).toBe(await r1.text());
    expect(await kit.asOwner(async (db) => (await db.query('SELECT 1 FROM registry.practice_entities')).rows.length)).toBe(1);
    expect(await kit.asOwner(async (db) => (await db.query("SELECT 1 FROM registry.review_items WHERE type = 'entity_claim'")).rows.length)).toBe(1);
  });
});

describe('身分切換 route', () => {
  it('GET /api/auth/identities：沒有登入 401；列出真的有的身分，不含承租人', async () => {
    expect((await call(identitiesRoute, 'GET', '/api/auth/identities')).status).toBe(401);
    const token = await ownerAdmin();
    const body = await json(await call(identitiesRoute, 'GET', '/api/auth/identities', undefined, token));
    expect(body.data.options).toHaveLength(1);
    expect(body.data.options[0]).toMatchObject({ kind: 'owner', label: '屋主組織' });
    expect(body.data.current).toMatchObject({ kind: 'owner' });
  });

  it('POST /api/auth/identity：切到有的身分回落地頁；沒有的身分 404', async () => {
    const adminToken = await ownerAdmin();
    const admin = await resolveRequestContext(adminToken, new Date(), 't');
    await call(inviteRoute, 'POST', '/api/org/members', { email: 'ops@example.com', role: 'viewer' });
    const ops = await login('ops@example.com'); // 營運者，同時被邀請進屋主組織
    const list = await json(await call(identitiesRoute, 'GET', '/api/auth/identities', undefined, ops.token));
    expect(list.data.options.map((o: { label: string }) => o.label)).toEqual(['屋主組織', '平台營運者']);

    expect(await json(await call(identityRoute, 'POST', '/api/auth/identity', { kind: 'org', orgId: (admin as { orgId: string }).orgId }, ops.token))).toEqual({ data: { redirectTo: '/owner' } });
    expect(await json(await call(identityRoute, 'POST', '/api/auth/identity', { kind: 'operator' }, ops.token))).toEqual({ data: { redirectTo: '/' } });
    expect((await call(identityRoute, 'POST', '/api/auth/identity', { kind: 'party' }, ops.token)).status).toBe(404);
    expect((await call(identityRoute, 'POST', '/api/auth/identity', { kind: 'operator' })).status).toBe(401);
  });
});

describe('成員管理 route', () => {
  it('平台營運者身分回 403（成員管理只給組織身分）', async () => {
    const { token } = await login('ops@example.com');
    actAsContext(await resolveRequestContext(token, new Date(), 't')); // operator
    expect((await call(listMembersRoute , 'GET', '/api/org/members')).status).toBe(403);
  });

  it('邀請：201，寄出邀請信；被邀請者登入後出現在成員列表', async () => {
    const adminToken = await ownerAdmin();
    const res = await call(inviteRoute, 'POST', '/api/org/members', { email: 'Staff@Example.com', role: 'staff' });
    expect(res.status).toBe(201);
    expect((await json(res)).data.mailed).toBe(true);
    expect(mailer.sent.at(-1)).toMatchObject({ to: 'staff@example.com', kind: 'org.invite' });

    await login('staff@example.com');
    await actAsSession(adminToken);
    const list = await json(await call(listMembersRoute , 'GET', '/api/org/members'));
    expect(list.data.members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([
      ['admin@example.com', 'admin'],
      ['staff@example.com', 'staff'],
    ]);
  });

  it('邀請信寄不出去：邀請仍然成立，回應標示 mailed: false', async () => {
    await ownerAdmin();
    mailer.failNext(new Error('smtp down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await call(inviteRoute, 'POST', '/api/org/members', { email: 'staff@example.com', role: 'staff' });
    expect(res.status).toBe(201);
    expect((await json(res)).data.mailed).toBe(false);
    const list = await json(await call(listMembersRoute , 'GET', '/api/org/members'));
    expect(list.data.invitations).toHaveLength(1);
  });

  it('邀請的錯誤：格式、角色、已是成員、重複，各有對應狀態碼', async () => {
    await ownerAdmin();
    const invite = (body: unknown) => call(inviteRoute, 'POST', '/api/org/members', body);
    expect((await invite({ email: 'bad', role: 'staff' })).status).toBe(400);
    expect((await invite({ email: 'a@example.com', role: 'boss' })).status).toBe(400);
    expect((await invite({ email: 'admin@example.com', role: 'staff' })).status).toBe(409);
    expect((await invite({ email: 'a@example.com', role: 'staff' })).status).toBe(201);
    expect((await invite({ email: 'a@example.com', role: 'staff' })).status).toBe(409);
  });

  it('staff 邀請、改角色、移除、撤銷都回 403', async () => {
    const adminToken = await ownerAdmin();
    await call(inviteRoute, 'POST', '/api/org/members', { email: 'staff@example.com', role: 'staff' });
    const staff = await login('staff@example.com');
    await actAsSession(staff.token);
    const admin = await resolveRequestContext(adminToken, new Date(), 't');
    expect((await call(inviteRoute, 'POST', '/api/org/members', { email: 'x@example.com', role: 'staff' })).status).toBe(403);
    expect((await callWithParams(patchMemberRoute , 'PATCH', { userId: admin.userId }, { role: 'viewer' })).status).toBe(403);
    expect((await callWithParams(removeMemberRoute , 'DELETE', { userId: admin.userId })).status).toBe(403);
    expect((await callWithParams(cancelInvitationRoute , 'DELETE', { id: '0000000000000000000000000Z' })).status).toBe(403);
  });

  it('改角色、移除成員：移除後對方的下一個請求被拒', async () => {
    const adminToken = await ownerAdmin();
    await call(inviteRoute, 'POST', '/api/org/members', { email: 'staff@example.com', role: 'staff' });
    const staff = await login('staff@example.com');
    const staffCtx = await resolveRequestContext(staff.token, new Date(), 't');

    await actAsSession(adminToken);
    const patched = await callWithParams(patchMemberRoute , 'PATCH', { userId: staffCtx.userId }, { role: 'viewer' });
    expect(patched.status).toBe(200);
    expect(await resolveRequestContext(staff.token, new Date(), 't')).toMatchObject({ role: 'viewer' });
    expect((await callWithParams(patchMemberRoute , 'PATCH', { userId: staffCtx.userId }, { role: 'boss' })).status).toBe(400);

    const removed = await callWithParams(removeMemberRoute , 'DELETE', { userId: staffCtx.userId });
    expect(removed.status).toBe(200);
    await expect(resolveRequestContext(staff.token, new Date(), 't')).rejects.toMatchObject({ name: 'Unauthenticated' });
    expect((await callWithParams(removeMemberRoute , 'DELETE', { userId: staffCtx.userId })).status).toBe(404);
  });

  it('最後一位 admin 不能被移除或降級：409', async () => {
    const adminToken = await ownerAdmin();
    const admin = await resolveRequestContext(adminToken, new Date(), 't');
    expect((await callWithParams(removeMemberRoute , 'DELETE', { userId: admin.userId })).status).toBe(409);
    expect((await callWithParams(patchMemberRoute , 'PATCH', { userId: admin.userId }, { role: 'staff' })).status).toBe(409);
  });

  it('格式錯誤的 ID 與不存在的成員，回應相同（404）', async () => {
    await ownerAdmin();
    const bad = await callWithParams(removeMemberRoute , 'DELETE', { userId: 'nope' });
    const missing = await callWithParams(removeMemberRoute , 'DELETE', { userId: '0000000000000000000000000Z' });
    expect(bad.status).toBe(404);
    expect(await bad.text()).toBe(await missing.text());
  });

  it('撤銷邀請：撤銷後該 email 登入不再成為成員', async () => {
    await ownerAdmin();
    await call(inviteRoute, 'POST', '/api/org/members', { email: 'late@example.com', role: 'staff' });
    const list = await json(await call(listMembersRoute , 'GET', '/api/org/members'));
    const id = list.data.invitations[0].id;
    expect((await callWithParams(cancelInvitationRoute , 'DELETE', { id })).status).toBe(200);
    expect((await callWithParams(cancelInvitationRoute , 'DELETE', { id })).status).toBe(404);
    expect((await login('late@example.com')).body.data.redirectTo).toBe('/login?notice=no-identity');
  });
});
