import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgTestDatabase, type PgTestDatabase } from '../pg/pg-database-kit';
import { MIGRATIONS_DIR } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';

// MIL-195：migration 0077 的回填在真實 PostgreSQL 上的行為。PGlite 版本在 case-kind-migration.test.ts。
// 真實 PostgreSQL 的差別：app_owner 是一般角色，FORCE RLS 對它生效，回填必須逐組織設定脈絡。
// 做法：資料庫已套用全部 migration，先拆掉 0077 加的東西，用舊欄位寫入各種既有案件，
// 再以 app_owner 身分在一個交易內重跑 0077 的 SQL（與 runner 相同），檢查筆數與歸類。
// 只在有 TEST_DATABASE_URL 時執行，說明見 pg-integration.test.ts。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('案件種類回填（真實 PostgreSQL）', () => {
  let dbh: PgTestDatabase;
  const orgA = newUlid();
  const orgB = newUlid();
  const expected = new Map<string, string>();

  const seed = async (label: string, orgId: string, kind: string, businessType: string | null, routing: boolean | null, caseKind: string) => {
    const o = dbh.owner;
    const caseId = newUlid();
    expected.set(label, caseKind);
    await o.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, $3, 'active', $4, $5)`, [
      caseId,
      orgId,
      kind,
      businessType,
      label,
    ]);
    if (routing === null) return;
    const contractId = newUlid();
    const fields = { routing: { businessType, lesseeIsMasterLessor: routing, brokerMediated: false } };
    await o.query(`INSERT INTO org.contracts (id, org_id, case_id, fields) VALUES ($1, $2, $3, $4::jsonb)`, [contractId, orgId, caseId, JSON.stringify(fields)]);
    await o.query(`UPDATE org.cases SET current_contract_id = $2 WHERE id = $1`, [caseId, contractId]);
  };

  let before = 0;

  beforeAll(async () => {
    dbh = await createPgTestDatabase(adminUrl!, 2);
    const o = dbh.owner;
    // 還原成 0077 以前的形狀
    await o.query(`
      DROP TRIGGER cases_default_case_kind ON org.cases;
      DROP FUNCTION org.cases_default_case_kind();
      ALTER TABLE org.cases DROP COLUMN linked_master_lease_case_id;
      ALTER TABLE org.cases DROP COLUMN case_kind;`);
    await o.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'practice')`, [orgA, orgB]);
    await seed('自管', orgA, 'lease', 'self_managed', false, 'lease');
    await seed('自管，承租人是包租業者', orgA, 'lease', 'self_managed', true, 'master_lease');
    await seed('自管，沒有合約', orgA, 'lease', 'self_managed', null, 'lease');
    await seed('代管，旗標為真仍是租賃', orgA, 'lease', 'managed', true, 'lease');
    await seed('委託管理', orgA, 'management', null, null, 'management');
    await seed('舊值 master_lease', orgB, 'lease', 'master_lease', false, 'sublease');
    await seed('舊值 master_lease，沒有合約', orgB, 'lease', 'master_lease', null, 'sublease');
    await seed('業者的自管，承租人是包租業者', orgB, 'lease', 'self_managed', true, 'master_lease');
    before = Number((await o.query<{ n: string }>('SELECT count(*) AS n FROM org.cases')).rows[0].n);

    const sql = await readFile(path.join(MIGRATIONS_DIR, '0077_case_kind.sql'), 'utf8');
    await o.query('BEGIN');
    try {
      await o.query('SET LOCAL ROLE app_owner');
      await o.query(sql);
      await o.query('COMMIT');
    } catch (error) {
      await o.query('ROLLBACK');
      throw error;
    }
  });
  afterAll(() => dbh.close());

  it('遷移前後案件的筆數相同', async () => {
    const after = Number((await dbh.owner.query<{ n: string }>('SELECT count(*) AS n FROM org.cases')).rows[0].n);
    expect(after).toBe(before);
    expect(before).toBe(expected.size);
  });

  it('既有案件照 ADR-0030 決議 2 的對照表歸類', async () => {
    const { rows } = await dbh.owner.query<{ title: string; case_kind: string }>('SELECT title, case_kind FROM org.cases');
    expect(Object.fromEntries(rows.map((r) => [r.title, r.case_kind]))).toEqual(Object.fromEntries(expected));
  });

  it('套用後 app_rw 寫入舊欄位組合，trigger 補出案件種類', async () => {
    const id = newUlid();
    const client = await dbh.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.org_id', $1, true)`, [orgB]);
      await client.query(`INSERT INTO org.cases (id, org_id, kind, state, business_type, title) VALUES ($1, $2, 'lease', 'draft', 'master_lease', '新舊值')`, [id, orgB]);
      const { rows } = await client.query<{ case_kind: string }>('SELECT case_kind FROM org.cases WHERE id = $1', [id]);
      expect(rows[0].case_kind).toBe('sublease');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
