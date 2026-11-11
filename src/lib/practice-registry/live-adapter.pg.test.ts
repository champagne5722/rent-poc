import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromPgClient } from '../pg/executor';
import { migrate } from '../pg/migrate';
import { withClusterLock } from '../pg/pg-test-support';
import { MIGRATIONS_DIR } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';

// MIL-113 在真實 PostgreSQL 的驗證：registry.signing_view 的關係判定。
// 定義者函式讀 org.case_members 時，FORCE RLS 必須只讓它看到呼叫者自己組織的列。
// 只在有 TEST_DATABASE_URL 時執行，說明見 pg-integration.test.ts。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('registry.signing_view：真實 PostgreSQL', () => {
  const dbName = `live_${Math.random().toString(36).slice(2, 10)}`;
  const urlFor = (db: string) => {
    const u = new URL(adminUrl!);
    u.pathname = `/${db}`;
    return u.toString();
  };
  let admin: Client;
  const id = {
    practiceOrg: newUlid(), entity: newUlid(), party: newUlid(), practitioner: newUlid(), employment: newUlid(),
    own: newUlid(), selecting: newUlid(), unrelated: newUlid(), bound: newUlid(), contract: newUlid(), boundContract: newUlid(),
  };

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
    await admin.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '甲', 'practice')`, [id.practiceOrg]);
    for (const [org, name] of [[id.selecting, '選人'], [id.unrelated, '無關'], [id.bound, '綁定']]) {
      await admin.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, $2, 'owner')`, [org, name]);
    }
    await admin.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'x@example.com', '王小明')`, [id.party]);
    await admin.query(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, '11111111', '甲', 'company', $2)`, [id.entity, id.practiceOrg]);
    await admin.query(`INSERT INTO registry.practice_licenses (id, entity_id, kind, state) VALUES ($1, $2, 'management', 'verified')`, [newUlid(), id.entity]);
    const key = 'rental_housing_manager:112:內授營:123456';
    await admin.query(
      `INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until, state)
       VALUES ($1, $2, 'rental_housing_manager', '112', '內授營', '123456', $3, '2024-03-01', '2030-03-01', 'verified')`,
      [id.practitioner, id.party, key],
    );
    await admin.query(
      `INSERT INTO registry.practitioner_employments (id, practitioner_id, certificate_key, certificate_kind, entity_id, state, started_on)
       VALUES ($1, $2, $3, 'rental_housing_manager', $4, 'verified', '2026-01-01')`,
      [id.employment, id.practitioner, key, id.entity],
    );
    // 選人中的組織有一份草稿合約。綁定的組織另有一份合約，指派指向這個執業主體
    for (const [org, contract] of [[id.selecting, id.contract], [id.bound, id.boundContract]]) {
      await admin.query(`INSERT INTO org.contracts (id, org_id, property_id, contract_type, fields, signature_fields) VALUES ($1, $2, NULL, 'lease', '{}'::jsonb, '[]'::jsonb)`, [contract, org]);
    }
    await admin.query(
      `INSERT INTO org.contract_practitioner_assignments (id, org_id, contract_id, slot, entity_id, practitioner_id) VALUES ($1, $2, $3, 'a', $4, $5)`,
      [newUlid(), id.bound, id.boundContract, id.entity, id.employment],
    );
  });
  afterAll(async () => {
    await admin.end();
    const root = new Client({ connectionString: adminUrl });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  type View = { practitioners: Array<{ certificate_no: unknown; certificate_no_masked: string; account_email: string; employment_id: string }> };
  async function viewAs(orgId: string): Promise<View> {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE app_rw');
      await admin.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      const { rows } = await admin.query('SELECT registry.signing_view($1, NULL) AS view', [id.entity]);
      return rows[0].view;
    } finally {
      await admin.query('ROLLBACK');
    }
  }

  it('自己的組織列出時看得到證號原文，email 遮罩（MIL-200）', async () => {
    const view = await viewAs(id.practiceOrg);
    expect(view.practitioners).toHaveLength(1);
    expect(view.practitioners[0].certificate_no).toEqual({ year: '112', word: '內授營', serial: '123456' });
    expect(view.practitioners[0].account_email).toBe('x***@example.com');
  });

  it('自己的組織用任職 ID 查單筆，拿到真實 email；別的組織查同一個任職 ID 是空的', async () => {
    const single = async (orgId: string): Promise<View> => {
      await admin.query('BEGIN');
      try {
        await admin.query('SET LOCAL ROLE app_rw');
        await admin.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
        const { rows } = await admin.query('SELECT registry.signing_view(NULL, $1) AS view', [id.employment]);
        return rows[0].view;
      } finally {
        await admin.query('ROLLBACK');
      }
    };
    expect((await single(id.practiceOrg)).practitioners[0].account_email).toBe('x@example.com');
    expect((await single(id.bound)).practitioners).toEqual([]);
    expect((await single(id.selecting)).practitioners).toEqual([]);
  });

  it('合約指派不再綁定（MIL-200）：指向這個執業主體的合約指派什麼都讀不到', async () => {
    expect((await viewAs(id.bound)).practitioners).toEqual([]);
  });

  it('只有草稿合約的組織什麼都讀不到（selecting 已移除）', async () => {
    expect((await viewAs(id.selecting)).practitioners).toEqual([]);
  });

  it('沒有合約的組織什麼都看不到', async () => {
    expect((await viewAs(id.unrelated)).practitioners).toEqual([]);
  });

  it('app_rw 直接查 registry 的表被拒', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE app_rw');
      await expect(admin.query('SELECT 1 FROM registry.practitioners')).rejects.toThrow(/permission denied/);
    } finally {
      await admin.query('ROLLBACK');
    }
  });
});
