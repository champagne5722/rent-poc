import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from './auth/config';
import { completeLogin, requestLoginCode } from './auth/login-flow';
import { whoAmI } from './auth/whoami';
import { createMockMailer } from './mailer/mock-mailer';
import { setupRouteDb, type RouteDb } from './pg/route-test-kit';
import { Unauthenticated } from './request-context';

// requestContext() 與 currentOwnerSession() 讀真實的 session（MIL-103）。
// 只有 next/headers 的 cookie 用假的：vitest 沒有請求範圍。

const cookieStore = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'rp_session' && cookieStore.value !== undefined ? { name, value: cookieStore.value } : undefined),
  }),
}));
vi.mock('next/server', () => ({ connection: async () => undefined }));

const { requestContext } = await import('./current-request-context');
const { currentOwnerSession } = await import('./current-owner-session');

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  cookieStore.value = undefined;
});
afterEach(() => vi.unstubAllEnvs());

async function loginAs(email: string, env: Record<string, string>, offsetMs = 0): Promise<string> {
  const mailer = createMockMailer();
  const deps = { now: new Date(Date.now() + offsetMs), secret: 'test-secret', mailer, env };
  await requestLoginCode(email, deps);
  const result = await completeLogin(email, mailer.sent[0].text.match(/\d{6}/)![0], deps);
  if (result.status !== 'ok') throw new Error('登入失敗');
  return result.token;
}

describe('requestContext()', () => {
  it('沒有 cookie：丟 Unauthenticated', async () => {
    await expect(requestContext()).rejects.toBeInstanceOf(Unauthenticated);
  });

  it('cookie 的 token 查不到 session：丟 Unauthenticated', async () => {
    cookieStore.value = 'forged-token';
    await expect(requestContext()).rejects.toMatchObject({ name: 'Unauthenticated', reason: 'no_session' });
  });

  it('有效的 session：回傳 org 脈絡，形狀照 ADR-0022 決議 7', async () => {
    cookieStore.value = await loginAs('owner@example.com', { SEED_OWNER_EMAIL: 'owner@example.com' });
    const rc = await requestContext();
    expect(rc).toMatchObject({ kind: 'org', orgKind: 'owner', role: 'admin' });
    if (rc.kind !== 'org') throw new Error('應為 org');
    expect(Object.keys(rc).sort()).toEqual(['kind', 'orgId', 'orgKind', 'partyId', 'requestId', 'role', 'userId']);
  });

  it('環境變數 DEFAULT_ORG_ID 不再有作用：沒有 session 就是沒有登入', async () => {
    vi.stubEnv('DEFAULT_ORG_ID', '00000000000000000000000002');
    await expect(requestContext()).rejects.toBeInstanceOf(Unauthenticated);
  });

  it('SESSION_COOKIE 名稱與 proxy 檢查的是同一個', () => {
    expect(SESSION_COOKIE).toBe('rp_session');
  });
});

describe('currentOwnerSession()', () => {
  it('屋主組織的 admin：回傳 { partyId, ownerOrgId, displayName }', async () => {
    cookieStore.value = await loginAs('wang.mei@example.com', { SEED_OWNER_EMAIL: 'wang.mei@example.com' });
    const rc = await requestContext();
    expect(await currentOwnerSession()).toEqual({ partyId: rc.partyId, ownerOrgId: '00000000000000000000000002', displayName: 'wang.mei' });
  });

  it('沒有登入：回傳 null', async () => {
    expect(await currentOwnerSession()).toBeNull();
  });

  it('沒有組織身分的帳號：回傳 null', async () => {
    cookieStore.value = await loginAs('new@example.com', {});
    expect(await currentOwnerSession()).toBeNull();
  });

  it('平台營運者：回傳 null', async () => {
    cookieStore.value = await loginAs('ops@example.com', { PLATFORM_OPERATOR_EMAILS: 'ops@example.com' });
    expect(await currentOwnerSession()).toBeNull();
  });

  it('執業主體組織的成員：回傳 null', async () => {
    const orgId = '01HZZZZZZZZZZZZZZZZZZZZZZP';
    cookieStore.value = await loginAs('mgr@example.com', {});
    await kit.asOwner(async (db) => {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '某代管公司', 'practice')`, [orgId]);
      await db.query(
        `INSERT INTO control.org_memberships (id, org_id, user_id, role)
         SELECT '01HZZZZZZZZZZZZZZZZZZZZZZM', $1, u.id, 'admin' FROM control.users u`,
        [orgId],
      );
    });
    // 這個 session 是在加入組織前建立的，身分為空；重新登入才會選到新組織
    expect(await currentOwnerSession()).toBeNull();
    cookieStore.value = await loginAs('mgr@example.com', {}, 120_000);
    const rc = await requestContext();
    expect(rc).toMatchObject({ kind: 'org', orgKind: 'practice', orgId });
    expect(await currentOwnerSession()).toBeNull();
  });
});

describe('whoAmI', () => {
  it('回傳顯示名稱、身分種類與組織名稱', async () => {
    cookieStore.value = await loginAs('wang.mei@example.com', { SEED_OWNER_EMAIL: 'wang.mei@example.com' });
    expect(await whoAmI(await requestContext())).toEqual({ displayName: 'wang.mei', kind: 'org', orgName: '預設組織' });
  });
});
