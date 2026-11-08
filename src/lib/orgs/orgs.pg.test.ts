import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeLogin, requestLoginCode, resolveRequestContext } from '../auth/login-flow';
import { useTxDriver as installTxDriver, withTx } from '../pg/database';
import { pgDriver } from '../pg/drivers';
import { createMockMailer } from '../mailer/mock-mailer';
import { createPgTestDatabase, type PgTestDatabase } from '../pg/pg-database-kit';
import { changeRole, inviteMember, removeMember } from './members';
import { createOwnerOrg } from './onboarding';

// MIL-106 在真實 PostgreSQL 的驗證：PGlite 是單連線，測不出的併發。
// 只在有 TEST_DATABASE_URL 時執行，說明見 pg-integration.test.ts。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('組織與成員：真實 PostgreSQL 的併發', () => {
  let db: PgTestDatabase;
  const mailer = createMockMailer();
  let clock = 0;

  beforeAll(async () => {
    db = await createPgTestDatabase(adminUrl!, 8);
    installTxDriver(pgDriver(db.pool));
  });
  afterAll(async () => {
    installTxDriver(undefined);
    await db.close();
  });

  const now = () => new Date(Date.UTC(2026, 10, 9, 10, 0, 0) + clock);

  async function login(email: string) {
    clock += 120_000;
    const deps = { now: now(), secret: 'test-secret', mailer, env: {} };
    await requestLoginCode(email, deps);
    const code = mailer.sent.at(-1)!.text.match(/\d{6}/)![0];
    const result = await completeLogin(email, code, deps);
    if (result.status !== 'ok') throw new Error('登入失敗');
    return result.token;
  }

  async function adminOf(token: string) {
    const rc = await resolveRequestContext(token, now(), 't');
    if (rc.kind !== 'org') throw new Error('不是組織身分');
    return rc;
  }

  const inOrg = <T>(rc: Awaited<ReturnType<typeof adminOf>>, fn: Parameters<typeof withTx<{ kind: 'org'; orgId: string }, T>>[1]) =>
    withTx({ kind: 'org', orgId: rc.orgId, partyId: rc.partyId }, fn);

  it('兩位 admin 同時互相降級：只有一個成功，組織仍有 admin', async () => {
    const firstToken = await login('pg-first@example.com');
    expect(await createOwnerOrg(firstToken, { name: '併發組織' }, { now: now() })).toMatchObject({ status: 'ok' });
    const first = await adminOf(firstToken);
    await inOrg(first, (tx) => inviteMember(tx, first, { email: 'pg-second@example.com', role: 'admin', now: now() }));
    const secondToken = await login('pg-second@example.com');
    const second = await adminOf(secondToken);

    const results = await Promise.all([
      inOrg(first, (tx) => changeRole(tx, first, { userId: second.userId, role: 'viewer' })),
      inOrg(second, (tx) => changeRole(tx, second, { userId: first.userId, role: 'viewer' })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['changed', 'last_admin']);
    const { rows } = await db.owner.query("SELECT count(*)::int AS n FROM control.org_memberships WHERE org_id = $1 AND role = 'admin'", [first.orgId]);
    expect(rows[0].n).toBe(1);
  });

  it('兩位 admin 同時互相移除：只有一個成功，組織仍有 admin', async () => {
    const firstToken = await login('pg-r1@example.com');
    await createOwnerOrg(firstToken, { name: '併發移除' }, { now: now() });
    const first = await adminOf(firstToken);
    await inOrg(first, (tx) => inviteMember(tx, first, { email: 'pg-r2@example.com', role: 'admin', now: now() }));
    const second = await adminOf(await login('pg-r2@example.com'));

    const results = await Promise.all([
      inOrg(first, (tx) => removeMember(tx, first, { userId: second.userId })),
      inOrg(second, (tx) => removeMember(tx, second, { userId: first.userId })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['last_admin', 'removed']);
    const { rows } = await db.owner.query('SELECT count(*)::int AS n FROM control.org_memberships WHERE org_id = $1', [first.orgId]);
    expect(rows[0].n).toBe(1);
  });

  it('同一個 session 並發建兩次組織：只有一個成功，沒有多出孤兒組織', async () => {
    const token = await login('pg-double@example.com');
    const before = await db.owner.query<{ n: number }>("SELECT count(*)::int AS n FROM control.orgs WHERE kind = 'owner'");
    const results = await Promise.all([
      createOwnerOrg(token, { name: 'X' }, { now: now() }),
      createOwnerOrg(token, { name: 'Y' }, { now: now() }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['has_identity', 'ok']);
    const after = await db.owner.query<{ n: number }>("SELECT count(*)::int AS n FROM control.orgs WHERE kind = 'owner'");
    expect(after.rows[0].n - before.rows[0].n).toBe(1);
  });

  it('兩個經理人同時認領同一統編：一個登錄、一個排審核台，執業主體只有一列', async () => {
    const [a, b] = await Promise.all([login('pg-p1@example.com'), login('pg-p2@example.com')]);
    const { createPracticeOrg } = await import('./onboarding');
    const form = { name: '併發公司', taxId: '87654321', entityType: 'company', kinds: ['management'] };
    const results = await Promise.all([createPracticeOrg(a, form, { now: now() }), createPracticeOrg(b, form, { now: now() })]);
    expect(results).toEqual([{ status: 'ok', landing: '/' }, { status: 'ok', landing: '/' }]);
    const entities = await db.owner.query("SELECT count(*)::int AS n FROM registry.practice_entities WHERE tax_id = '87654321'");
    expect(entities.rows[0].n).toBe(1);
    const claims = await db.owner.query("SELECT count(*)::int AS n FROM registry.review_items WHERE type = 'entity_claim'");
    expect(claims.rows[0].n).toBe(1);
  });
});
