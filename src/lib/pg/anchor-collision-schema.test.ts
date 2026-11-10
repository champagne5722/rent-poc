import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import seedJson from '../registry/section-code/seed.json';
import type { SectionCodeSeed } from '../registry/section-code/types';
import { PLATFORM_ORG_ID } from '../auth/config';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-144：撞號送審核台、固定回應、頻率限制。
// 一律以 app_rw 從外部觀察；看 registry 的列、調整設定值或改建立時間時，才用 asRole 換成 app_owner。

const seed = seedJson as SectionCodeSeed;

let testDb: TestDb;
let db: PGliteInterface;
let withTx: WithTx;
const orgA = newUlid();
const orgB = newUlid();
const orgC = newUlid();

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(() => testDb.close());

beforeEach(async () => {
  db = await testDb.fresh();
  withTx = createWithTx(pgliteDriver(db));
  await asRole(db, 'app_owner', () =>
    db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, '甲方管理公司', 'owner'), ($2, '乙方管理公司', 'owner'), ($3, '丙方管理公司', 'owner')`, [
      orgA,
      orgB,
      orgC,
    ]),
  );
});

const owner = <T>(fn: () => Promise<T>) => asRole(db, 'app_owner', fn);

/** 組織 orgId 建一個物件（待驗證錨點加 0000 單位），回傳錨點、單位與物件 ID。 */
async function createProperty(orgId: string, name = '物件') {
  return withTx({ kind: 'org', orgId }, async (tx) => {
    const anchorId = newUlid();
    const unitId = newUlid();
    const propertyId = newUlid();
    await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [anchorId, unitId, '某地址']);
    await tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [
      propertyId,
      orgId,
      unitId,
      name,
      '某地址',
    ]);
    return { anchorId, unitId, propertyId };
  });
}

interface ClaimRow {
  outcome: string;
  item_id: string | null;
  property_id: string | null;
}

const plain = seed.sections.find((s) => !s.canceled && s.aliasTownCodes.length === 0)!;
const k = { city: plain.cityCode, town: plain.townCode, section: plain.code };

async function claim(
  tx: OrgTx,
  anchorId: string,
  building = '1234',
  itemId: string = newUlid(),
): Promise<ClaimRow> {
  const { rows } = await tx.query<ClaimRow>('SELECT * FROM registry.assign_anchor_key($1, $2, $3, $4, $5, NULL, $6)', [
    anchorId,
    k.city,
    k.town,
    k.section,
    building,
    itemId,
  ]);
  return rows[0];
}
const claimAs = (orgId: string, anchorId: string, building = '1234', itemId?: string) =>
  withTx({ kind: 'org', orgId }, (tx) => claim(tx, anchorId, building, itemId));

const setLimit = (n: number) =>
  owner(() => db.query(`UPDATE registry.platform_settings SET int_value = $1 WHERE key = 'anchor_collision_daily_limit'`, [n]));

const itemRows = (sql = '') =>
  owner(async () => (await db.query<Record<string, any>>(`SELECT * FROM registry.review_items ${sql}`)).rows); // eslint-disable-line @typescript-eslint/no-explicit-any

/** A 先登錄一個鍵。 */
async function registrantHolds(building = '1234') {
  const first = await createProperty(orgA, '甲方的物件');
  expect((await claimAs(orgA, first.anchorId, building)).outcome).toBe('keyed');
  return first;
}

describe('設定值', () => {
  it('每個組織 24 小時內的撞號上限預設 50，app_rw 不能直接讀寫', async () => {
    const { rows } = await owner(() => db.query(`SELECT int_value FROM registry.platform_settings WHERE key = 'anchor_collision_daily_limit'`));
    expect(rows).toEqual([{ int_value: 50 }]);
    await expect(db.query('SELECT * FROM registry.platform_settings')).rejects.toThrow(/permission denied/);
    await expect(db.query(`UPDATE registry.platform_settings SET int_value = 9999`)).rejects.toThrow(/permission denied/);
  });
});

describe('registry.assign_anchor_key：沒有撞號', () => {
  it('錨點轉已建號，回 keyed，沒有審核單', async () => {
    const { anchorId } = await createProperty(orgA);
    const result = await claimAs(orgA, anchorId);
    expect(result).toEqual({ outcome: 'keyed', item_id: null, property_id: null });
    expect(await itemRows()).toEqual([]);
  });
});

describe('registry.assign_anchor_key：撞到別的組織', () => {
  it('回 collision_queued 與審核單號；B 的錨點維持待驗證且鍵不進唯一索引；審核單存宣稱的鍵', async () => {
    const first = await registrantHolds();
    const second = await createProperty(orgB, '乙方的物件');
    const itemId = newUlid();
    const result = await claimAs(orgB, second.anchorId, '1234', itemId);
    expect(result).toEqual({ outcome: 'collision_queued', item_id: itemId, property_id: null });

    const anchors = await owner(() =>
      db.query(`SELECT id, status, city_code, building_no FROM registry.anchors WHERE id = ANY($1::text[]) ORDER BY id`, [[first.anchorId, second.anchorId]]),
    );
    const byId = Object.fromEntries((anchors.rows as Array<Record<string, unknown>>).map((r) => [r.id, r]));
    expect(byId[second.anchorId]).toMatchObject({ status: 'pending_verification', city_code: null, building_no: null });
    expect(byId[first.anchorId]).toMatchObject({ status: 'keyed', building_no: '01234' });

    const items = await itemRows();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: itemId, type: 'anchor_collision', subject_type: 'anchor', subject_id: second.anchorId, status: 'open' });
    expect(items[0].payload).toMatchObject({
      claimant_org_id: orgB,
      claimed_key: { city_code: k.city, town_code: k.town, section_code: k.section, building_no: '01234', sub_no: '000' },
    });
  });

  it('回傳的每一欄與錯誤都不含對方的資料', async () => {
    await registrantHolds();
    const second = await createProperty(orgB);
    const result = await claimAs(orgB, second.anchorId);
    expect(Object.keys(result).sort()).toEqual(['item_id', 'outcome', 'property_id']);
    expect(JSON.stringify(result)).not.toMatch(/甲方|A 組織|01234/);
  });

  it('既有登錄方的錨點、物件、通知都不變，也沒有人通知它', async () => {
    const first = await registrantHolds();
    const snapshot = async () =>
      owner(async () => ({
        anchor: (await db.query('SELECT * FROM registry.anchors WHERE id = $1', [first.anchorId])).rows,
        units: (await db.query('SELECT * FROM registry.rental_units WHERE anchor_id = $1', [first.anchorId])).rows,
      }));
    const before = await snapshot();
    const second = await createProperty(orgB);
    await claimAs(orgB, second.anchorId);
    expect(await snapshot()).toEqual(before);
    const notifications = await withTx({ kind: 'org', orgId: orgA }, async (tx) => (await tx.query('SELECT id FROM org.notifications')).rows);
    expect(notifications).toEqual([]);
    const asA = await withTx({ kind: 'org', orgId: orgA }, async (tx) => (await tx.query('SELECT * FROM registry.get_collision_reviews($1::text[])', [[first.unitId]])).rows);
    expect(asA).toEqual([]);
  });

  it('同一個錨點再宣稱另一個撞號的鍵：舊審核單被取代，只剩一張待審', async () => {
    await registrantHolds('1234');
    const another = await createProperty(orgC);
    await claimAs(orgC, another.anchorId, '5555'); // C 自己登錄 5555
    const second = await createProperty(orgB);
    const first = await claimAs(orgB, second.anchorId, '1234');
    const next = await claimAs(orgB, second.anchorId, '5555');
    expect(next.outcome).toBe('collision_queued');
    const items = await itemRows(`WHERE subject_id = '${second.anchorId}' ORDER BY created_at, id`);
    const open = items.filter((i) => i.status === 'open');
    expect(open.map((i) => i.id)).toEqual([next.item_id]);
    expect(items.find((i) => i.id === first.item_id)).toMatchObject({ status: 'resolved', resolution: 'superseded' });
  });

  it('撞號之後改登錄沒人用的鍵：錨點轉已建號，舊審核單被取代', async () => {
    await registrantHolds('1234');
    const second = await createProperty(orgB);
    const queued = await claimAs(orgB, second.anchorId, '1234');
    expect((await claimAs(orgB, second.anchorId, '7777')).outcome).toBe('keyed');
    expect((await itemRows(`WHERE id = '${queued.item_id}'`))[0]).toMatchObject({ status: 'resolved', resolution: 'superseded' });
  });

  it('撞號的物件只有宣稱方自己讀得到審核單號，且只讀得到自己提出的', async () => {
    const first = await registrantHolds();
    const second = await createProperty(orgB);
    const queued = await claimAs(orgB, second.anchorId);
    const read = (orgId: string, unitIds: string[]) =>
      withTx({ kind: 'org', orgId }, async (tx) => (await tx.query<Record<string, unknown>>('SELECT * FROM registry.get_collision_reviews($1::text[])', [unitIds])).rows);
    expect(await read(orgB, [second.unitId, first.unitId])).toEqual([
      { unit_id: second.unitId, item_id: queued.item_id, created_at: expect.anything() },
    ]);
    // 別的組織拿 B 的單位 ID 查，與查不存在的 ID 相同
    expect(await read(orgC, [second.unitId])).toEqual(await read(orgC, [newUlid()]));
    expect(await read(orgA, [second.unitId])).toEqual([]);
  });
});

describe('registry.assign_anchor_key：撞到自己的組織', () => {
  it('回 own_existing 與自己的物件 ID，不建審核單', async () => {
    const first = await registrantHolds();
    const second = await createProperty(orgA, '重複建檔');
    const result = await claimAs(orgA, second.anchorId);
    expect(result).toEqual({ outcome: 'own_existing', item_id: null, property_id: first.propertyId });
    expect(await itemRows()).toEqual([]);
    const { rows } = await owner(() => db.query('SELECT status, building_no FROM registry.anchors WHERE id = $1', [second.anchorId]));
    expect(rows).toEqual([{ status: 'pending_verification', building_no: null }]);
  });

  it('自己撞自己不算進頻率上限', async () => {
    await setLimit(1);
    await registrantHolds();
    for (let i = 0; i < 3; i += 1) {
      const dup = await createProperty(orgA);
      expect((await claimAs(orgA, dup.anchorId)).outcome).toBe('own_existing');
    }
    const other = await createProperty(orgB);
    expect((await claimAs(orgB, other.anchorId)).outcome).toBe('collision_queued');
  });

  it('自己有多個物件在該錨點下時，優先回整戶（後綴 0000）、未封存的那筆', async () => {
    const first = await registrantHolds();
    const sublet = await withTx({ kind: 'org', orgId: orgA }, async (tx) => {
      const unitId = newUlid();
      const propertyId = newUlid();
      await tx.query('SELECT * FROM registry.create_sublet_unit($1, $2, $3, NULL)', [first.unitId, unitId, '301']);
      await tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [propertyId, orgA, unitId, '分租', '某地址']);
      return propertyId;
    });
    expect(sublet).not.toBe(first.propertyId);
    const dup = await createProperty(orgA);
    expect((await claimAs(orgA, dup.anchorId)).property_id).toBe(first.propertyId);
  });
});

describe('registry.assign_anchor_key：頻率限制', () => {
  it('同一個組織 24 小時內第 N+1 次撞號回 rate_limited，不建審核單', async () => {
    await setLimit(2);
    await registrantHolds();
    for (let i = 0; i < 2; i += 1) {
      const p = await createProperty(orgB);
      expect((await claimAs(orgB, p.anchorId)).outcome).toBe('collision_queued');
    }
    const third = await createProperty(orgB);
    expect(await claimAs(orgB, third.anchorId)).toEqual({ outcome: 'rate_limited', item_id: null, property_id: null });
    expect(await itemRows(`WHERE type = 'anchor_collision'`)).toHaveLength(2);
  });

  it('額度按組織分開算：B 用完不影響 C', async () => {
    await setLimit(1);
    await registrantHolds();
    const b1 = await createProperty(orgB);
    const b2 = await createProperty(orgB);
    const c1 = await createProperty(orgC);
    expect((await claimAs(orgB, b1.anchorId)).outcome).toBe('collision_queued');
    expect((await claimAs(orgB, b2.anchorId)).outcome).toBe('rate_limited');
    expect((await claimAs(orgC, c1.anchorId)).outcome).toBe('collision_queued');
  });

  it('超過 24 小時的撞號不算，額度回復', async () => {
    await setLimit(1);
    await registrantHolds();
    const b1 = await createProperty(orgB);
    const queued = await claimAs(orgB, b1.anchorId);
    const b2 = await createProperty(orgB);
    expect((await claimAs(orgB, b2.anchorId)).outcome).toBe('rate_limited');
    await owner(() => db.query(`UPDATE registry.review_items SET created_at = now() - interval '25 hours' WHERE id = $1`, [queued.item_id]));
    expect((await claimAs(orgB, b2.anchorId)).outcome).toBe('collision_queued');
  });

  it('被取代的舊審核單仍算進額度：反覆改宣稱不能繞過上限', async () => {
    await setLimit(2);
    await registrantHolds();
    const b = await createProperty(orgB);
    expect((await claimAs(orgB, b.anchorId)).outcome).toBe('collision_queued');
    expect((await claimAs(orgB, b.anchorId)).outcome).toBe('collision_queued');
    expect((await claimAs(orgB, b.anchorId)).outcome).toBe('rate_limited');
  });

  it('額度用完時沒有撞號的鍵照樣登錄成功（限制只管撞號回應）', async () => {
    await setLimit(1);
    await registrantHolds();
    const b1 = await createProperty(orgB);
    await claimAs(orgB, b1.anchorId);
    const b2 = await createProperty(orgB);
    expect((await claimAs(orgB, b2.anchorId, '9999')).outcome).toBe('keyed');
  });
});

describe('registry.record_collision_limit_hit', () => {
  const hit = (orgId: string, itemId = newUlid()) =>
    withTx({ kind: 'org', orgId }, async (tx) => (await tx.query<{ v: string }>('SELECT registry.record_collision_limit_hit($1) AS v', [itemId])).rows[0].v);

  async function reachLimit(orgId: string, n = 1) {
    await setLimit(n);
    await registrantHolds();
    for (let i = 0; i < n; i += 1) await claimAs(orgId, (await createProperty(orgId)).anchorId);
  }

  it('額度還沒用完時拒絕：沒有額度壓力的組織不能往營運者佇列塞項目', async () => {
    await setLimit(5);
    await expect(hit(orgB)).rejects.toMatchObject({ code: '55000' });
    expect(await itemRows()).toEqual([]);
  });

  it('額度用完後寫一張撞號超限審核單；同一個組織反覆撞只累計次數，不增加項目', async () => {
    await reachLimit(orgB);
    const id1 = await hit(orgB);
    const id2 = await hit(orgB);
    expect(id2).toBe(id1);
    const items = await itemRows(`WHERE type = 'anchor_collision_limit'`);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: id1, subject_type: 'org', subject_id: orgB, status: 'open' });
    expect(items[0].payload).toMatchObject({ claimant_org_id: orgB, limit: 1, hits: 2 });
  });

  it('超過 24 小時還沒人處理的舊項目被取代，開新的一張', async () => {
    await reachLimit(orgB);
    const old = await hit(orgB);
    await owner(() => db.query(`UPDATE registry.review_items SET created_at = now() - interval '30 hours' WHERE id = $1`, [old]));
    const next = await hit(orgB);
    expect(next).not.toBe(old);
    expect((await itemRows(`WHERE id = '${old}'`))[0]).toMatchObject({ status: 'resolved', resolution: 'superseded' });
  });

  it('沒有組織脈絡時拒絕', async () => {
    await expect(withTx({ kind: 'control' }, (tx) => tx.query('SELECT registry.record_collision_limit_hit($1)', [newUlid()]))).rejects.toThrow(/組織脈絡/);
  });
});

describe('審核台', () => {
  let operatorId: string;
  beforeEach(async () => {
    operatorId = newUlid();
    const partyId = newUlid();
    await owner(async () => {
      await db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'ops@example.com', '營運者')`, [partyId]);
      await db.query(`INSERT INTO control.users (id, party_id) VALUES ($1, $2)`, [operatorId, partyId]);
      await db.query(`INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'admin')`, [newUlid(), PLATFORM_ORG_ID, operatorId]);
    });
  });
  const asOperator = <T>(fn: (tx: OrgTx) => Promise<T>) =>
    withTx({ kind: 'operator', operatorId, orgId: PLATFORM_ORG_ID, ticketId: 'desk:test' }, (tx) => fn(tx as OrgTx));

  it('佇列列出撞號項目：宣稱方、宣稱的鍵與建立時間', async () => {
    await registrantHolds();
    const second = await createProperty(orgB);
    const queued = await claimAs(orgB, second.anchorId);
    const rows = await asOperator(async (tx) => (await tx.query<Record<string, any>>(`SELECT * FROM registry.review_queue('open', 200)`)).rows); // eslint-disable-line @typescript-eslint/no-explicit-any
    const item = rows.find((r) => r.id === queued.item_id)!;
    expect(item).toMatchObject({ type: 'anchor_collision', subject_type: 'anchor', status: 'open' });
    expect(item.summary).toMatchObject({
      claimant_org_name: '乙方管理公司',
      claimed_key: { city_code: k.city, town_code: k.town, section_code: k.section, building_no: '01234', sub_no: '000' },
    });
    expect(item.created_at).toBeTruthy();
  });

  it('佇列與詳情都不含既有登錄方的組織名稱', async () => {
    await registrantHolds();
    const second = await createProperty(orgB);
    const queued = await claimAs(orgB, second.anchorId);
    const queue = await asOperator(async (tx) => (await tx.query(`SELECT * FROM registry.review_queue('open', 200)`)).rows);
    const detail = await asOperator(async (tx) => (await tx.query<{ v: unknown }>('SELECT registry.review_item_detail($1) AS v', [queued.item_id])).rows[0].v);
    expect(JSON.stringify(queue)).not.toContain('甲方');
    expect(JSON.stringify(detail)).not.toContain('甲方');
    expect(detail).toMatchObject({
      item: { id: queued.item_id, type: 'anchor_collision', status: 'open' },
      collision: { claimant_org_name: '乙方管理公司' },
    });
  });

  it('撞號超限項目顯示宣稱方、上限與次數', async () => {
    await setLimit(1);
    await registrantHolds();
    await claimAs(orgB, (await createProperty(orgB)).anchorId);
    const itemId = await withTx({ kind: 'org', orgId: orgB }, async (tx) => (await tx.query<{ v: string }>('SELECT registry.record_collision_limit_hit($1) AS v', [newUlid()])).rows[0].v);
    const rows = await asOperator(async (tx) => (await tx.query<Record<string, any>>(`SELECT * FROM registry.review_queue('open', 200)`)).rows); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(rows.find((r) => r.id === itemId)).toMatchObject({
      type: 'anchor_collision_limit',
      summary: { claimant_org_name: '乙方管理公司', limit: 1, hits: 1 },
    });
  });

  it('組織脈絡讀不到審核台', async () => {
    await expect(withTx({ kind: 'org', orgId: orgB }, (tx) => tx.query(`SELECT * FROM registry.review_queue('open', 200)`))).rejects.toThrow(/平台營運者/);
  });
});

describe('既有行為不變', () => {
  it('別的組織的錨點與不存在的錨點，錯誤完全相同', async () => {
    const mine = await createProperty(orgA);
    const asB = await claimAs(orgB, mine.anchorId).catch((e) => e);
    const missing = await claimAs(orgB, newUlid()).catch((e) => e);
    expect(asB).toMatchObject({ code: 'P0002' });
    expect({ code: asB.code, message: asB.message }).toEqual({ code: missing.code, message: missing.message });
    expect(await itemRows()).toEqual([]);
  });

  it('已建號的錨點不能再補建號', async () => {
    const { anchorId } = await createProperty(orgA);
    await claimAs(orgA, anchorId);
    await expect(claimAs(orgA, anchorId, '9')).rejects.toMatchObject({ code: '55000' });
  });
});
