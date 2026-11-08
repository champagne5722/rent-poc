import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '@/lib/auth/config';
import { readSessionToken } from '@/lib/auth/cookie';
import { resolveRequestContext } from '@/lib/auth/login-flow';
import { createMockMailer, type MockMailer } from '@/lib/mailer/mock-mailer';
import { setMailer } from '@/lib/mailer';
import { setupRouteDb, type RouteDb } from '@/lib/pg/route-test-kit';
import { POST as logoutRoute } from './logout/route';
import { POST as otpRoute } from './otp/route';
import { POST as verifyRoute } from './verify/route';

// MIL-103：登入、驗證碼錯誤次數、登出的 route 層測試。連線是 PGlite 的 app_rw。

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
  vi.stubEnv('SEED_OWNER_EMAIL', 'owner@example.com');
});
afterEach(() => {
  setMailer(undefined);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const post = (route: (r: Request) => Promise<Response>, url: string, body: unknown, headers: Record<string, string> = {}) =>
  route(new Request(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body), headers }));
const otp = (email: string) => post(otpRoute, '/api/auth/otp', { email });
const verify = (email: string, code: string) => post(verifyRoute, '/api/auth/verify', { email, code });
const lastCode = () => mailer.sent.at(-1)!.text.match(/\d{6}/)![0];
const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000');

describe('POST /api/auth/otp', () => {
  it('寄出驗證碼，回應只有 sent', async () => {
    const res = await otp('owner@example.com');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: { sent: true } });
    expect(mailer.sent).toHaveLength(1);
  });

  it('email 有沒有帳號，回應的狀態與本文完全相同', async () => {
    await otp('owner@example.com');
    const code = lastCode();
    await verify('owner@example.com', code); // 建立帳號
    vi.useFakeTimers({ now: Date.now() + 120_000, toFake: ['Date'] });
    const known = await otp('owner@example.com');
    const unknown = await otp('nobody@example.com');
    expect(known.status).toBe(unknown.status);
    expect(await json(known)).toEqual(await json(unknown));
  });

  it('1 分鐘內再寄回 429，附 Retry-After，不寄第二封', async () => {
    await otp('a@example.com');
    const res = await otp('a@example.com');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await json(res)).retryAfterSec).toBeGreaterThan(0);
    expect(mailer.sent).toHaveLength(1);
  });

  it('email 格式不對回 400；本文不是 JSON 也回 400', async () => {
    expect((await otp('not-an-email')).status).toBe(400);
    const res = await otpRoute(new Request('http://localhost/api/auth/otp', { method: 'POST', body: 'x' }));
    expect(res.status).toBe(400);
  });

  it('寄信失敗回 502，不洩漏內部錯誤', async () => {
    mailer.failNext(new Error('smtp password wrong'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await otp('a@example.com');
    expect(res.status).toBe(502);
    expect(JSON.stringify(await json(res))).not.toContain('smtp');
  });
});

describe('POST /api/auth/verify', () => {
  it('正確的驗證碼：200，Set-Cookie 只放隨機 token，屬性是 HttpOnly、Secure、SameSite=Lax', async () => {
    await otp('owner@example.com');
    const res = await verify('Owner@Example.com', lastCode());
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: { redirectTo: '/' } });

    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43,};`));
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('owner@example.com');

    const token = readSessionToken(setCookie.split(';')[0])!;
    expect(await resolveRequestContext(token, new Date(), 'r')).toMatchObject({ kind: 'org', orgKind: 'owner', role: 'admin' });
  });

  it('沒有任何組織身分的帳號：登入成功但導向說明頁', async () => {
    await otp('new@example.com');
    const res = await verify('new@example.com', lastCode());
    expect(res.status).toBe(200);
    expect((await json(res)).data.redirectTo).toBe('/login?notice=no-identity');
    expect(res.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);
  });

  it('錯誤、沒寄過、格式不對、用過，回應的狀態與本文全部相同，也不設 cookie', async () => {
    await otp('owner@example.com');
    const code = lastCode();
    const bodies: unknown[] = [];
    const responses = [
      await verify('owner@example.com', wrongCode(code)),
      await verify('nobody@example.com', '123456'),
      await verify('owner@example.com', 'abc'),
    ];
    expect((await verify('owner@example.com', code)).status).toBe(200);
    responses.push(await verify('owner@example.com', code)); // 用過
    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(res.headers.get('set-cookie')).toBeNull();
      bodies.push(await json(res));
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it('錯 5 次後，正確的驗證碼也不能登入', async () => {
    await otp('owner@example.com');
    const code = lastCode();
    for (let i = 0; i < 5; i += 1) expect((await verify('owner@example.com', wrongCode(code))).status).toBe(400);
    const res = await verify('owner@example.com', code);
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('驗證碼 10 分鐘後失效', async () => {
    await otp('owner@example.com');
    const code = lastCode();
    vi.useFakeTimers({ now: Date.now() + 10 * 60_000 + 1000, toFake: ['Date'] });
    expect((await verify('owner@example.com', code)).status).toBe(400);
  });
});

describe('POST /api/auth/logout', () => {
  async function login(): Promise<{ token: string; cookie: string }> {
    await otp('owner@example.com');
    const res = await verify('owner@example.com', lastCode());
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    return { token: readSessionToken(cookie)!, cookie };
  }

  it('刪除 session 列、清掉 cookie，之後同一個 token 立即失效', async () => {
    const { token, cookie } = await login();
    const res = await post(logoutRoute, '/api/auth/logout', {}, { cookie });
    expect(res.status).toBe(200);
    const cleared = res.headers.get('set-cookie')!;
    expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
    expect(cleared).toContain('SameSite=Lax');

    const rows = await kit.asOwner(async (db) => (await db.query('SELECT 1 FROM control.sessions')).rows);
    expect(rows).toHaveLength(0);
    await expect(resolveRequestContext(token, new Date(), 'r')).rejects.toMatchObject({ reason: 'no_session' });
  });

  it('沒有 cookie 也回成功，不丟錯', async () => {
    const res = await post(logoutRoute, '/api/auth/logout', {});
    expect(res.status).toBe(200);
  });
});
