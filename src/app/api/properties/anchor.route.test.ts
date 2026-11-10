import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_ORG_ID } from '@/lib/auth/config';
import { withTx } from '@/lib/pg/database';
import { actAs, setupRouteDb, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import { createProperty, parsePropertyInput, type PropertyInput } from '@/lib/properties';
import { GET as getOne } from './[id]/route';
import { POST as postAnchorKey } from './[id]/anchor-key/route';
import { GET as getList, POST } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-143：物件的建號。建立時填鍵（必填）、補建號、修正建號。
// MIL-196：登錄回應一律相同。鍵不重複、與別的組織重複、超過次數，回應 body、HTTP 碼、對外狀態與宣稱方讀得到的稽核事件都相同。
// 連線是 PGlite 的 app_rw。
// 段碼用 2026-11-08 的真實資料：臺北市(A) 大安區(02) 龍泉 一(0021)、延吉 二(A01-0610，已註銷)、
// 新北市(F) 中和區(18) 與永和區(33) 共有跨越段 1818。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
});

const KEY = { city: 'A', town: '02', section: '0021', buildingNo: '1234', subNo: '' };
const OTHER_KEY = { ...KEY, buildingNo: '4321' };
/** A 登錄的第二、第三個鍵。B 反覆登錄同一個鍵會得到自己既有的那一筆，所以要撞多次得有多個鍵。 */
const KEY_2 = { ...KEY, buildingNo: '2222' };
const KEY_3 = { ...KEY, buildingNo: '3333' };
const body = (overrides: Record<string, unknown> = {}) => ({
  name: '大安區溫馨兩房',
  address: '台北市大安區和平東路二段 100 號 3 樓',
  equipment: [],
  anchor: { key: KEY },
  ...overrides,
});

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const post = (payload: unknown) =>
  POST(new NextRequest('http://localhost/api/properties', { method: 'POST', body: JSON.stringify(payload) }));
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string) => getOne(new NextRequest('http://localhost/api/properties/x'), ctx(id));
const setKey = (id: string, payload: unknown) =>
  postAnchorKey(new NextRequest('http://localhost/api/properties/x/anchor-key', { method: 'POST', body: JSON.stringify(payload) }), ctx(id));

async function create(payload: Record<string, unknown> = body()): Promise<string> {
  const res = await post(payload);
  expect(res.status).toBe(201);
  return (await json(res)).data.id;
}
const anchorOf = async (id: string) => (await json(await get(id))).data.anchor;

/** 既有的沒有建號的物件（ADR-0028 決議 9 之前建立）。登錄入口已經不收，所以直接走 repository。 */
async function legacyNoKey(orgId: string = kit.orgA): Promise<string> {
  const parsed = parsePropertyInput({ name: '舊物件', address: '台北市大安區舊路 1 號', equipment: [] }) as { ok: true; value: PropertyInput };
  return withTx({ kind: 'org', orgId }, (tx) => createProperty(tx, parsed.value));
}

const ownerRows = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  kit.asOwner(async (db) => (await db.query<T>(sql, params)).rows);
const setLimit = (n: number) => kit.asOwner((db) => db.query(`UPDATE registry.platform_settings SET int_value = $1`, [n]));
/** 把 26 碼 ULID 換成固定字串，比對回應時略過每次不同的 ID。 */
const stripIds = (text: string) => text.replace(/[0-9A-HJKMNP-TV-Z]{26}/g, '<id>');

/** 宣稱方在自己的稽核鏈讀得到的事件。 */
const ownAudit = (orgId: string) =>
  withTx({ kind: 'org', orgId }, async (tx) =>
    (await tx.query<{ action: string; object_id: string; payload: Record<string, unknown> }>(
      'SELECT action, object_id, payload FROM audit.events ORDER BY seq',
    )).rows,
  );

