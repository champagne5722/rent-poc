import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromPgClient } from '../pg/executor';
import { migrate } from '../pg/migrate';
import { withClusterLock } from '../pg/pg-test-support';
import { MIGRATIONS_DIR } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';

// MIL-111 在真實 PostgreSQL 的驗證：專任排除約束（同一證號最多一筆已驗證的管理人員任職）在併發下成立。
// 兩個營運者同時把同一證號的兩家待驗證任職核對為相符，後提交的必須被擋下，不能兩家都是已驗證。
// 只在有 TEST_DATABASE_URL 時執行，說明見 pg-integration.test.ts。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('專任排除約束：真實 PostgreSQL 併發', () => {
  const dbName = `excl_${Math.random().toString(36).slice(2, 10)}`;
  const urlFor = (db: string) => {
    const u = new URL(adminUrl!);
    u.pathname = `/${db}`;
    return u.toString();
  };
  let admin: Client;
  let second: Client;
  const ids = { entityA: newUlid(), entityB: newUlid(), practitioner: newUlid(), empA: newUlid(), empB: newUlid() };
  const KEY = 'rental_housing_manager:112:內授營:123456';

  beforeAll(async () => {
    const root = new Client({ connectionString: adminUrl });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    admin = new Client({ connectionString: urlFor(dbName) });
    await admin.connect();
    await withClusterLock(adminUrl!, async () => {
      await migrate(fromPgClient(admin), { dir: MIGRATIONS_DIR, runAs: 'app_owner' });
    });
    second = new Client({ connectionString: urlFor(dbName) });
    await second.connect();

    const [orgA, orgB, party] = [newUlid(), newUlid(), newUlid()];
    await admin.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '甲', 'practice'), ($2, '乙', 'practice')`, [orgA, orgB]);
    await admin.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'x@example.com', '王小明')`, [party]);
    await admin.query(
      `INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, '11111111', '甲', 'company', $3), ($2, '22222222', '乙', 'company', $4)`,
      [ids.entityA, ids.entityB, orgA, orgB],
    );
    await admin.query(
      `INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until)
       VALUES ($1, $2, 'rental_housing_manager', '112', '內授營', '123456', $3, '2024-03-01', '2028-03-01')`,
      [ids.practitioner, party, KEY],
    );
    await admin.query(
      `INSERT INTO registry.practitioner_employments (id, practitioner_id, certificate_key, certificate_kind, entity_id, started_on)
       VALUES ($1, $3, $5, 'rental_housing_manager', $4, '2026-01-01'), ($2, $3, $5, 'rental_housing_manager', $6, '2026-01-01')`,
      [ids.empA, ids.empB, ids.practitioner, ids.entityA, KEY, ids.entityB],
    );
  });
  afterAll(async () => {
    await second.end();
    await admin.end();
    const root = new Client({ connectionString: adminUrl });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('同時核對兩家相符：後提交的拿到 23505，只有一家是已驗證', async () => {
    await admin.query('BEGIN');
    await admin.query(`UPDATE registry.practitioner_employments SET state = 'verified' WHERE id = $1`, [ids.empA]);
    await second.query('BEGIN');
    // 第二個交易在第一個提交前會等鎖，提交後唯一索引檢查失敗
    const blocked = second.query(`UPDATE registry.practitioner_employments SET state = 'verified' WHERE id = $1`, [ids.empB]);
    const outcome = blocked.then(
      () => 'ok',
      (error: { code?: string }) => error.code,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await admin.query('COMMIT');
    expect(await outcome).toBe('23505');
    await second.query('ROLLBACK');

    const { rows } = await admin.query<{ id: string; state: string }>(`SELECT id, state FROM registry.practitioner_employments WHERE certificate_key = $1 ORDER BY id`, [KEY]);
    expect(rows.filter((r) => r.state === 'verified')).toHaveLength(1);
  });

  it('經紀人員不受約束：同一證號兩家都是已驗證', async () => {
    const broker = 'real_estate_broker:112:北市經:555555';
    const practitioner = newUlid();
    const party = newUlid();
    await admin.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'y@example.com', '李小華')`, [party]);
    await admin.query(
      `INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until)
       VALUES ($1, $2, 'real_estate_broker', '112', '北市經', '555555', $3, '2024-03-01', '2028-03-01')`,
      [practitioner, party, broker],
    );
    await admin.query(
      `INSERT INTO registry.practitioner_employments (id, practitioner_id, certificate_key, certificate_kind, entity_id, started_on, state, consent_required)
       VALUES ($1, $3, $4, 'real_estate_broker', $5, '2026-01-01', 'verified', false), ($2, $3, $4, 'real_estate_broker', $6, '2026-01-01', 'verified', true)`,
      [newUlid(), newUlid(), practitioner, broker, ids.entityA, ids.entityB],
    );
    const { rows } = await admin.query(`SELECT 1 FROM registry.practitioner_employments WHERE certificate_key = $1 AND state = 'verified'`, [broker]);
    expect(rows).toHaveLength(2);
  });
});
