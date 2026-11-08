import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockMailer, type MockMailer } from '../mailer/mock-mailer';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';
import { Unauthenticated } from '../request-context';
import { defaultIdentityFacts, type IdentityFacts } from './account-service';
import { AUTH_CONFIG, DEFAULT_OWNER_ORG_ID, PLATFORM_ORG_ID } from './config';
import { completeLogin, logout, requestLoginCode, resolveRequestContext, type LoginDeps } from './login-flow';
import { auditContextFor, openSession } from './session-service';

// 登入、session、成員資格重查的整合測試。連線是 PGlite 的 app_rw，RLS 與權限都生效。

let kit: RouteDb;
let mailer: MockMailer;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());

const T0 = new Date('2026-11-09T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(async () => {
  await kit.reset();
  mailer = createMockMailer();
});

function deps(over: Partial<LoginDeps> = {}): LoginDeps {
  return { now: T0, secret: 'test-secret', mailer, env: {}, ...over };
}

function lastCode(): string {
  const mail = mailer.sent.at(-1);
  const match = mail?.text.match(/\d{6}/);
  if (!match) throw new Error('沒有寄出驗證碼');
  return match[0];
}

async function loginAs(email: string, over: Partial<LoginDeps> = {}) {
  const d = deps(over);
  expect(await requestLoginCode(email, d)).toEqual({ status: 'sent' });
  const result = await completeLogin(email, lastCode(), d);
  if (result.status !== 'ok') throw new Error('登入失敗');
  return result;
}

/** 讀某條稽核鏈的事件（app_rw 只讀得到自己那條）。 */
async function auditEvents(chainOrgId: string) {
  return withTx({ kind: 'org', orgId: chainOrgId }, async (tx) => {
    const { rows } = await tx.query<{ action: string; actor_type: string; actor_id: string | null; payload: Record<string, unknown> }>(
      'SELECT action, actor_type, actor_id, payload FROM audit.events ORDER BY seq',
    );
    return rows;
  });
}

const OWNER_ENV = { SEED_OWNER_EMAIL: 'owner@example.com' };
const OPERATOR_ENV = { PLATFORM_OPERATOR_EMAILS: 'ops@example.com' };

describe('寄出驗證碼', () => {
  it('寄一封 6 碼數字的信給該 email；資料庫只存雜湊，不存驗證碼', async () => {
    expect(await requestLoginCode('Owner@Example.com ', deps())).toEqual({ status: 'sent' });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: 'owner@example.com', kind: 'auth.otp' });
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);

    const rows = await kit.asOwner(async (db) => (await db.query<Record<string, unknown>>('SELECT * FROM control.login_otps')).rows);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('有帳號與沒有帳號的 email，回應完全相同', async () => {
    await loginAs('owner@example.com', { env: OWNER_ENV });
    const known = await requestLoginCode('owner@example.com', deps({ now: at(120_000) }));
    const unknown = await requestLoginCode('nobody@example.com', deps({ now: at(120_000) }));
    expect(known).toEqual(unknown);
    expect(known).toEqual({ status: 'sent' });
  });

  it('同一 email 每分鐘 1 次：59 秒內被擋，滿 60 秒可再寄，之前那組作廢', async () => {
    await requestLoginCode('a@example.com', deps());
    const first = lastCode();
    expect(await requestLoginCode('a@example.com', deps({ now: at(59_000) }))).toEqual({ status: 'rate_limited', retryAfterSec: 1 });
    expect(mailer.sent).toHaveLength(1);
    expect(await requestLoginCode('a@example.com', deps({ now: at(60_000) }))).toEqual({ status: 'sent' });
    const second = lastCode();
    if (first !== second) {
      expect(await completeLogin('a@example.com', first, deps({ now: at(61_000) }))).toEqual({ status: 'invalid_code' });
    }
    expect((await completeLogin('a@example.com', second, deps({ now: at(62_000) }))).status).toBe('ok');
  });

  it('不同 email 互不影響頻率限制', async () => {
    await requestLoginCode('a@example.com', deps());
    expect(await requestLoginCode('b@example.com', deps())).toEqual({ status: 'sent' });
  });

  it('email 格式不對：不寄信', async () => {
    expect(await requestLoginCode('not-an-email', deps())).toEqual({ status: 'invalid_email' });
    expect(mailer.sent).toHaveLength(0);
  });

  it('寄信失敗時丟錯，並撤回驗證碼，使用者可以馬上重試', async () => {
    mailer.failNext(new Error('smtp down'));
    await expect(requestLoginCode('a@example.com', deps())).rejects.toThrow('smtp down');
    expect(await requestLoginCode('a@example.com', deps({ now: at(1_000) }))).toEqual({ status: 'sent' });
  });
});