/** 平台營運者在平台鏈讀得到的鍵重複事件。 */
async function platformCollisionEvents() {
  const operatorId = newUlid();
  const partyId = newUlid();
  await kit.asOwner(async (db) => {
    await db.query(`INSERT INTO control.parties (id, email, display_name) VALUES ($1, 'ops@example.com', '營運者')`, [partyId]);
    await db.query(`INSERT INTO control.users (id, party_id) VALUES ($1, $2)`, [operatorId, partyId]);
    await db.query(`INSERT INTO control.org_memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'admin')`, [newUlid(), PLATFORM_ORG_ID, operatorId]);
  });
  return withTx({ kind: 'operator', operatorId, orgId: PLATFORM_ORG_ID, ticketId: 'desk:test' }, async (tx) =>
    (await tx.query<{ action: string; object_id: string; payload: Record<string, unknown> }>(
      `SELECT action, object_id, payload FROM audit.events WHERE action = 'property.anchor_collision' ORDER BY seq`,
    )).rows,
  );
}

describe('建立物件時登錄建號', () => {
  it('建號必填：沒有 anchor 欄位回 400，不建物件', async () => {
    const res = await post(body({ anchor: undefined }));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('建號必填');
    expect((await json(await getList())).data).toEqual([]);
  });

  it('建號必填：key 為 null（過去的「暫無建號」）回 400，座標再完整也一樣', async () => {
    const res = await post(body({ anchor: { key: null, latitude: 25.0338, longitude: 121.5435 } }));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('建號必填');
    expect((await json(await getList())).data).toEqual([]);
  });

  it('填縣市、鄉鎮市區、段小段與建號：回 201 與對外狀態，建號補成 5 碼，分號空白存 000，名稱顯示「臺」', async () => {
    const res = await post(body());
    expect(res.status).toBe(201);
    const { data } = await json(res);
    expect(data).toEqual({ id: expect.any(String), verification_status: 'pending_verification' });
    expect(await anchorOf(data.id)).toEqual({
      city_code: 'A',
      town_code: '02',
      section_code: '0021',
      building_no: '01234',
      sub_no: '000',
      city_name: '臺北市',
      town_name: '大安區',
      section_name: '龍泉 一',
      latitude: null,
      longitude: null,
    });
  });

  it('物件的對外狀態是待平台核對文件，讀取結果沒有內部狀態與審核單號', async () => {
    const id = await create();
    const read = (await json(await get(id))).data;
    expect(read.verification_status).toBe('pending_verification');
    expect(Object.keys(read.anchor)).not.toContain('status');
    expect(Object.keys(read.anchor)).not.toContain('collision_review');
  });

  it('建號與分號都補零；段可以填段碼，也可以填段名', async () => {
    const byCode = await create(body({ anchor: { key: { ...KEY, buildingNo: '7', subNo: '3' } } }));
    expect(await anchorOf(byCode)).toMatchObject({ section_code: '0021', building_no: '00007', sub_no: '003' });
    const byName = await create(body({ anchor: { key: { ...KEY, section: '龍泉 二', buildingNo: '8' } } }));
    expect(await anchorOf(byName)).toMatchObject({ section_code: '0022', building_no: '00008' });
  });

  it('跨越段從別名行政區選：鍵存主行政區', async () => {
    const id = await create(body({ anchor: { key: { city: 'F', town: '33', section: '1818', buildingNo: '1' } } }));
    expect(await anchorOf(id)).toMatchObject({ town_code: '18', town_name: '中和區', section_code: '1818' });
  });

  it('填了鍵也可以同時給座標', async () => {
    const id = await create(body({ anchor: { key: KEY, latitude: 25.03, longitude: 121.54 } }));
    expect(await anchorOf(id)).toMatchObject({ latitude: 25.03, longitude: 121.54 });
  });

  it('清單也帶 anchor 與對外狀態', async () => {
    const first = await create(body({ name: '第一筆', anchor: { key: KEY } }));
    const second = await create(body({ name: '第二筆', anchor: { key: OTHER_KEY } }));
    const { data } = await json(await getList());
    expect(data.map((p: { id: string; verification_status: string }) => [p.id, p.verification_status])).toEqual([
      [second, 'pending_verification'],
      [first, 'pending_verification'],
    ]);
    expect(data[0].anchor.building_no).toBe('04321');
  });

  it.each([
    ['縣市找不到', { ...KEY, city: 'ZZ' }, '找不到縣市'],
    ['鄉鎮市區找不到', { ...KEY, town: '99' }, '沒有'],
    ['段找不到', { ...KEY, section: '9999' }, '找不到段'],
    ['段已註銷', { city: 'A', town: '01', section: '0610', buildingNo: '1' }, '已註銷'],
    ['建號空白', { ...KEY, buildingNo: '' }, '必須填建號'],
    ['建號超過 5 位', { ...KEY, buildingNo: '123456' }, '建號必須是 1 到 5 位數字'],
    ['建號全為零', { ...KEY, buildingNo: '0' }, '不得全為零'],
    ['分號超過 3 位', { ...KEY, subNo: '1234' }, '分號必須是 1 到 3 位數字'],
  ])('%s：回 400 與原因，不建物件', async (_name, key, message) => {
    const res = await post(body({ anchor: { key } }));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain(message);
    expect((await json(await getList())).data).toEqual([]);
  });

  it.each([
    ['緯度超出範圍', { key: KEY, latitude: 91, longitude: 121 }],
    ['經度超出範圍', { key: KEY, latitude: 25, longitude: 181 }],
    ['只給緯度', { key: KEY, latitude: 25 }],
    ['座標不是數字', { key: KEY, latitude: '25', longitude: '121' }],
    ['anchor 不是物件', 'x'],
    ['key 不是物件', { key: 'x' }],
  ])('%s：回 400，不建物件', async (_name, anchor) => {
    const res = await post(body({ anchor }));
    expect(res.status).toBe(400);
    expect((await json(await getList())).data).toEqual([]);
  });
});

