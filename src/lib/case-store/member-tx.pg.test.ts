import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Forbidden } from '../authorize';
import { useTxDriver } from '../pg/database';
import { pgDriver } from '../pg/drivers';
import { createPgTestDatabase, type PgTestDatabase } from '../pg/pg-database-kit';
import { newUlid } from '../pg/ulid';
import type { RequestContext } from '../request-context';
import { withCaseMemberTx } from './index';

// withCaseMemberTx 的跨組織滲透案例，真實 PostgreSQL 版（MIL-89，MIL-115 的待辦）。
// PGlite 的完整行為測試在 member-tx.test.ts。這裡驗證三件在真實 PostgreSQL 才可靠的事：
// 1. 步驟 1 到 3 用 party 脈絡，政策函式的防遞迴旗標在連線池重用下不外洩。
// 2. 不是成員、過期成員、別的案件 ID、不存在的案件，都被拒絕，而且什麼都沒寫。
// 3. 第 3 步之後 org 脈絡消失：同一條連線的下一個交易看不到組織資料。
// 連線池只開 1 條，每個交易重用同一條連線。只在有 TEST_DATABASE_URL 時執行。
const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('withCaseMemberTx 的跨組織滲透（真實 PostgreSQL）', () => {
  let dbh: PgTestDatabase;
  const orgA = newUlid();
  const orgB = newUlid();
  const caseA = newUlid();
  const caseB = newUlid();
  const lessee = newUlid();
  const outsider = newUlid();
  const expired = newUlid();
  const lesseeOfB = newUlid();

  const partyRc = (partyId: string): Extract<RequestContext, { kind: 'party' }> => ({
    kind: 'party',
    userId: newUlid(),
    partyId,
    requestId: 't',
  });

  const eventCount = async (caseId: string) =>
    Number((await dbh.owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM org.case_events WHERE case_id = $1 AND type = 'member_added'`, [caseId])).rows[0].n);

  /** 固定的 repository 方法：只寫 tx.caseId 這個案件。 */
  const reportRepair = (caseId: string) => (tx: { caseId: string; orgId: string; query: (sql: string, params?: unknown[]) => Promise<unknown> }) =>
    tx.query(`INSERT INTO org.case_events (id, org_id, case_id, type, occurred_at) VALUES ($1, $2, $3, 'member_added', now())`, [newUlid(), tx.orgId, tx.caseId]).then(() => caseId);

  const forbiddenReason = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      expect(error).toBeInstanceOf(Forbidden);
      return (error as Forbidden).reason;
    }
    throw new Error('預期丟 Forbidden，但通過了');
  };

  beforeAll(async () => {
    dbh = await createPgTestDatabase(adminUrl!, 1);
    useTxDriver(pgDriver(dbh.pool));
    const o = dbh.owner;
    await o.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
    for (const [id, email] of [
      [lessee, 'lessee@example.com'],
      [outsider, 'outsider@example.com'],
      [expired, 'expired@example.com'],
      [lesseeOfB, 'lessee-b@example.com'],
    ]) {
      await o.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, 'x')`, [id, email]);
    }
    await o.query(
      `INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', 'active', 'self_managed', 'A'), ($3, $4, 'lease', 'active', 'self_managed', 'B')`,
      [caseA, orgA, caseB, orgB],
    );
    const member = (caseId: string, org: string, party: string, period?: string) =>
      o.query(
        period
          ? `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation, valid_period) VALUES ($1, $2, $3, $4, 'lessee', ${period})`
          : `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, 'lessee')`,
        [newUlid(), org, caseId, party],
      );
    await member(caseA, orgA, lessee);
    await member(caseB, orgB, lesseeOfB);
    await member(caseA, orgA, expired, `tstzrange(now() - interval '2 days', now() - interval '1 day', '[)')`);
  }, 120_000);

  afterAll(async () => {
    useTxDriver(undefined);
    await dbh?.close();
  });

  it('成員報修：寫入落在案件所在的組織', async () => {
    const before = await eventCount(caseA);
    await withCaseMemberTx(partyRc(lessee), { caseId: caseA, action: 'repair.report' }, (tx) => reportRepair(caseA)(tx));
    expect(await eventCount(caseA)).toBe(before + 1);
  });

  it('不是成員：Forbidden，什麼都沒寫', async () => {
    const before = await eventCount(caseA);
    const reason = await forbiddenReason(withCaseMemberTx(partyRc(outsider), { caseId: caseA, action: 'repair.report' }, (tx) => reportRepair(caseA)(tx)));
    expect(reason).toBe('not_a_member');
    expect(await eventCount(caseA)).toBe(before);
  });

  it('B 組織的承租人拿 A 組織的案件 ID：被拒，與案件不存在是同一個原因', async () => {
    const before = await eventCount(caseA);
    const foreign = await forbiddenReason(withCaseMemberTx(partyRc(lesseeOfB), { caseId: caseA, action: 'repair.report' }, (tx) => reportRepair(caseA)(tx)));
    const missing = await forbiddenReason(withCaseMemberTx(partyRc(lesseeOfB), { caseId: newUlid(), action: 'repair.report' }, (tx) => reportRepair(caseA)(tx)));
    expect(foreign).toBe('not_a_member');
    expect(foreign).toBe(missing);
    expect(await eventCount(caseA)).toBe(before);
  });

  it('成員資格過期：被拒，什麼都沒寫', async () => {
    const before = await eventCount(caseA);
    await forbiddenReason(withCaseMemberTx(partyRc(expired), { caseId: caseA, action: 'repair.report' }, (tx) => reportRepair(caseA)(tx)));
    expect(await eventCount(caseA)).toBe(before);
  });

  it('callback 丟錯：整個交易回滾', async () => {
    const before = await eventCount(caseA);
    await expect(
      withCaseMemberTx(partyRc(lessee), { caseId: caseA, action: 'repair.report' }, async (tx) => {
        await reportRepair(caseA)(tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await eventCount(caseA)).toBe(before);
  });

  it('同一條連線重用：成員操作之後，下一個 party 交易讀不到組織的資料', async () => {
    await withCaseMemberTx(partyRc(lessee), { caseId: caseA, action: 'repair.report' }, (tx) => reportRepair(caseA)(tx));
    const { withTx } = await import('../pg/database');
    const leaked = await withTx({ kind: 'party', partyId: outsider }, (tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM org.case_events'));
    expect(leaked.rows[0].n).toBe(0);
    const ctx = await withTx({ kind: 'control' }, (tx) => tx.query<{ org: string | null }>(`SELECT nullif(current_setting('app.org_id', true), '') AS org`));
    expect(ctx.rows[0].org).toBeNull();
  });
});
