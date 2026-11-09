import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromPgClient } from '../pg/executor';
import { migrate } from '../pg/migrate';
import { withClusterLock } from '../pg/pg-test-support';
import { MIGRATIONS_DIR } from '../pg/test-harness';
import { newUlid } from '../pg/ulid';

// MIL-186 在真實 PostgreSQL 的驗證：專任判定在寫入函式內，app_rw 沒有單獨的探測入口。
// PGlite 不完整模擬角色與函式權限，所以授權的收回、定義者函式呼叫內部函式、阻擋時不寫列，都在這裡再驗一次。
// 只在有 TEST_DATABASE_URL 時執行，說明見 pg-integration.test.ts。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('專任判定在寫入函式內：真實 PostgreSQL', () => {
  const dbName = `exclw_${Math.random().toString(36).slice(2, 10)}`;
  const urlFor = (db: string) => {
    const u = new URL(adminUrl!);
    u.pathname = `/${db}`;
    return u.toString();
  };
  let admin: Client;
  const verifiedKey = 'rental_housing_manager:112:內授營:123456';
  const brokerKey = 'real_estate_broker:112:北市經:654321';
  const id = {
    orgA: newUlid(), entityA: newUlid(), partyA: newUlid(), userA: newUlid(),
    orgB: newUlid(), entityB: newUlid(), partyB: newUlid(), userB: newUlid(),
    ownerOrg: newUlid(), partyO: newUlid(), userO: newUlid(),
  };

  async function person(org: string, party: string, user: string, email: string) {
    await admin.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $2)`, [party, email]);
    await admin.query(`INSERT INTO control.users (id, party_id) VALUES ($1, $2)`, [user, party]);
    await admin.query(`INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'admin')`, [newUlid(), org, user]);
  }
  async function verifiedEmployment(entity: string, party: string, kind: string, key: string, serial: string, word: string) {
    const practitioner = newUlid();
    await admin.query(
      `INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until, state)
       VALUES ($1, $2, $3, '112', $4, $5, $6, '2024-03-01', '2030-03-01', 'verified')`,
      [practitioner, party, kind, word, serial, key],
    );
    await admin.query(
      `INSERT INTO registry.practitioner_employments (id, practitioner_id, certificate_key, certificate_kind, entity_id, state, started_on)
       VALUES ($1, $2, $3, $4, $5, 'verified', '2024-01-01')`,
      [newUlid(), practitioner, key, kind, entity],
    );
  }

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
    for (const [org, name, kind] of [[id.orgA, '甲', 'practice'], [id.orgB, '乙', 'practice'], [id.ownerOrg, '屋主', 'owner']]) {
      await admin.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, $2, $3)`, [org, name, kind]);
    }
    await admin.query(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, '11111111', '甲', 'company', $2)`, [id.entityA, id.orgA]);
    await admin.query(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, '22222222', '乙', 'company', $2)`, [id.entityB, id.orgB]);
    await person(id.orgA, id.partyA, id.userA, 'a@example.com');
    await person(id.orgB, id.partyB, id.userB, 'b@example.com');
    await person(id.ownerOrg, id.partyO, id.userO, 'o@example.com');
    // 甲的管理人員與經紀人員都在甲已驗證在職
    const partyA2 = newUlid();
    await admin.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'a2@example.com', 'a2')`, [partyA2]);
    await verifiedEmployment(id.entityA, id.partyA, 'rental_housing_manager', verifiedKey, '123456', '內授營');
    await verifiedEmployment(id.entityA, partyA2, 'real_estate_broker', brokerKey, '654321', '北市經');
  });
  afterAll(async () => {
    await admin.end();
    const root = new Client({ connectionString: adminUrl });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  /** 以 app_rw 身分在交易內執行，結束後一律回滾。before 在換回管理者身分之後執行，用來檢查有沒有寫列。 */
  async function asAppRw<T>(org: string, party: string, fn: () => Promise<T>, after?: () => Promise<void>): Promise<T> {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE app_rw');
      await admin.query(`SELECT set_config('app.org_id', $1, true), set_config('app.party_id', $2, true)`, [org, party]);
      const result = await fn();
      if (after) {
        await admin.query('RESET ROLE');
        await after();
      }
      return result;
    } finally {
      await admin.query('ROLLBACK');
    }
  }
  const submit = (key: string) => {
    const [kind, year, word, serial] = key.split(':');
    return admin.query('SELECT * FROM registry.submit_practitioner($1, $2, $3, $4, $5, $6::date, $7::date, NULL, $8, $9)', [
      newUlid(), kind, year, word, serial, '2024-03-01', '2030-03-01', 'pending', newUlid(),
    ]);
  };

  it('employment_exclusivity_facts 已移除，exclusivity_verdict 不授權給 app_rw', async () => {
    const { rows } = await admin.query(
      `SELECT p.proname,
              has_function_privilege('app_rw', p.oid, 'EXECUTE') AS app_rw,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_has
         FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
        WHERE s.nspname = 'registry' AND p.proname IN ('employment_exclusivity_facts', 'exclusivity_verdict')`,
    );
    expect(rows).toEqual([{ proname: 'exclusivity_verdict', app_rw: false, public_has: false }]);
  });

  it('app_rw 直接呼叫兩個查詢函式都被拒，真實與不存在的證書鍵錯誤相同', async () => {
    for (const [sql, code] of [
      ['SELECT * FROM registry.employment_exclusivity_facts($1)', '42883'],
      ['SELECT registry.exclusivity_verdict($1, \'rental_housing_manager\', NULL)', '42501'],
    ] as const) {
      const errors: unknown[] = [];
      for (const key of [verifiedKey, 'rental_housing_manager:112:內授營:999999']) {
        errors.push(await asAppRw(id.orgB, id.partyB, async () => {
          await admin.query('SAVEPOINT s');
          try {
            await admin.query(sql, [key]);
            return 'ok';
          } catch (error) {
            return { code: (error as { code?: string }).code, message: (error as Error).message };
          } finally {
            await admin.query('ROLLBACK TO SAVEPOINT s');
          }
        }));
      }
      expect(errors[0], sql).toMatchObject({ code });
      expect(errors[1], sql).toEqual(errors[0]);
    }
  });

  it('第一次登錄：管理人員的證書鍵在別家有已驗證在職時被阻擋，什麼都不寫，回應只有結論', async () => {
    const written = async () => expect((await admin.query('SELECT 1 FROM registry.practitioners WHERE party_id = $1', [id.partyB])).rows).toHaveLength(0);
    const row = await asAppRw(id.orgB, id.partyB, async () => (await submit(verifiedKey)).rows[0], written);
    expect(row).toEqual({ practitioner_id: null, item_id: null, state: null, outcome: 'blocked' });
  });

  it('不存在的證書鍵：登錄成功', async () => {
    const row = await asAppRw(id.orgB, id.partyB, async () => (await submit('rental_housing_manager:112:內授營:999999')).rows[0]);
    expect(row).toMatchObject({ state: 'pending', outcome: 'registered' });
  });

  it('經紀人員的證書鍵在別家有已驗證在職：登錄不被阻擋，建立任職時要求同意書，且列有寫入', async () => {
    const row = await asAppRw(id.orgB, id.partyB, async () => {
      const registered = (await submit(brokerKey)).rows[0] as { practitioner_id: string; outcome: string };
      expect(registered.outcome).toBe('registered');
      const created = await admin.query('SELECT * FROM registry.create_employment($1, $2, $3::date, $4)', [newUlid(), registered.practitioner_id, '2026-11-10', newUlid()]);
      return created.rows[0];
    });
    expect(row).toMatchObject({ outcome: 'created', consent_required: true });
  });

  it('屋主組織與不是成員的人不能呼叫寫入函式', async () => {
    for (const [org, party] of [[id.ownerOrg, id.partyO], [id.orgA, id.partyB]] as const) {
      const code = await asAppRw(org, party, async () => {
        await admin.query('SAVEPOINT s');
        try {
          await submit(verifiedKey);
          return 'ok';
        } catch (error) {
          return (error as { code?: string }).code;
        } finally {
          await admin.query('ROLLBACK TO SAVEPOINT s');
        }
      });
      expect(code).toBe('42501');
    }
  });
});