describe('登錄回應一律相同（MIL-196，ADR-0028 決議 1、2、6）', () => {
  /** A 先登錄 KEY 與 KEY_2，之後 B 分別登錄沒人用的鍵、A 已登錄的鍵、超過次數後 A 的另一個已登錄的鍵。 */
  async function threeRegistrations() {
    actAs(kit.orgA);
    const aId = await create(body({ name: 'A 的秘密物件' }));
    await create(body({ name: 'A 的第二個秘密物件', anchor: { key: KEY_2 } }));
    actAs(kit.orgB);
    const freshRes = await post(body({ name: 'B 的物件', anchor: { key: OTHER_KEY } }));
    const collidingRes = await post(body({ name: 'B 的物件', anchor: { key: KEY } }));
    await setLimit(1);
    const overRes = await post(body({ name: 'B 的物件', anchor: { key: KEY_2 } }));
    const results = await Promise.all(
      [freshRes, collidingRes, overRes].map(async (res) => {
        const text = await res.text();
        return { status: res.status, text, id: (JSON.parse(text) as { data: { id: string } }).data.id };
      }),
    );
    return { aId, fresh: results[0], colliding: results[1], over: results[2] };
  }

  it('不重複、與別的組織重複、超過次數：HTTP 碼與 body 逐位元相同（除了每次不同的物件 ID）', async () => {
    const { fresh, colliding, over } = await threeRegistrations();
    expect([fresh.status, colliding.status, over.status]).toEqual([201, 201, 201]);
    expect(stripIds(colliding.text)).toBe(stripIds(fresh.text));
    expect(stripIds(over.text)).toBe(stripIds(fresh.text));
    expect(JSON.parse(fresh.text)).toEqual({ data: { id: expect.any(String), verification_status: 'pending_verification' } });
    // 回應與畫面不含「已在平台登錄」「已送審核」與審核單號
    for (const r of [fresh, colliding, over]) expect(r.text).not.toMatch(/已在平台登錄|已送審核|審核單號|review|ticket|429/);
  });

  it('三種物件讀回來的對外狀態、欄位與顯示編碼格式相同，撞號者讀到自己填的建號', async () => {
    const { fresh, colliding, over } = await threeRegistrations();
    const read = async (id: string) => (await json(await get(id))).data;
    const [f, c, o] = [await read(fresh.id), await read(colliding.id), await read(over.id)];
    for (const p of [f, c, o]) {
      expect(p.verification_status).toBe('pending_verification');
      expect(Object.keys(p.anchor).sort()).toEqual(Object.keys(f.anchor).sort());
      expect(Object.keys(p).sort()).toEqual(Object.keys(f).sort());
      expect(p.unit.display_code).toMatch(/^A02-[0-9A-HJKMNP-TV-Z]{6}$/);
      expect(p.unit).toMatchObject({ suffix: '0000', unit_type: 'whole', status: 'active' });
    }
    // 撞號者仍看到自己填的建號與名稱，與沒撞號的物件只差在建號本身
    expect(c.anchor).toEqual({ ...f.anchor, building_no: '01234' });
    expect(o.anchor).toEqual({ ...f.anchor, building_no: '02222' });
    expect(f.anchor.building_no).toBe('04321');
  });

  it('宣稱方在自己的稽核鏈讀到的事件相同：一筆登錄事件，內容只有租賃單位 ID，沒有鍵重複事件', async () => {
    const { fresh, colliding, over } = await threeRegistrations();
    const events = await ownAudit(kit.orgB);
    expect(events.map((e) => e.action)).toEqual(['property.create', 'property.create', 'property.create']);
    const read = async (id: string) => (await json(await get(id))).data.rental_unit_id as string;
    expect(events.map((e) => [e.object_id, e.payload])).toEqual([
      [fresh.id, { rental_unit_id: await read(fresh.id) }],
      [colliding.id, { rental_unit_id: await read(colliding.id) }],
      [over.id, { rental_unit_id: await read(over.id) }],
    ]);
    expect(JSON.stringify(events)).not.toMatch(/collision|01234|04321/);
  });

  it('鍵重複的稽核事件寫在平台組織的鏈，payload 不含鍵、地址與對方的任何資料', async () => {
    const { aId, colliding, over } = await threeRegistrations();
    const platform = await platformCollisionEvents();
    // 重複 2 次（含超過次數的那一次），不重複的那一次沒有
    expect(platform).toHaveLength(2);
    expect(platform.map((e) => e.action)).toEqual(['property.anchor_collision', 'property.anchor_collision']);
    for (const e of platform) expect(e.payload).toEqual({ claimant_org_id: kit.orgB, review_item_id: expect.any(String) });
    const items = await ownerRows<{ id: string }>(`SELECT id FROM registry.review_items WHERE type = 'anchor_collision' ORDER BY created_at`);
    expect(platform.map((e) => e.payload.review_item_id)).toEqual(items.map((i) => i.id));
    expect(JSON.stringify(platform)).not.toMatch(/01234|秘密|台北市/);
    expect(JSON.stringify(platform)).not.toContain(aId);
    void colliding;
    void over;
  });

  it('既有登錄方的稽核鏈與它讀到的物件在撞號前後相同', async () => {
    actAs(kit.orgA);
    const aId = await create(body());
    const snapshot = async () => ({ audit: await ownAudit(kit.orgA), property: (await json(await get(aId))).data, list: (await json(await getList())).data });
    const before = await snapshot();
    actAs(kit.orgB);
    await create(body({ anchor: { key: KEY } }));
    actAs(kit.orgA);
    expect(await snapshot()).toEqual(before);
  });

  it('超過次數時 route 不回 429，登錄照常成立；審核台出現內部警示，宣稱方的物件、稽核事件與回應都沒有警示', async () => {
    await setLimit(1);
    actAs(kit.orgA);
    for (const key of [KEY, KEY_2, KEY_3]) await create(body({ anchor: { key } }));
    actAs(kit.orgB);
    const statuses: number[] = [];
    const texts: string[] = [];
    for (const [i, key] of [KEY, KEY_2, KEY_3].entries()) {
      const res = await post(body({ name: `B${i}`, anchor: { key } }));
      statuses.push(res.status);
      texts.push(stripIds(await res.text()));
    }
    expect(statuses).toEqual([201, 201, 201]);
    expect(new Set(texts).size).toBe(1);
    expect((await json(await getList())).data).toHaveLength(3);
    const alerts = await ownerRows<{ subject_id: string; payload: Record<string, unknown> }>(
      `SELECT subject_id, payload FROM registry.review_items WHERE type = 'anchor_collision_limit'`,
    );
    expect(alerts).toEqual([{ subject_id: kit.orgB, payload: expect.objectContaining({ claimant_org_id: kit.orgB, limit: 1, hits: 2 }) }]);
    expect((await ownAudit(kit.orgB)).map((e) => e.action)).toEqual(['property.create', 'property.create', 'property.create']);
  });

  it('審核台仍看得到鍵重複、宣稱的鍵與雙方的資料（內部資料不變）', async () => {
    actAs(kit.orgA);
    const aId = await create(body());
    actAs(kit.orgB);
    const bId = await create(body());
    const [aUnit, bUnit] = await ownerRows<{ id: string }>(
      `SELECT u.id FROM registry.rental_units u JOIN org.properties p ON p.rental_unit_id = u.id WHERE p.id = ANY($1::text[]) ORDER BY p.id`,
      [[aId, bId]],
    );
    void aUnit;
    void bUnit;
    const items = await ownerRows<{ type: string; status: string; payload: Record<string, unknown> }>(
      `SELECT type, status, payload FROM registry.review_items WHERE type = 'anchor_collision'`,
    );
    expect(items).toEqual([
      {
        type: 'anchor_collision',
        status: 'open',
        payload: expect.objectContaining({
          claimant_org_id: kit.orgB,
          existing_anchor_id: expect.any(String),
          claimed_key: { city_code: 'A', town_code: '02', section_code: '0021', building_no: '01234', sub_no: '000' },
        }),
      },
    ]);
    const anchors = await ownerRows<{ status: string; building_no: string | null }>(
      `SELECT a.status, a.building_no FROM registry.anchors a ORDER BY a.created_at`,
    );
    expect(anchors).toEqual([
      { status: 'keyed', building_no: '01234' },
      { status: 'pending_verification', building_no: null },
    ]);
  });

  it('與自己組織重複：回傳自己的那一筆（唯一的例外），不建物件、審核台項目與稽核事件', async () => {
    const first = await create(body({ name: '第一筆' }));
    const events = (await ownAudit(kit.orgA)).length;
    const res = await post(body({ name: '重複的' }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: { id: first, existing: true } });
    expect((await json(await getList())).data).toHaveLength(1);
    expect(await ownerRows('SELECT id FROM registry.anchors')).toHaveLength(1);
    expect(await ownerRows('SELECT id FROM registry.review_items')).toEqual([]);
    expect(await ownAudit(kit.orgA)).toHaveLength(events);
    expect(await platformCollisionEvents()).toEqual([]);
  });

  it('同一個組織登錄同一個鍵第二次：鍵沒人用與撞到別的組織，回應相同（不能用第二次的回應探測）', async () => {
    actAs(kit.orgA);
    await create(body());
    actAs(kit.orgB);
    const secondOf = async (key: typeof KEY) => {
      const first = await post(body({ name: '第一次', anchor: { key } }));
      const second = await post(body({ name: '第二次', anchor: { key } }));
      return { first, second, firstId: (await json(first.clone())).data.id as string, text: stripIds(await second.text()) };
    };
    const free = await secondOf(OTHER_KEY);
    const colliding = await secondOf(KEY);
    expect([free.second.status, colliding.second.status]).toEqual([200, 200]);
    expect(colliding.text).toBe(free.text);
    expect(JSON.parse(colliding.text)).toEqual({ data: { id: '<id>', existing: true } });
    expect((await json(await getList())).data).toHaveLength(2);
    // 第二次回的是自己第一次登錄的那一筆
    const again = await post(body({ name: '第三次', anchor: { key: KEY } }));
    expect((await json(again)).data.id).toBe(colliding.firstId);
  });

  it('回應本文與錯誤都不含對方組織的名稱、統編、人員、物件與 ID', async () => {
    actAs(kit.orgB);
    const theirs = await create(body({ name: 'B 的秘密物件' }));
    const theirUnit = (await json(await get(theirs))).data.rental_unit_id;
    actAs(kit.orgA);
    const res = await post(body({ name: 'A 的物件' }));
    const text = await res.text();
    expect(text).not.toMatch(/秘密|B 組織/);
    expect(text).not.toContain(theirs);
    expect(text).not.toContain(theirUnit);
    // 對方的物件頁、清單與通知沒有任何變化
    actAs(kit.orgB);
    expect((await json(await getList())).data.map((p: { id: string }) => p.id)).toEqual([theirs]);
    const notifications = await withTx({ kind: 'org', orgId: kit.orgB }, async (tx) => (await tx.query('SELECT id FROM org.notifications')).rows);
    expect(notifications).toEqual([]);
  });
});