describe('驗證碼輸入', () => {
  it('10 分鐘內有效，滿 10 分鐘失效', async () => {
    await requestLoginCode('a@example.com', deps());
    const code = lastCode();
    expect(await completeLogin('a@example.com', code, deps({ now: at(AUTH_CONFIG.otpTtlMs) }))).toEqual({ status: 'invalid_code' });
    await requestLoginCode('b@example.com', deps());
    expect((await completeLogin('b@example.com', lastCode(), deps({ now: at(AUTH_CONFIG.otpTtlMs - 1) }))).status).toBe('ok');
  });

  it('錯 5 次就失效，之後輸入正確的也不行', async () => {
    await requestLoginCode('a@example.com', deps());
    const code = lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      expect(await completeLogin('a@example.com', wrong, deps({ now: at(1000 + i) }))).toEqual({ status: 'invalid_code' });
    }
    expect(await completeLogin('a@example.com', code, deps({ now: at(2000) }))).toEqual({ status: 'invalid_code' });
  });

  it('錯 4 次後輸入正確的仍可登入', async () => {
    await requestLoginCode('a@example.com', deps());
    const code = lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i += 1) await completeLogin('a@example.com', wrong, deps({ now: at(1000 + i) }));
    expect((await completeLogin('a@example.com', code, deps({ now: at(2000) }))).status).toBe('ok');
  });

  it('用過即失效：同一組驗證碼不能登入第二次', async () => {
    await requestLoginCode('a@example.com', deps());
    const code = lastCode();
    expect((await completeLogin('a@example.com', code, deps())).status).toBe('ok');
    expect(await completeLogin('a@example.com', code, deps({ now: at(1000) }))).toEqual({ status: 'invalid_code' });
  });

  it('沒有寄過驗證碼的 email、格式不對的驗證碼，回應都和輸錯相同', async () => {
    expect(await completeLogin('nobody@example.com', '123456', deps())).toEqual({ status: 'invalid_code' });
    expect(await completeLogin('a@example.com', 'abcdef', deps())).toEqual({ status: 'invalid_code' });
    expect(await completeLogin('a@example.com', '12345', deps())).toEqual({ status: 'invalid_code' });
    expect(await completeLogin('bad', '123456', deps())).toEqual({ status: 'invalid_code' });
  });

  it('別人的驗證碼不能用在另一個 email', async () => {
    await requestLoginCode('a@example.com', deps());
    const code = lastCode();
    await requestLoginCode('b@example.com', deps());
    if (code !== lastCode()) {
      expect(await completeLogin('b@example.com', code, deps({ now: at(1000) }))).toEqual({ status: 'invalid_code' });
    }
  });
});

