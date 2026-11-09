import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgDriver } from './drivers';
import { createPgTestDatabase, type PgTestDatabase } from './pg-database-kit';
import { newUlid } from './ulid';
import { createWithTx, type WithTx } from './with-tx';

// 案件成員的讀取政策在真實 PostgreSQL 上的行為（MIL-115、MIL-121）。
// 政策函式 org.case_relations_of_current_party 用 set_config 防遞迴，PGlite 的案例在 case-rls.test.ts。
// 只在有 TEST_DATABASE_URL 時執行，說明見 pg-integration.test.ts。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('案件成員讀取政策（真實 PostgreSQL）', () => {
  let dbh: PgTestDatabase;
  let withTx: WithTx;
  const orgA = newUlid();
  const orgB = newUlid();
  const caseA = newUlid();
  const caseB = newUlid();
  const lessor = newUlid();
  const lessee = newUlid();
  const coLessee = newUlid();
  const stranger = newUlid();
  const expired = newUlid();

  const count = async (partyId: string, sql: string, params: unknown[] = []) => {
    const { rows } = await withTx({ kind: 'party', partyId }, (tx) => tx.query<{ n: number }>(sql, params));
    return rows[0].n;
  };

  beforeAll(async () => {
    dbh = await createPgTestDatabase(adminUrl!, 4);
    withTx = createWithTx(pgDriver(dbh.pool));
    const o = dbh.owner;
    await o.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
    for (const [id, email] of [
      [lessor, 'lessor@example.com'],
      [lessee, 'lessee@example.com'],
      [coLessee, 'co@example.com'],
      [stranger, 'stranger@example.com'],
      [expired, 'expired@example.com'],
    ]) {
      await o.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, 'x')`, [id, email]);
    }
    await o.query(
      `INSERT INTO org.cases (id, org_id, kind, state, business_type) VALUES ($1, $2, 'lease', 'active', 'self_managed'), ($3, $4, 'lease', 'active', 'self_managed')`,
      [caseA, orgA, caseB, orgB],
    );
    const member = (caseId: string, org: string, party: string, relation: string) =>
      o.query(`INSERT INTO org.case_members (id, org_id, case_id, party_id, relation) VALUES ($1, $2, $3, $4, $5)`, [
        newUlid(),
        org,
        caseId,
        party,
        relation,
      ]);
    await member(caseA, orgA, lessor, 'lessor');
    await member(caseA, orgA, lessee, 'lessee');
    await member(caseA, orgA, coLessee, 'co_lessee');
    await member(caseB, orgB, lessee, 'lessee');
    // 已過期的成員：區間在過去
    await o.query(
      `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation, valid_period)
       VALUES ($1, $2, $3, $4, 'lessee', tstzrange(now() - interval '2 days', now() - interval '1 day', '[)'))`,
      [newUlid(), orgA, caseA, expired],
    );
    for (const c of [
      [caseA, orgA],
      [caseB, orgB],
    ]) {
      await o.query(`INSERT INTO org.case_events (id, org_id, case_id, type, occurred_at) VALUES ($1, $2, $3, 'created', now())`, [
        newUlid(),
        c[1],
        c[0],
      ]);
    }
  });

  afterAll(async () => {
    await dbh?.close();
  });

  it('承租人跨組織讀到自己的兩個案件，不屬於任何案件的人讀到 0 個', async () => {
    expect(await count(lessee, `SELECT count(*)::int AS n FROM org.cases`)).toBe(2);
    expect(await count(lessor, `SELECT count(*)::int AS n FROM org.cases`)).toBe(1);
    expect(await count(stranger, `SELECT count(*)::int AS n FROM org.cases`)).toBe(0);
  });

  it('已過期的成員讀不到案件', async () => {
    expect(await count(expired, `SELECT count(*)::int AS n FROM org.cases`)).toBe(0);
  });

  it('成員表：出租人讀整案的有效與過期成員列，承租人只讀自己的列', async () => {
    // 出租人：caseA 的全部成員列（4 列，含過期的那一列）
    expect(await count(lessor, `SELECT count(*)::int AS n FROM org.case_members WHERE case_id = $1`, [caseA])).toBe(4);
    // 承租人：兩個案件各一列自己的
    expect(await count(lessee, `SELECT count(*)::int AS n FROM org.case_members`)).toBe(2);
    expect(await count(coLessee, `SELECT count(*)::int AS n FROM org.case_members`)).toBe(1);
    expect(await count(stranger, `SELECT count(*)::int AS n FROM org.case_members`)).toBe(0);
  });

  it('案件事件：出租人讀得到，承租人讀不到', async () => {
    expect(await count(lessor, `SELECT count(*)::int AS n FROM org.case_events`)).toBe(1);
    expect(await count(lessee, `SELECT count(*)::int AS n FROM org.case_events`)).toBe(0);
  });

  it('成員不能寫入（政策只開 SELECT）', async () => {
    await expect(
      withTx({ kind: 'party', partyId: lessor }, (tx) => tx.query(`UPDATE org.cases SET state = 'closed' WHERE id = $1 RETURNING id`, [caseA])),
    ).resolves.toMatchObject({ rows: [] });
    const { rows } = await dbh.owner.query(`SELECT state FROM org.cases WHERE id = $1`, [caseA]);
    expect(rows[0].state).toBe('active');
  });

  it('自設 app.in_member_lookup 不會讀到更多', async () => {
    const { rows } = await withTx({ kind: 'party', partyId: stranger }, async (tx) => {
      await tx.query(`SELECT set_config('app.in_member_lookup', '1', true)`);
      return tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM org.cases`);
    });
    expect(rows[0].n).toBe(0);
  });

  it('同一個交易內連續查三張表，防遞迴旗標有還原', async () => {
    const result = await withTx({ kind: 'party', partyId: lessor }, async (tx) => {
      const a = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM org.cases`);
      const b = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM org.case_members`);
      const c = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM org.case_events`);
      const flag = await tx.query<{ v: string | null }>(`SELECT current_setting('app.in_member_lookup', true) AS v`);
      return { a: a.rows[0].n, b: b.rows[0].n, c: c.rows[0].n, flag: flag.rows[0].v };
    });
    expect(result.a).toBe(1);
    expect(result.b).toBe(4);
    expect(result.c).toBe(1);
    expect(result.flag === null || result.flag === '').toBe(true);
  });

  it('組織脈絡：別的組織讀不到，主辦組織讀得到', async () => {
    const asOrg = async (orgId: string) => {
      const { rows } = await withTx({ kind: 'org', orgId }, (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM org.cases`));
      return rows[0].n;
    };
    expect(await asOrg(orgA)).toBe(1);
    expect(await asOrg(orgB)).toBe(1);
  });

  it('party_has_tenant_membership：只回是或否，呼叫後 app.party_id 還原', async () => {
    const check = (who: string) =>
      withTx({ kind: 'control' }, async (tx) => {
        const r = await tx.query<{ ok: boolean }>(`SELECT org.party_has_tenant_membership($1) AS ok`, [who]);
        const after = await tx.query<{ v: string | null }>(`SELECT current_setting('app.party_id', true) AS v`);
        return { ok: r.rows[0].ok, after: after.rows[0].v };
      });
    const tenant = await check(lessee);
    expect(tenant.ok).toBe(true);
    expect(tenant.after === null || tenant.after === '').toBe(true);
    expect((await check(lessor)).ok).toBe(false);
    expect((await check(stranger)).ok).toBe(false);
    expect((await check(expired)).ok).toBe(false);
  });
});