describe('滲透：B 組織登錄 A 組織已登錄的鍵（MIL-144、MIL-196）', () => {
  // 關鍵：這個關係是 B 自己能建立的（B 可以對任何鍵宣稱），所以它不得解鎖 A 的任何資料，也不得讓 B 分辨 A 是否登錄過。
  // 檢查 B 拿得到的一切：登錄的回應、B 的稽核鏈、B 能呼叫的所有 registry 查詢、B 的物件與通知。再確認 A 這邊沒有任何變化。
  const A_ADDRESS = '台北市大安區秘密路 99 號';

  async function setup() {
    actAs(kit.orgA);
    const aId = await create(body({ name: 'A 的秘密物件', address: A_ADDRESS }));
    const aUnit = (await json(await get(aId))).data.rental_unit_id as string;
    const aAnchor = await kit.asOwner(async (db) => (await db.query<{ anchor_id: string }>('SELECT anchor_id FROM registry.rental_units WHERE id = $1', [aUnit])).rows[0].anchor_id);
    const aSnapshot = await viewOf(kit.orgA, aUnit);
    actAs(kit.orgB);
    const res = await post(body({ name: 'B 的物件', address: '新北市板橋區文化路 1 號' }));
    expect(res.status).toBe(201);
    const bText = await res.clone().text();
    const bId = (await json(res)).data.id as string;
    const bUnit = (await json(await get(bId))).data.rental_unit_id as string;
    return { aId, aUnit, aAnchor, aSnapshot, bId, bUnit, bText };
  }

  /** 一個組織能讀到的一切：物件、通知、稽核鏈與 registry 的每個讀取函式（用它自己的單位 ID）。 */
  async function viewOf(orgId: string, unitId: string) {
    return withTx({ kind: 'org', orgId }, async (tx) => {
      const rows = async (sql: string, params: unknown[] = []) => (await tx.query(sql, params)).rows;
      return {
        properties: await rows('SELECT * FROM org.properties ORDER BY id'),
        notifications: await rows('SELECT * FROM org.notifications ORDER BY id'),
        audit: await rows('SELECT chain_id, seq, action, object_type, object_id, payload FROM audit.events ORDER BY seq'),
        anchors: await rows('SELECT * FROM registry.get_anchors_for_units($1::text[])', [[unitId]]),
        units: await rows('SELECT * FROM registry.get_unit_details($1::text[])', [[unitId]]),
        siblings: await rows('SELECT * FROM registry.get_sibling_units($1)', [unitId]),
      };
    });
  }

  it('B 拿得到的一切都不含 A 的名稱、ID、物件與地址', async () => {
    const ctxA = await setup();
    const aMarkers = [kit.orgA, 'A 組織', 'A 的秘密物件', A_ADDRESS, '秘密路', ctxA.aId, ctxA.aUnit, ctxA.aAnchor];
    const bView = await viewOf(kit.orgB, ctxA.bUnit);
    const everything = JSON.stringify({ response: ctxA.bText, view: bView });
    for (const marker of aMarkers) expect(everything, `B 看到了 ${marker}`).not.toContain(marker);
    // B 拿 A 的 ID 去問，與問不存在的 ID 完全相同
    const probe = async (ids: { unit: string; property: string }) =>
      withTx({ kind: 'org', orgId: kit.orgB }, async (tx) => ({
        anchors: (await tx.query('SELECT * FROM registry.get_anchors_for_units($1::text[])', [[ids.unit]])).rows,
        units: (await tx.query('SELECT * FROM registry.get_unit_details($1::text[])', [[ids.unit]])).rows,
        siblings: (await tx.query('SELECT * FROM registry.get_sibling_units($1)', [ids.unit])).rows,
        property: (await tx.query('SELECT * FROM org.properties WHERE id = $1', [ids.property])).rows,
      }));
    expect(await probe({ unit: ctxA.aUnit, property: ctxA.aId })).toEqual(await probe({ unit: newUlid(), property: newUlid() }));
  });

  it('B 的稽核鏈只有一筆登錄事件，與沒有重複時相同；payload 不含 A 的任何資料也不含鍵', async () => {
    const ctxA = await setup();
    const events = await withTx({ kind: 'org', orgId: kit.orgB }, async (tx) => (await tx.query<{ action: string }>('SELECT * FROM audit.events ORDER BY seq')).rows);
    expect(events.map((e: { action: string }) => e.action)).toEqual(['property.create']);
    const text = JSON.stringify(events);
    for (const marker of [kit.orgA, ctxA.aId, ctxA.aUnit, ctxA.aAnchor, 'A 的秘密物件', A_ADDRESS, '01234']) expect(text).not.toContain(marker);
  });

  it('A 這邊沒有任何變化：物件、通知、稽核鏈、registry 讀取結果都與撞號前相同', async () => {
    const ctxA = await setup();
    expect(await viewOf(kit.orgA, ctxA.aUnit)).toEqual(ctxA.aSnapshot);
    const anchor = await kit.asOwner(async (db) =>
      (await db.query('SELECT id, status, city_code, building_no, updated_at FROM registry.anchors WHERE id = $1', [ctxA.aAnchor])).rows,
    );
    expect(anchor).toEqual([expect.objectContaining({ id: ctxA.aAnchor, status: 'keyed', building_no: '01234' })]);
  });

  it('B 反覆登錄同一個鍵：第一次之後都回自己既有的那一筆，回應逐位元相同，不會因為次數洩漏任何事', async () => {
    await setup();
    const texts: string[] = [];
    for (let i = 0; i < 3; i += 1) texts.push(stripIds(await (await post(body({ name: `B${i}` }))).text()));
    expect(new Set(texts).size).toBe(1);
    expect(JSON.parse(texts[0])).toEqual({ data: { id: '<id>', existing: true } });
  });
});

