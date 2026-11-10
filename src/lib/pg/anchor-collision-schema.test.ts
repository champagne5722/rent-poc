import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import seedJson from '../registry/section-code/seed.json';
import type { SectionCodeSeed } from '../registry/section-code/types';
import { PLATFORM_ORG_ID } from '../auth/config';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-144：撞號送審核台、頻率計數。MIL-196：對外回應一律相同，超過次數只通知營運者，鍵重複的稽核事件寫在平台鏈。
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
  const { rows } = await tx.query<ClaimRow>('SELECT * FROM registry.assign_anchor_key($1, $2, $3, $4, $5, NULL, $6, $7)', [
    anchorId,
    k.city,
    k.town,
    k.section,
    building,
    itemId,
    newUlid(),
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


/** 平台營運者身分。審核台函式與平台鏈都只有營運者讀得到。 */
async function makeOperator() {
  const operatorId = newUlid();
  const partyId = newUlid();
  await owner(async () => {
    await db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'ops@example.com', '營運者')`, [partyId]);
    await db.query(`INSERT INTO control.users (id, party_id) VALUES ($1, $2)`, [operatorId, partyId]);
    await db.query(`INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'admin')`, [newUlid(), PLATFORM_ORG_ID, operatorId]);
  });
  return <T>(fn: (tx: OrgTx) => Promise<T>) =>
    withTx({ kind: 'operator', operatorId, orgId: PLATFORM_ORG_ID, ticketId: 'desk:test' }, (tx) => fn(tx as OrgTx));
}

describe('registry.assign_anchor_key：撞到別的組織', () => {
  it('回 collision_queued 與審核單號；B 的物件轉待驗證且鍵不進唯一索引；審核單存宣稱的鍵', async () => {
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

  it('既有登錄方的物件、營運資料、通知、稽核鏈都不變，也沒有人通知它', async () => {
    const first = await registrantHolds();
    const snapshot = async () => ({
      registry: await owner(async () => ({
        anchor: (await db.query('SELECT * FROM registry.anchors WHERE id = $1', [first.anchorId])).rows,
        units: (await db.query('SELECT * FROM registry.rental_units WHERE anchor_id = $1', [first.anchorId])).rows,
      })),
      view: await withTx({ kind: 'org', orgId: orgA }, async (tx) => ({
        notifications: (await tx.query('SELECT id FROM org.notifications')).rows,
        audit: (await tx.query('SELECT seq, action FROM audit.events ORDER BY seq')).rows,
        anchors: (await tx.query('SELECT * FROM registry.get_anchors_for_units($1::text[])', [[first.unitId]])).rows,
        units: (await tx.query('SELECT * FROM registry.get_unit_details($1::text[])', [[first.unitId]])).rows,
      })),
    });
    const before = await snapshot();
    const second = await createProperty(orgB);
    await claimAs(orgB, second.anchorId);
    expect(await snapshot()).toEqual(before);
    expect(before.view.notifications).toEqual([]);
  });

  it('同一個物件再宣稱另一個撞號的鍵：舊審核單被取代，只剩一張待審', async () => {
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

  it('撞號之後改登錄沒人用的鍵：物件轉已建號，舊審核單被取代', async () => {
    await registrantHolds('1234');
    const second = await createProperty(orgB);
    const queued = await claimAs(orgB, second.anchorId, '1234');
    expect((await claimAs(orgB, second.anchorId, '7777')).outcome).toBe('keyed');
    expect((await itemRows(`WHERE id = '${queued.item_id}'`))[0]).toMatchObject({ status: 'resolved', resolution: 'superseded' });
  });
});

describe('讀取：撞號的物件仍讀到自己宣稱的鍵（MIL-196）', () => {
  const readAnchor = (orgId: string, unitId: string) =>
    withTx({ kind: 'org', orgId }, async (tx) => ({
      anchor: (await tx.query<Record<string, unknown>>('SELECT * FROM registry.get_anchors_for_units($1::text[])', [[unitId]])).rows,
      unit: (await tx.query<Record<string, unknown>>('SELECT * FROM registry.get_unit_details($1::text[])', [[unitId]])).rows,
    }));

  it('撞號的物件與沒撞號的物件，讀到的鍵、名稱與顯示編碼用的縣市與鄉鎮市區格式相同', async () => {
    const first = await registrantHolds('1234');
    const second = await createProperty(orgB);
    await claimAs(orgB, second.anchorId, '1234');
    const clean = await createProperty(orgB);
    await claimAs(orgB, clean.anchorId, '4321');
    const colliding = await readAnchor(orgB, second.unitId);
    const free = await readAnchor(orgB, clean.unitId);
    expect(colliding.anchor).toEqual([
      expect.objectContaining({ city_code: k.city, town_code: k.town, section_code: k.section, building_no: '01234', sub_no: '000' }),
    ]);
    expect(colliding.anchor[0].city_name).toBe(free.anchor[0].city_name);
    expect(colliding.anchor[0].section_name).toBe(free.anchor[0].section_name);
    expect(colliding.unit[0]).toMatchObject({ display_city_code: k.city, display_town_code: k.town });
    expect(free.unit[0]).toMatchObject({ display_city_code: k.city, display_town_code: k.town });
    // 既有登錄方讀到自己的鍵，與宣稱方的鍵相同，但看不到宣稱方的任何東西
    const holder = await readAnchor(orgA, first.unitId);
    expect(holder.anchor[0]).toMatchObject({ building_no: '01234' });
  });

  it('只讀得到自己提出的宣稱：別的組織拿宣稱方的單位 ID 查，與查不存在的 ID 相同', async () => {
    await registrantHolds();
    const second = await createProperty(orgB);
    await claimAs(orgB, second.anchorId);
    expect(await readAnchor(orgC, second.unitId)).toEqual(await readAnchor(orgC, newUlid()));
    expect(await readAnchor(orgA, second.unitId)).toEqual(await readAnchor(orgA, newUlid()));
  });

  it('已刪除的函式：get_collision_reviews 與 record_collision_limit_hit 不存在，宣稱方讀不到自己的審核單號', async () => {
    await withTx({ kind: 'org', orgId: orgB }, async (tx) => {
      await expect(tx.query('SELECT * FROM registry.get_collision_reviews($1::text[])', [[newUlid()]])).rejects.toMatchObject({ code: '42883' });
    });
    await withTx({ kind: 'org', orgId: orgB }, async (tx) => {
      await expect(tx.query('SELECT registry.record_collision_limit_hit($1)', [newUlid()])).rejects.toMatchObject({ code: '42883' });
    });
  });
});

describe('稽核事件（MIL-196）', () => {
  it('鍵重複的事件寫在平台鏈，payload 只有宣稱方組織與審核單號；宣稱方的鏈沒有這筆事件', async () => {
    await registrantHolds();
    const second = await createProperty(orgB);
    const queued = await claimAs(orgB, second.anchorId);
    const asOperator = await makeOperator();
    const platform = await asOperator(async (tx) =>
      (await tx.query<Record<string, unknown>>(`SELECT actor_type, action, object_type, object_id, payload FROM audit.events WHERE action = 'property.anchor_collision'`)).rows,
    );
    expect(platform).toEqual([
      {
        actor_type: 'system',
        action: 'property.anchor_collision',
        object_type: 'rental_unit',
        object_id: second.unitId,
        payload: { claimant_org_id: orgB, review_item_id: queued.item_id },
      },
    ]);
    expect(JSON.stringify(platform)).not.toMatch(/01234|甲方/);
    for (const org of [orgA, orgB, orgC]) {
      const mine = await withTx({ kind: 'org', orgId: org }, async (tx) => (await tx.query(`SELECT action FROM audit.events WHERE action = 'property.anchor_collision'`)).rows);
      expect(mine, `組織 ${org} 的鏈不得有鍵重複事件`).toEqual([]);
    }
  });

  it('app_rw 不能直接寫平台鏈：入口函式只開給擁有者', async () => {
    await withTx({ kind: 'org', orgId: orgB }, async (tx) => {
      await expect(tx.query(`SELECT audit.append_platform_anchor_collision($1, $2, $3)`, [orgB, newUlid(), newUlid()])).rejects.toThrow(/permission denied/);
    });
  });

  it('沒撞號時平台鏈沒有事件', async () => {
    await registrantHolds();
    const asOperator = await makeOperator();
    const platform = await asOperator(async (tx) => (await tx.query(`SELECT action FROM audit.events WHERE action = 'property.anchor_collision'`)).rows);
    expect(platform).toEqual([]);
  });
});

describe('registry.assign_anchor_key：撞到自己的組織', () => {
  it('回 own_existing 與自己的物件 ID，不建審核單，也不寫平台鏈', async () => {
    const first = await registrantHolds();
    const second = await createProperty(orgA, '重複建檔');
    const result = await claimAs(orgA, second.anchorId);
    expect(result).toEqual({ outcome: 'own_existing', item_id: null, property_id: first.propertyId });
    expect(await itemRows()).toEqual([]);
    const { rows } = await owner(() => db.query('SELECT status, building_no FROM registry.anchors WHERE id = $1', [second.anchorId]));
    expect(rows).toEqual([{ status: 'pending_verification', building_no: null }]);
    const asOperator = await makeOperator();
    expect(await asOperator(async (tx) => (await tx.query(`SELECT action FROM audit.events WHERE action = 'property.anchor_collision'`)).rows)).toEqual([]);
  });

  it('自己撞自己不算進次數', async () => {
    await setLimit(1);
    await registrantHolds();
    for (let i = 0; i < 3; i += 1) {
      const dup = await createProperty(orgA);
      expect((await claimAs(orgA, dup.anchorId)).outcome).toBe('own_existing');
    }
    const other = await createProperty(orgB);
    expect((await claimAs(orgB, other.anchorId)).outcome).toBe('collision_queued');
    expect(await itemRows(`WHERE type = 'anchor_collision_limit'`)).toEqual([]);
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

describe('registry.assign_anchor_key：修正建號', () => {
  it('已建號的物件改成沒人用的鍵：仍回 keyed，鍵更新', async () => {
    const { anchorId } = await createProperty(orgA);
    await claimAs(orgA, anchorId, '1234');
    expect((await claimAs(orgA, anchorId, '9')).outcome).toBe('keyed');
    const { rows } = await owner(() => db.query('SELECT status, building_no FROM registry.anchors WHERE id = $1', [anchorId]));
    expect(rows).toEqual([{ status: 'keyed', building_no: '00009' }]);
  });

  it('已建號的物件改成撞號的鍵：與撞號登錄相同，物件清掉原本的鍵，原本的鍵釋出', async () => {
    await registrantHolds('1234');
    const mine = await createProperty(orgB);
    await claimAs(orgB, mine.anchorId, '7777');
    expect((await claimAs(orgB, mine.anchorId, '1234')).outcome).toBe('collision_queued');
    const { rows } = await owner(() => db.query('SELECT status, building_no FROM registry.anchors WHERE id = $1', [mine.anchorId]));
    expect(rows).toEqual([{ status: 'pending_verification', building_no: null }]);
    // 7777 已釋出：C 可以直接登錄
    const c = await createProperty(orgC);
    expect((await claimAs(orgC, c.anchorId, '7777')).outcome).toBe('keyed');
  });

  it('物件已合併或停用：回 55000', async () => {
    const { anchorId } = await createProperty(orgA);
    await owner(() => db.query(`UPDATE registry.anchors SET status = 'retired' WHERE id = $1`, [anchorId]));
    await expect(claimAs(orgA, anchorId, '9')).rejects.toMatchObject({ code: '55000', message: '物件目前不能修正建號' });
  });

  it('審核單號或警示編號沒給：回 22023', async () => {
    const { anchorId } = await createProperty(orgA);
    await expect(
      withTx({ kind: 'org', orgId: orgA }, (tx) =>
        tx.query('SELECT * FROM registry.assign_anchor_key($1, $2, $3, $4, $5, NULL, $6, NULL)', [anchorId, k.city, k.town, k.section, '1234', newUlid()]),
      ),
    ).rejects.toMatchObject({ code: '22023' });
  });
});

describe('registry.assign_anchor_key：次數超過設定值只通知營運者', () => {
  it('超過次數時登錄照常成立，回傳與次數沒滿時相同，審核台出現一張警示', async () => {
    await setLimit(2);
    await registrantHolds();
    const outcomes: ClaimRow[] = [];
    for (let i = 0; i < 4; i += 1) {
      const p = await createProperty(orgB);
      outcomes.push(await claimAs(orgB, p.anchorId));
    }
    expect(outcomes.map((o) => o.outcome)).toEqual(['collision_queued', 'collision_queued', 'collision_queued', 'collision_queued']);
    expect(outcomes.every((o) => o.item_id !== null && o.property_id === null)).toBe(true);
    expect(await itemRows(`WHERE type = 'anchor_collision'`)).toHaveLength(4);
    const alerts = await itemRows(`WHERE type = 'anchor_collision_limit'`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ subject_type: 'org', subject_id: orgB, status: 'open' });
    expect(alerts[0].payload).toMatchObject({ claimant_org_id: orgB, limit: 2, hits: 2 });
  });

  it('額度按組織分開算：B 超過不影響 C，C 沒有警示', async () => {
    await setLimit(1);
    await registrantHolds();
    await claimAs(orgB, (await createProperty(orgB)).anchorId);
    await claimAs(orgB, (await createProperty(orgB)).anchorId);
    await claimAs(orgC, (await createProperty(orgC)).anchorId);
    const alerts = await itemRows(`WHERE type = 'anchor_collision_limit'`);
    expect(alerts.map((a) => a.subject_id)).toEqual([orgB]);
  });

  it('超過 24 小時的撞號不算，次數回復', async () => {
    await setLimit(1);
    await registrantHolds();
    const queued = await claimAs(orgB, (await createProperty(orgB)).anchorId);
    await owner(() => db.query(`UPDATE registry.review_items SET created_at = now() - interval '25 hours' WHERE id = $1`, [queued.item_id]));
    await claimAs(orgB, (await createProperty(orgB)).anchorId);
    expect(await itemRows(`WHERE type = 'anchor_collision_limit'`)).toEqual([]);
  });

  it('被取代的舊審核單仍算進次數：反覆改宣稱不能繞過計數', async () => {
    await setLimit(2);
    await registrantHolds();
    const b = await createProperty(orgB);
    await claimAs(orgB, b.anchorId);
    await claimAs(orgB, b.anchorId);
    await claimAs(orgB, b.anchorId);
    expect(await itemRows(`WHERE type = 'anchor_collision_limit'`)).toHaveLength(1);
  });

  it('超過 24 小時還沒人處理的舊警示被取代，開新的一張', async () => {
    await setLimit(1);
    await registrantHolds();
    await claimAs(orgB, (await createProperty(orgB)).anchorId);
    await claimAs(orgB, (await createProperty(orgB)).anchorId);
    const [old] = await itemRows(`WHERE type = 'anchor_collision_limit'`);
    await owner(() => db.query(`UPDATE registry.review_items SET created_at = now() - interval '30 hours' WHERE id = $1`, [old.id]));
    await claimAs(orgB, (await createProperty(orgB)).anchorId);
    const all = await itemRows(`WHERE type = 'anchor_collision_limit' ORDER BY created_at`);
    expect(all).toHaveLength(2);
    expect(all.find((i) => i.id === old.id)).toMatchObject({ status: 'resolved', resolution: 'superseded' });
  });

  it('額度用完時沒有撞號的鍵照樣登錄成功，不增加警示', async () => {
    await setLimit(1);
    await registrantHolds();
    await claimAs(orgB, (await createProperty(orgB)).anchorId);
    const b2 = await createProperty(orgB);
    expect((await claimAs(orgB, b2.anchorId, '9999')).outcome).toBe('keyed');
    expect(await itemRows(`WHERE type = 'anchor_collision_limit'`)).toEqual([]);
  });

  it('警示函式只給補建號函式用：app_rw 不能直接呼叫', async () => {
    await withTx({ kind: 'org', orgId: orgB }, async (tx) => {
      await expect(tx.query('SELECT registry.raise_collision_limit_alert($1, 1, $2)', [orgB, newUlid()])).rejects.toThrow(/permission denied/);
    });
    expect(await itemRows()).toEqual([]);
  });
});

describe('審核台', () => {
  let asOperator: Awaited<ReturnType<typeof makeOperator>>;
  beforeEach(async () => {
    asOperator = await makeOperator();
  });

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

  it('超過次數的警示顯示宣稱方、上限與次數', async () => {
    await setLimit(1);
    await registrantHolds();
    await claimAs(orgB, (await createProperty(orgB)).anchorId);
    await claimAs(orgB, (await createProperty(orgB)).anchorId);
    const [alert] = await itemRows(`WHERE type = 'anchor_collision_limit'`);
    const rows = await asOperator(async (tx) => (await tx.query<Record<string, any>>(`SELECT * FROM registry.review_queue('open', 200)`)).rows); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(rows.find((r) => r.id === alert.id)).toMatchObject({
      type: 'anchor_collision_limit',
      summary: { claimant_org_name: '乙方管理公司', limit: 1, hits: 1 },
    });
  });

  it('組織脈絡讀不到審核台', async () => {
    await expect(withTx({ kind: 'org', orgId: orgB }, (tx) => tx.query(`SELECT * FROM registry.review_queue('open', 200)`))).rejects.toThrow(/平台營運者/);
  });
});

describe('既有行為不變', () => {
  it('別的組織的物件與不存在的物件，錯誤完全相同', async () => {
    const mine = await createProperty(orgA);
    const asB = await claimAs(orgB, mine.anchorId).catch((e) => e);
    const missing = await claimAs(orgB, newUlid()).catch((e) => e);
    expect(asB).toMatchObject({ code: 'P0002', message: '物件不存在' });
    expect({ code: asB.code, message: asB.message }).toEqual({ code: missing.code, message: missing.message });
    expect(await itemRows()).toEqual([]);
  });
});