describe('session 與預設組織', () => {
  it('SEED_OWNER_EMAIL 的帳號登入後是預設組織（屋主組織）的 admin', async () => {
    const result = await loginAs('owner@example.com', { env: OWNER_ENV });
    expect(result.identity).toEqual({ kind: 'org', orgId: DEFAULT_OWNER_ORG_ID });
    const rc = await resolveRequestContext(result.token, at(1000), 'r1');
    expect(rc).toMatchObject({ kind: 'org', orgId: DEFAULT_OWNER_ORG_ID, orgKind: 'owner', role: 'admin', requestId: 'r1' });
  });

  it('session 只存 token 的雜湊，到期時間是設定值', async () => {
    const result = await loginAs('owner@example.com', { env: OWNER_ENV });
    const rows = await kit.asOwner(async (db) => (await db.query<Record<string, unknown>>('SELECT * FROM control.sessions')).rows);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(result.token);
    expect(new Date(rows[0].expires_at as string).getTime()).toBe(T0.getTime() + AUTH_CONFIG.sessionTtlMs);
    expect(rows[0].identity_level).toBe(1);
  });

  it('既有資料登入後看得到：預設組織的物件，admin 以 org 脈絡讀得到，別的組織讀不到', async () => {
    await withTx({ kind: 'org', orgId: DEFAULT_OWNER_ORG_ID }, async (tx) => {
      const unitId = newUlid();
      await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [newUlid(), unitId, '既有資料地址']);
      await tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [
        newUlid(),
        DEFAULT_OWNER_ORG_ID,
        unitId,
        '既有物件',
        '既有資料地址',
      ]);
    });
    const { token } = await loginAs('owner@example.com', { env: OWNER_ENV });
    const rc = await resolveRequestContext(token, at(1000), 'r');
    if (rc.kind !== 'org') throw new Error('應為 org');
    const names = await withTx({ kind: 'org', orgId: rc.orgId, partyId: rc.partyId }, async (tx) =>
      (await tx.query<{ name: string }>('SELECT name FROM org.properties')).rows.map((r) => r.name),
    );
    expect(names).toEqual(['既有物件']);
  });

  it('沒有任何身分的帳號：登入成功但 requestContext 丟 no_identity', async () => {
    const result = await loginAs('new@example.com');
    expect(result.identity).toBeNull();
    await expect(resolveRequestContext(result.token, at(1000), 'r')).rejects.toMatchObject({ name: 'Unauthenticated', reason: 'no_identity' });
  });

  it('平台營運者登入後是 operator 脈絡，成員資格在平台組織', async () => {
    const result = await loginAs('ops@example.com', { env: OPERATOR_ENV });
    expect(result.identity).toEqual({ kind: 'operator' });
    const rc = await resolveRequestContext(result.token, at(1000), 'r');
    expect(rc).toMatchObject({ kind: 'operator' });
    expect(rc).not.toHaveProperty('orgId');
  });

  it('同時是屋主與營運者：預設身分是屋主組織', async () => {
    const result = await loginAs('both@example.com', { env: { SEED_OWNER_EMAIL: 'both@example.com', ...OPERATOR_ENV, PLATFORM_OPERATOR_EMAILS: 'both@example.com' } });
    expect(result.identity).toEqual({ kind: 'org', orgId: DEFAULT_OWNER_ORG_ID });
  });

  it('同一個 email 再登入：沿用同一個帳號，不重複建立', async () => {
    await loginAs('owner@example.com', { env: OWNER_ENV });
    await loginAs('owner@example.com', { env: OWNER_ENV, now: at(120_000) });
    const counts = await kit.asOwner(async (db) => ({
      parties: (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM control.parties WHERE email = 'owner@example.com'`)).rows[0].n,
      users: (await db.query<{ n: string }>('SELECT count(*)::text AS n FROM control.users')).rows[0].n,
      members: (await db.query<{ n: string }>('SELECT count(*)::text AS n FROM control.org_memberships')).rows[0].n,
    }));
    expect(counts).toEqual({ parties: '1', users: '1', members: '1' });
  });

  it('承租人登入前就存在的 party（送簽時依 email 建立）：登入後沿用同一個 party', async () => {
    const partyId = newUlid();
    await kit.asOwner((db) =>
      db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'tenant@example.com', '王小明')`, [partyId]),
    );
    const result = await loginAs('tenant@example.com');
    const rows = await kit.asOwner(async (db) => (await db.query<{ party_id: string }>('SELECT party_id FROM control.users')).rows);
    expect(rows).toEqual([{ party_id: partyId }]);
    expect(result.status).toBe('ok');
  });
});

describe('每個請求重查', () => {
  it('沒有 token、查不到 token：丟 Unauthenticated(no_session)', async () => {
    await expect(resolveRequestContext(undefined, T0, 'r')).rejects.toBeInstanceOf(Unauthenticated);
    await expect(resolveRequestContext('not-a-real-token', T0, 'r')).rejects.toMatchObject({ reason: 'no_session' });
  });

  it('session 到期：丟 expired，並刪掉那一列', async () => {
    const { token } = await loginAs('owner@example.com', { env: OWNER_ENV });
    await expect(resolveRequestContext(token, at(AUTH_CONFIG.sessionTtlMs), 'r')).rejects.toMatchObject({ reason: 'expired' });
    await expect(resolveRequestContext(token, at(1000), 'r')).rejects.toMatchObject({ reason: 'no_session' });
  });

  it('成員被移除後，下一個請求就被拒絕，session 被刪，組織的稽核鏈留下事件', async () => {
    const { token } = await loginAs('owner@example.com', { env: OWNER_ENV });
    await resolveRequestContext(token, at(1000), 'r1'); // 移除前可用
    await kit.asOwner((db) => db.query('DELETE FROM control.org_memberships'));

    await expect(resolveRequestContext(token, at(2000), 'r2')).rejects.toMatchObject({
      name: 'Unauthenticated',
      reason: 'membership_lost',
    });
    // 再來一次：session 已刪，不會重複寫事件
    await expect(resolveRequestContext(token, at(3000), 'r3')).rejects.toMatchObject({ reason: 'no_session' });

    const events = await auditEvents(DEFAULT_OWNER_ORG_ID);
    expect(events.map((e) => e.action)).toEqual(['auth.login', 'auth.membership_rejected']);
    expect(events[1]).toMatchObject({ actor_type: 'party', payload: { actor_identity_level: 1, identity: 'org', reason: 'membership_removed' } });
  });

  it('角色被改動時，下一個請求就帶新的角色', async () => {
    const { token } = await loginAs('owner@example.com', { env: OWNER_ENV });
    await kit.asOwner((db) => db.query(`UPDATE control.org_memberships SET role = 'viewer'`));
    expect(await resolveRequestContext(token, at(1000), 'r')).toMatchObject({ kind: 'org', role: 'viewer' });
  });

  it('營運者被移出平台組織後被拒絕，事件進平台鏈', async () => {
    const { token } = await loginAs('ops@example.com', { env: OPERATOR_ENV });
    await kit.asOwner((db) => db.query('DELETE FROM control.org_memberships'));
    await expect(resolveRequestContext(token, at(1000), 'r')).rejects.toMatchObject({ reason: 'membership_lost' });
    const events = await auditEvents(PLATFORM_ORG_ID);
    expect(events.map((e) => e.action)).toEqual(['auth.login', 'auth.membership_rejected']);
  });
});