describe('POST /api/properties/[id]/anchor-key（補建號與修正建號）', () => {
  it('既有的沒有建號的物件補建號：回 200 與新的建號摘要和對外狀態', async () => {
    const id = await legacyNoKey();
    expect(await anchorOf(id)).toMatchObject({ city_code: null, building_no: null });
    const res = await setKey(id, KEY);
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data).toEqual({
      id,
      verification_status: 'pending_verification',
      anchor: expect.objectContaining({ building_no: '01234', sub_no: '000', section_name: '龍泉 一' }),
    });
    expect(await anchorOf(id)).toEqual(data.anchor);
  });

  it('沒給鍵（或本文不是物件）：回 400', async () => {
    const id = await create();
    expect((await setKey(id, {})).status).toBe(400);
    expect((await setKey(id, 'x')).status).toBe(400);
    expect(await anchorOf(id)).toMatchObject({ building_no: '01234' });
  });

  it('鍵有誤：回 400 與原因，原本的建號不變', async () => {
    const id = await create();
    const res = await setKey(id, { ...KEY, section: '9999' });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('找不到段');
    expect(await anchorOf(id)).toMatchObject({ building_no: '01234' });
  });

  it('物件通過核對前能自行修正建號：回應與登錄相同', async () => {
    const id = await create();
    const res = await setKey(id, { ...KEY, buildingNo: '9' });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      data: { id, verification_status: 'pending_verification', anchor: expect.objectContaining({ building_no: '00009' }) },
    });
    expect(await anchorOf(id)).toMatchObject({ building_no: '00009' });
  });

  describe('回應一律相同（MIL-196）', () => {
    /** B 的三個物件分別修正成：沒人用的鍵、A 已登錄的鍵、超過次數後 A 已登錄的鍵。 */
    async function threeFixes() {
      actAs(kit.orgA);
      await create(body());
      await create(body({ anchor: { key: KEY_2 } }));
      actAs(kit.orgB);
      const ids = [await legacyNoKey(kit.orgB), await legacyNoKey(kit.orgB), await legacyNoKey(kit.orgB)];
      const fresh = await setKey(ids[0], OTHER_KEY);
      const colliding = await setKey(ids[1], KEY);
      await setLimit(1);
      const over = await setKey(ids[2], KEY_2);
      const results = await Promise.all([fresh, colliding, over].map(async (res) => ({ status: res.status, text: await res.text() })));
      return { ids, fresh: results[0], colliding: results[1], over: results[2] };
    }

    it('不重複、與別的組織重複、超過次數：HTTP 碼與 body 的結構相同，不含審核單號與 429', async () => {
      const { fresh, colliding, over } = await threeFixes();
      expect([fresh.status, colliding.status, over.status]).toEqual([200, 200, 200]);
      const shape = (text: string) => {
        const { data } = JSON.parse(text);
        return { keys: Object.keys(data).sort(), anchorKeys: Object.keys(data.anchor).sort(), verification: data.verification_status };
      };
      expect(shape(colliding.text)).toEqual(shape(fresh.text));
      expect(shape(over.text)).toEqual(shape(fresh.text));
      // 撞號者的回應帶自己填的建號，與沒撞號時只差在建號本身
      const body_ = (text: string) => JSON.parse(text).data;
      expect(body_(colliding.text).anchor).toEqual({ ...body_(fresh.text).anchor, building_no: '01234' });
      expect(body_(over.text).anchor).toEqual({ ...body_(colliding.text).anchor, building_no: '02222' });
      for (const r of [fresh, colliding, over]) expect(r.text).not.toMatch(/已在平台登錄|已送審核|審核單號|review|ticket/);
    });

    it('宣稱方的稽核鏈相同：每次一筆 property.anchor_key，沒有鍵重複事件', async () => {
      const { ids } = await threeFixes();
      const events = await ownAudit(kit.orgB);
      const keyEvents = events.filter((e) => e.action !== 'property.create');
      expect(keyEvents.map((e) => e.action)).toEqual(['property.anchor_key', 'property.anchor_key', 'property.anchor_key']);
      expect(keyEvents.map((e) => e.object_id)).toEqual(ids);
      expect(JSON.stringify(events)).not.toMatch(/collision|01234|04321/);
      expect(await platformCollisionEvents()).toHaveLength(2);
    });

    it('已有建號的物件修正成撞號的鍵：與沒撞號時回應相同，物件頁顯示自己填的新建號', async () => {
      actAs(kit.orgA);
      await create(body());
      actAs(kit.orgB);
      const id = await create(body({ anchor: { key: OTHER_KEY } }));
      const res = await setKey(id, KEY);
      expect(res.status).toBe(200);
      expect(await anchorOf(id)).toMatchObject({ building_no: '01234' });
      expect((await json(await get(id))).data.verification_status).toBe('pending_verification');
    });
  });

  it('與自己組織重複：回自己的那筆物件（唯一的例外），補建號的物件維持原樣，不建審核台項目', async () => {
    const first = await create(body());
    const id = await legacyNoKey();
    const res = await setKey(id, KEY);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: { id: first, existing: true } });
    expect(await anchorOf(id)).toMatchObject({ building_no: null });
    expect(await ownerRows('SELECT id FROM registry.review_items')).toEqual([]);
  });

  it('別的組織的 ID、不存在的 ID、格式錯誤的 ID，回應逐位元相同', async () => {
    const mine = await create();
    actAs(kit.orgB);
    const outcomes = await Promise.all(
      [mine, newUlid(), 'not-a-ulid'].map(async (id) => {
        const res = await setKey(id, KEY);
        return { status: res.status, text: await res.text() };
      }),
    );
    expect(outcomes[0]).toEqual({ status: 404, text: JSON.stringify({ error: '物件不存在' }) });
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
    actAs(kit.orgA);
    expect(await anchorOf(mine)).toMatchObject({ building_no: '01234' });
  });

  it('寫一筆稽核事件 property.anchor_key，payload 不含鍵與地址', async () => {
    const id = await legacyNoKey();
    await setKey(id, KEY);
    const rows = (await ownAudit(kit.orgA)).filter((e) => e.action === 'property.anchor_key');
    const unitId = (await json(await get(id))).data.rental_unit_id;
    expect(rows).toEqual([{ action: 'property.anchor_key', object_id: id, payload: { rental_unit_id: unitId } }]);
  });
});
