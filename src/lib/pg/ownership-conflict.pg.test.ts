import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import seedJson from '../registry/section-code/seed.json';
import type { SectionCodeSeed } from '../registry/section-code/types';
import { PLATFORM_ORG_ID } from '../auth/config';
import { noticesFor } from '../ownership/conflict';
import { decideConflict, precheckConflict } from '../ownership/conflict-repository';
import { pgDriver } from './drivers';
import { createPgTestDatabase, type PgTestDatabase } from './pg-database-kit';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-208：同一個鍵的競態與並存約束，在真實 PostgreSQL 上（PGlite 只有一條連線，測不到同時寫入）。
// 只在有 TEST_DATABASE_URL 時執行，說明見 pg-integration.test.ts。案例的資料準備與 ownership-conflict.test.ts 相同。

const adminUrl = process.env.TEST_DATABASE_URL;
const seed = seedJson as SectionCodeSeed;
const plain = seed.sections.find((s) => !s.canceled && s.aliasTownCodes.length === 0)!;
const k = { city: plain.cityCode, town: plain.townCode, section: plain.code };

describe.skipIf(!adminUrl)('同一個鍵的建議鎖與並存約束（真實 PostgreSQL）', () => {
  let dbh: PgTestDatabase;
  let withTx: WithTx;
  const operatorId = newUlid();
  const orgs = [newUlid(), newUlid(), newUlid()];
  const parties = [newUlid(), newUlid(), newUlid()];

  beforeAll(async () => {
    dbh = await createPgTestDatabase(adminUrl!, 8);
    withTx = createWithTx(pgDriver(dbh.pool));
    await dbh.owner.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '甲', 'owner'), ($2, '乙', 'owner'), ($3, '丙', 'owner')`, orgs);
    for (const [i, partyId] of parties.entries()) {
      await dbh.owner.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)`, [partyId, `${partyId.toLowerCase()}@example.com`, `成員${i}`]);
    }
    const opParty = newUlid();
    await dbh.owner.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'op@example.com', '營運者')`, [opParty]);
    await dbh.owner.query(`INSERT INTO control.users (id, party_id) VALUES ($1, $2)`, [operatorId, opParty]);
    await dbh.owner.query(`INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'admin')`, [newUlid(), PLATFORM_ORG_ID, operatorId]);
  });

  afterAll(async () => {
    await dbh?.close();
  });

  const asMember = <T>(i: number, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId: orgs[i], partyId: parties[i] }, fn);
  const asOperatorIn = <T>(orgId: string, ticket: string, fn: (tx: OrgTx) => Promise<T>) =>
    withTx({ kind: 'operator', operatorId, orgId, ticketId: ticket }, (tx) => fn(tx as OrgTx));

  /** 組織 i 登錄鍵並送件，回傳項目編號。 */
  async function submitted(i: number, building: string) {
    const anchorId = newUlid();
    const unitId = newUlid();
    await asMember(i, async (tx) => {
      await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [anchorId, unitId, '某地址']);
      await tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [newUlid(), orgs[i], unitId, '物件', '某地址']);
      await tx.query('SELECT * FROM registry.assign_anchor_key($1, $2, $3, $4, $5, NULL, $6, $7)', [anchorId, k.city, k.town, k.section, building, newUlid(), newUlid()]);
    });
    const itemId = newUlid();
    const subId = newUlid();
    const { rows } = await asMember(i, (tx) =>
      tx.query<{ node_id: string }>('SELECT * FROM registry.submit_ownership_transcript($1, $2, $3, $4, $5, $6, false, NULL, NULL, NULL, NULL, $7, $8, 1, $9, $10)', [
        anchorId,
        newUlid(),
        subId,
        itemId,
        '王大明',
        new Date('2026-11-09T00:00:00Z'),
        `org/${orgs[i]}/transcripts/${subId}.pdf`,
        'a'.repeat(64),
        'application/pdf',
        'x.pdf',
      ]),
    );
    return { itemId, nodeId: rows[0].node_id, anchorId };
  }

  const decide = (i: number, itemId: string) =>
    asOperatorIn(orgs[i], `desk:decide:${itemId}`, async (tx) => {
      const { rows } = await tx.query<{ outcome: string }>('SELECT * FROM registry.decide_ownership_check($1, true, true, $2, $3, $4)', [itemId, '王○明', '相符', newUlid()]);
      return rows[0].outcome;
    });

  const keyRows = async (building: string) =>
    (await dbh.owner.query('SELECT org_id, coexist_conflict_id FROM registry.verified_ownership_keys WHERE building_no = $1', [building.padStart(5, '0')])).rows;

  it('兩個項目同時判定同一個鍵：只有一個已驗證，另一個進入衝突', async () => {
    const a = await submitted(0, '7001');
    const b = await submitted(1, '7001');
    const results = await Promise.all([decide(0, a.itemId), decide(1, b.itemId)]);
    expect([...results].sort()).toEqual(['held', 'verified']);
    expect(await keyRows('7001')).toHaveLength(1);
    const conflicts = (await dbh.owner.query('SELECT item_id, status FROM registry.ownership_conflicts WHERE item_id = ANY($1)', [[a.itemId, b.itemId]])).rows;
    expect(conflicts).toHaveLength(1);
    // 被停住的那一個，節點仍是待驗證
    const heldItem = results[0] === 'held' ? { i: 0, ...a } : { i: 1, ...b };
    const node = await asMember(heldItem.i, async (tx) => (await tx.query<{ status: string }>('SELECT status FROM org.ownership_nodes WHERE id = $1', [heldItem.nodeId])).rows[0]);
    expect(node.status).toBe('pending_verification');
  });

  it('三個項目同時判定同一個鍵：一個已驗證，兩個進入衝突', async () => {
    const items = [await submitted(0, '7002'), await submitted(1, '7002'), await submitted(2, '7002')];
    const results = await Promise.all(items.map((it, i) => decide(i, it.itemId)));
    expect(results.filter((r) => r === 'verified')).toHaveLength(1);
    expect(results.filter((r) => r === 'held')).toHaveLength(2);
    expect(await keyRows('7002')).toHaveLength(1);
  });

  it('平台脈絡的偵測與登錄方脈絡的判定同時進行：仍然只有一個已驗證', async () => {
    const a = await submitted(0, '7003');
    const b = await submitted(1, '7003');
    const platform = () =>
      withTx({ kind: 'operator', operatorId, orgId: PLATFORM_ORG_ID, ticketId: 'desk:test' }, (tx) =>
        precheckConflict(tx as OrgTx, b.itemId, { keyMatch: true, holderMatch: true, holderMasked: '王○明', reason: '相符' }, newUlid()),
      );
    const [first, second] = await Promise.all([decide(0, a.itemId), platform()]);
    expect(first).toBe('verified');
    // 偵測在 A 提交之前或之後都可能執行；回 clear 時，B 之後的判定會被停住
    if (second === 'clear') expect(await decide(1, b.itemId)).toBe('held');
    expect(await keyRows('7003')).toHaveLength(1);
  });

  it('同時決定同一個個案：只有一個成功，另一個回 already_decided', async () => {
    const a = await submitted(0, '7004');
    const b = await submitted(1, '7004');
    expect(await decide(0, a.itemId)).toBe('verified');
    expect(await decide(1, b.itemId)).toBe('held');
    const run = () =>
      asOperatorIn(orgs[1], `desk:decide:${b.itemId}`, (tx) =>
        decideConflict(tx, b.itemId, { decision: 'coexist', reason: '共有', basis: null }, newUlid(), noticesFor('coexist', null)),
      );
    const results = await Promise.all([run(), run()]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['already_decided', 'coexist']);
    const rows = await keyRows('7004');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.coexist_conflict_id !== null)).toBe(true);
  });

  it('資料庫約束：沒有並存決定時，同一個鍵不能有兩列（兩個連線同時寫）', async () => {
    const a = await submitted(0, '7005');
    expect(await decide(0, a.itemId)).toBe('verified');
    const dup = (org: string) =>
      dbh.owner.query(
        `INSERT INTO registry.verified_ownership_keys (node_id, org_id, anchor_id, city_code, town_code, section_code, building_no, sub_no)
         SELECT $1, $2, anchor_id, city_code, town_code, section_code, building_no, sub_no FROM registry.verified_ownership_keys WHERE building_no = '07005'`,
        [newUlid(), org],
      );
    await expect(dup(orgs[1])).rejects.toThrow(/已有其他已驗證的節點|duplicate key/);
    expect(await keyRows('7005')).toHaveLength(1);
  });
});