describe('登出', () => {
  it('刪除 session 列，之後同一個 token 立即失效，並寫登出事件', async () => {
    const { token } = await loginAs('owner@example.com', { env: OWNER_ENV });
    await logout(token);
    const rows = await kit.asOwner(async (db) => (await db.query('SELECT 1 FROM control.sessions')).rows);
    expect(rows).toHaveLength(0);
    await expect(resolveRequestContext(token, at(1000), 'r')).rejects.toMatchObject({ reason: 'no_session' });
    expect((await auditEvents(DEFAULT_OWNER_ORG_ID)).map((e) => e.action)).toEqual(['auth.login', 'auth.logout']);
  });

  it('登出是冪等的：token 不存在也不丟錯，不寫事件', async () => {
    await expect(logout('whatever')).resolves.toBeUndefined();
    expect(await auditEvents(PLATFORM_ORG_ID)).toEqual([]);
  });

  it('登出只影響自己的 session，同帳號另一個 session 仍可用', async () => {
    const a = await loginAs('owner@example.com', { env: OWNER_ENV });
    const b = await loginAs('owner@example.com', { env: OWNER_ENV, now: at(120_000) });
    await logout(a.token);
    expect(await resolveRequestContext(b.token, at(130_000), 'r')).toMatchObject({ kind: 'org' });
  });
});

describe('登入事件（actor_identity_level = 1）', () => {
  it('屋主登入：事件進預設組織的鏈，行為者是該使用者的 party，payload 有驗證等級', async () => {
    const result = await loginAs('owner@example.com', { env: OWNER_ENV });
    const rc = await resolveRequestContext(result.token, at(1000), 'r');
    const events = await auditEvents(DEFAULT_OWNER_ORG_ID);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'auth.login',
      actor_type: 'party',
      actor_id: rc.partyId,
      payload: { actor_identity_level: 1, identity: 'org' },
    });
    expect(JSON.stringify(events)).not.toContain('owner@example.com');
  });

  it('沒有組織身分的登入進平台鏈', async () => {
    await loginAs('new@example.com');
    expect((await auditEvents(PLATFORM_ORG_ID)).map((e) => e.action)).toEqual(['auth.login']);
  });

  it('承租人登入寫 tenant.login，進平台組織的鏈（ADR-0019 決議 2）', async () => {
    const userId = newUlid();
    const partyId = newUlid();
    await kit.asOwner(async (db) => {
      await db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'tenant@example.com', 't')`, [partyId]);
      await db.query('INSERT INTO control.users (id, party_id) VALUES ($1, $2)', [userId, partyId]);
    });
    const identity = { kind: 'party' } as const;
    const opened = await withTx(auditContextFor(identity, partyId), (tx) => openSession(tx, { userId, partyId, identity, now: T0 }));

    const events = await auditEvents(PLATFORM_ORG_ID);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'tenant.login', actor_id: partyId, payload: { actor_identity_level: 1, identity: 'party' } });

    // 承租人身分要有案件成員關係才成立；案件表尚未建立（MIL-115），預設查詢回傳 false
    await expect(resolveRequestContext(opened.token, at(1000), 'r', defaultIdentityFacts)).rejects.toMatchObject({ reason: 'membership_lost' });
    const withCase: IdentityFacts = { partyHasCaseMembership: async () => true };
    const again = await withTx(auditContextFor(identity, partyId), (tx) => openSession(tx, { userId, partyId, identity, now: T0 }));
    expect(await resolveRequestContext(again.token, at(1000), 'r', withCase)).toEqual({ kind: 'party', userId, partyId, requestId: 'r' });
  });

  it('openSession 的交易脈絡與身分不一致時拒絕', async () => {
    await expect(
      withTx({ kind: 'control' }, (tx) =>
        openSession(tx, { userId: newUlid(), partyId: newUlid(), identity: { kind: 'org', orgId: DEFAULT_OWNER_ORG_ID }, now: T0 }),
      ),
    ).rejects.toThrow(/脈絡/);
  });
});
