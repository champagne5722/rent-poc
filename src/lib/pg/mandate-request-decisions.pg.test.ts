import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgDriver } from './drivers';
import { createPgTestDatabase, type PgTestDatabase } from './pg-database-kit';
import { newUlid } from './ulid';
import { createWithTx, type WithTx } from './with-tx';

// MIL-210 前半資料段：接受、未接受、結束與收回的併發，在真實 PostgreSQL 上驗證。
// 四個動作都先 FOR UPDATE 同一列，後到的請求看到新狀態，回 not_pending。PGlite 是單一連線，測不出鎖，所以放在這裡。
// 只在有 TEST_DATABASE_URL 時執行，說明見 pg-integration.test.ts。

const adminUrl = process.env.TEST_DATABASE_URL;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

describe.skipIf(!adminUrl)('申請的接受、未接受與結束（真實 PostgreSQL）', () => {
  let dbh: PgTestDatabase;
  let withTx: WithTx;
  const practiceOrg = newUlid();
  const ownerOrg = newUlid();
  const practiceParty = newUlid();
  const ownerParty = newUlid();
  const entityId = newUlid();
  const managerEmployment = newUlid();
  const now = new Date();
  const submittedAt = new Date(now.getTime() - 3_600_000);

  const asPractice = <T>(fn: Parameters<WithTx>[1]) => withTx({ kind: 'org', orgId: practiceOrg, partyId: practiceParty }, fn as never) as Promise<T>;
  const asOwner = <T>(fn: Parameters<WithTx>[1]) => withTx({ kind: 'org', orgId: ownerOrg, partyId: ownerParty }, fn as never) as Promise<T>;

  beforeAll(async () => {
    dbh = await createPgTestDatabase(adminUrl!, 8);
    withTx = createWithTx(pgDriver(dbh.pool));
    await dbh.owner.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '甲業者', 'practice'), ($2, '王先生', 'owner')`, [practiceOrg, ownerOrg]);
    await dbh.owner.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'p@example.com', 'p'), ($2, 'o@example.com', 'o')`, [practiceParty, ownerParty]);
    for (const [orgId, partyId] of [[practiceOrg, practiceParty], [ownerOrg, ownerParty]]) {
      const userId = newUlid();
      await dbh.owner.query(`INSERT INTO control.users (id, party_id) VALUES ($1, $2)`, [userId, partyId]);
      await dbh.owner.query(`INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'admin')`, [newUlid(), orgId, userId]);
    }
    await dbh.owner.query(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, '12345678', '甲業者有限公司', 'company', $2)`, [entityId, practiceOrg]);
    await dbh.owner.query(`INSERT INTO registry.practice_licenses (id, entity_id, kind, state) VALUES ($1, $2, 'management', 'verified')`, [newUlid(), entityId]);
    const managerParty = newUlid();
    const practitioner = newUlid();
    await dbh.owner.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'm@example.com', 'm')`, [managerParty]);
    await dbh.owner.query(
      `INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until, state)
       VALUES ($1, $2, 'rental_housing_manager', '112', '內授營', '100001', 'rental_housing_manager:112:內授營:100001', '2024-03-01', '2036-03-01', 'verified')`,
      [practitioner, managerParty],
    );
    await dbh.owner.query(
      `INSERT INTO registry.practitioner_employments (id, practitioner_id, certificate_key, certificate_kind, entity_id, state, started_on)
       VALUES ($1, $2, 'rental_housing_manager:112:內授營:100001', 'rental_housing_manager', $3, 'verified', '2026-01-01')`,
      [managerEmployment, practitioner, entityId],
    );
  });

  afterAll(async () => {
    await dbh?.close();
  });

  async function newUnit(): Promise<string> {
    const unitId = newUlid();
    await asOwner(async (tx) => {
      await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [newUlid(), unitId, '某地址']);
      await tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [newUlid(), ownerOrg, unitId, '物件', '某地址']);
    });
    return unitId;
  }

  /** 一份已送出、待業者接受的申請；accepted 為 true 時直接寫成已接受。 */
  async function request(accepted = false): Promise<string> {
    const id = newUlid();
    const unit = await newUnit();
    await dbh.owner.query(
      `INSERT INTO registry.mandate_requests
         (id, kind, practice_org_id, entity_id, created_by_party_id, code_hash, status, created_at, link_expires_at, owner_org_id, claimed_at, submitted_at, accepted_at, manager_employment_id)
       VALUES ($1, 'management', $2, $3, $4, $5, $6, $7, $8, $9, $7, $10, $11, $12)`,
      [
        id, practiceOrg, entityId, practiceParty, hash(id), accepted ? 'accepted' : 'pending_practice', new Date(now.getTime() - 7_200_000),
        new Date(now.getTime() + 86_400_000), ownerOrg, submittedAt, accepted ? submittedAt : null, accepted ? managerEmployment : null,
      ],
    );
    await dbh.owner.query('INSERT INTO registry.mandate_request_units (request_id, rental_unit_id) VALUES ($1, $2)', [id, unit]);
    return id;
  }

  type Out = { rows: Array<{ outcome: string; ended_by?: string | null }> };
  const accept = (id: string) => asPractice<Out>((tx) => tx.query('SELECT * FROM registry.accept_mandate_request($1, $2, $3, $4)', [id, managerEmployment, newUlid(), now]));
  const decline = (id: string) => asPractice<Out>((tx) => tx.query('SELECT * FROM registry.decline_mandate_request($1, $2, $3)', [id, newUlid(), now]));
  const withdraw = (id: string) => asOwner<Out>((tx) => tx.query('SELECT * FROM registry.withdraw_mandate_request($1, $2, $3)', [id, newUlid(), now]));
  const endByPractice = (id: string) => asPractice<Out>((tx) => tx.query('SELECT * FROM registry.end_mandate_request($1, $2, $3)', [id, newUlid(), now]));
  const endByOwner = (id: string) => asOwner<Out>((tx) => tx.query('SELECT * FROM registry.end_mandate_request($1, $2, $3)', [id, newUlid(), now]));
  const status = async (id: string) => (await dbh.owner.query(`SELECT status, closed_by FROM registry.mandate_requests WHERE id = $1`, [id])).rows[0] as { status: string; closed_by: string | null };
  const notificationCount = async (id: string) =>
    Number((await dbh.owner.query(`SELECT count(*) AS n FROM org.notifications WHERE link_path = $1`, [`/requests/${id}`])).rows[0].n);

  it('業者接受與屋主收回同時發生：只有一個成功，另一個回 not_pending，通知只寫一則', async () => {
    const id = await request();
    const results = await Promise.all([accept(id), withdraw(id)]);
    const outcomes = results.map((r) => r.rows[0].outcome).sort();
    expect(outcomes.includes('not_pending')).toBe(true);
    expect(outcomes.filter((o) => o === 'accepted' || o === 'withdrawn')).toHaveLength(1);
    expect((await status(id)).status).toBe(results[0].rows[0].outcome === 'accepted' ? 'accepted' : 'withdrawn');
    expect(await notificationCount(id)).toBe(1);
  });

  it('業者接受與不接受同時發生：只有一個成功', async () => {
    const id = await request();
    const results = await Promise.all([accept(id), decline(id)]);
    const outcomes = results.map((r) => r.rows[0].outcome).sort();
    expect(outcomes).toContain('not_pending');
    expect(outcomes.filter((o) => o === 'accepted' || o === 'declined')).toHaveLength(1);
    expect(await notificationCount(id)).toBe(1);
  });

  it('業者與屋主同時結束：只有一個成功，closed_by 是成功的那一方，只通知另一方一次', async () => {
    const id = await request(true);
    const [byPractice, byOwner] = await Promise.all([endByPractice(id), endByOwner(id)]);
    const outcomes = [byPractice.rows[0].outcome, byOwner.rows[0].outcome].sort();
    expect(outcomes).toEqual(['ended', 'not_pending']);
    expect((await status(id)).closed_by).toBe(byPractice.rows[0].outcome === 'ended' ? 'practice' : 'owner');
    expect(await notificationCount(id)).toBe(1);
  });

  it('兩個接受同時發生：只有一個成功', async () => {
    const id = await request();
    const results = await Promise.all([accept(id), accept(id)]);
    expect(results.map((r) => r.rows[0].outcome).sort()).toEqual(['accepted', 'not_pending']);
    expect(await notificationCount(id)).toBe(1);
  });

  it('接受時暫時切到屋主組織寫通知，函式回來後脈絡切回業者，通知只寫進屋主的組織', async () => {
    const id = await request();
    const after = await asPractice<{ org: string; outcome: string }>(async (tx) => {
      const r = await tx.query<{ outcome: string }>('SELECT * FROM registry.accept_mandate_request($1, $2, $3, $4)', [id, managerEmployment, newUlid(), now]);
      const org = (await tx.query<{ v: string }>(`SELECT current_setting('app.org_id', true) AS v`)).rows[0].v;
      return { org, outcome: r.rows[0].outcome };
    });
    expect(after).toEqual({ org: practiceOrg, outcome: 'accepted' });
    const mine = await asPractice<{ rows: unknown[] }>((tx) => tx.query(`SELECT 1 FROM org.notifications WHERE link_path = $1`, [`/requests/${id}`]));
    expect(mine.rows).toEqual([]);
    const theirs = await asOwner<{ rows: Array<{ kind: string }> }>((tx) => tx.query(`SELECT kind FROM org.notifications WHERE link_path = $1`, [`/requests/${id}`]));
    expect(theirs.rows).toEqual([{ kind: 'request.accepted' }]);
  });
});
