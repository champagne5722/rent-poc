import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgDriver } from './drivers';
import { createPgTestDatabase, type PgTestDatabase } from './pg-database-kit';
import { newUlid } from './ulid';
import { createWithTx, type WithTx } from './with-tx';

// 申請的併發與組織脈絡切換，在真實 PostgreSQL 上驗證（MIL-206）。PGlite 的案例在 mandate-requests-schema.test.ts。
// 只在有 TEST_DATABASE_URL 時執行，說明見 pg-integration.test.ts。

const adminUrl = process.env.TEST_DATABASE_URL;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

describe.skipIf(!adminUrl)('申請（真實 PostgreSQL）', () => {
  let dbh: PgTestDatabase;
  let withTx: WithTx;
  const practiceOrg = newUlid();
  const ownerOrg = newUlid();
  const practiceParty = newUlid();
  const ownerParty = newUlid();
  const entityId = newUlid();
  const now = new Date();

  const asPractice = <T>(fn: Parameters<WithTx>[1]) => withTx({ kind: 'org', orgId: practiceOrg, partyId: practiceParty }, fn as never) as Promise<T>;
  const asOwner = <T>(fn: Parameters<WithTx>[1]) => withTx({ kind: 'org', orgId: ownerOrg, partyId: ownerParty }, fn as never) as Promise<T>;

  beforeAll(async () => {
    dbh = await createPgTestDatabase(adminUrl!, 6);
    withTx = createWithTx(pgDriver(dbh.pool));
    await dbh.owner.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '甲業者', 'practice'), ($2, '王先生', 'owner')`, [practiceOrg, ownerOrg]);
    await dbh.owner.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'p@example.com', 'p'), ($2, 'o@example.com', 'o')`, [practiceParty, ownerParty]);
    await dbh.owner.query(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, '12345678', '甲業者有限公司', 'company', $2)`, [entityId, practiceOrg]);
    await dbh.owner.query(`INSERT INTO registry.practice_licenses (id, entity_id, kind, state) VALUES ($1, $2, 'management', 'verified')`, [newUlid(), entityId]);
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

  async function boundRequest(): Promise<string> {
    const id = newUlid();
    const code = `code-${id}`;
    await asPractice((tx) => tx.query('SELECT * FROM registry.create_mandate_request($1, $2, $3, NULL, $4)', [id, 'management', hash(code), now]));
    const claimed = await asOwner<{ rows: Array<{ outcome: string }> }>((tx) => tx.query('SELECT * FROM registry.claim_mandate_request($1, $2)', [hash(code), now]));
    expect(claimed.rows[0].outcome).toBe('claimed');
    return id;
  }

  const submit = (id: string, units: string[]) =>
    asOwner<{ rows: Array<{ outcome: string }> }>((tx) => tx.query('SELECT * FROM registry.submit_mandate_request($1, $2::text[], $3, $4)', [id, units, newUlid(), now]));

  it('兩份申請同時送出同一個租賃單位：只有一份成功，另一份被拒', async () => {
    const unit = await newUnit();
    const [a, b] = [await boundRequest(), await boundRequest()];
    const results = await Promise.all([submit(a, [unit]), submit(b, [unit])]);
    expect(results.map((r) => r.rows[0].outcome).sort()).toEqual(['submitted', 'units_occupied']);
  });

  it('送出時暫時切到業者組織寫通知，函式回來後脈絡切回屋主，通知只寫進業者的組織', async () => {
    const unit = await newUnit();
    const id = await boundRequest();
    const after = await asOwner<{ org: string; submitted: string }>(async (tx) => {
      const r = await tx.query<{ outcome: string }>('SELECT * FROM registry.submit_mandate_request($1, $2::text[], $3, $4)', [id, [unit], newUlid(), now]);
      const org = (await tx.query<{ v: string }>(`SELECT current_setting('app.org_id', true) AS v`)).rows[0].v;
      return { org, submitted: r.rows[0].outcome };
    });
    expect(after).toEqual({ org: ownerOrg, submitted: 'submitted' });
    const mine = await asOwner<{ rows: unknown[] }>((tx) => tx.query(`SELECT 1 FROM org.notifications WHERE kind = 'request.submitted'`));
    expect(mine.rows).toEqual([]);
    const theirs = await asPractice<{ rows: Array<{ link_path: string }> }>((tx) => tx.query(`SELECT link_path FROM org.notifications WHERE kind = 'request.submitted' AND link_path = $1`, [`/requests/${id}`]));
    expect(theirs.rows).toHaveLength(1);
  });

  it('app_rw 在真實 PostgreSQL 上不能直接讀申請的表', async () => {
    await expect(asOwner((tx) => tx.query('SELECT * FROM registry.mandate_requests'))).rejects.toThrow(/permission denied/);
    await expect(asPractice((tx) => tx.query('SELECT * FROM registry.mandate_request_units'))).rejects.toThrow(/permission denied/);
  });
});
