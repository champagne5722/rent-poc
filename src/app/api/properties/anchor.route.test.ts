import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTx } from '@/lib/pg/database';
import { actAs, setupRouteDb, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import { GET as getOne } from './[id]/route';
import { POST as postAnchorKey } from './[id]/anchor-key/route';
import { GET as getList, POST } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-143：物件的產權錨點。建立時填鍵、暫無建號、之後補建號。連線是 PGlite 的 app_rw。
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
const body = (overrides: Record<string, unknown> = {}) => ({
  name: '大安區溫馨兩房',
  address: '台北市大安區和平東路二段 100 號 3 樓',
  equipment: [],
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

const PENDING = {
  status: 'pending_verification',
  city_code: null,
  town_code: null,
  section_code: null,
  building_no: null,
  sub_no: null,
  city_name: null,
  town_name: null,
  section_name: null,
  latitude: null,
  longitude: null,
  collision_review: null,
};

describe('建立物件時登錄產權', () => {
  it('沒有 anchor 欄位：待驗證，鍵與座標都是空值', async () => {
    const id = await create();
    expect(await anchorOf(id)).toEqual(PENDING);
  });

  it('填縣市、鄉鎮市區、段小段與建號：錨點轉已建號，建號補成 5 碼，分號空白存 000，名稱顯示「臺」', async () => {
    const id = await create(body({ anchor: { key: KEY } }));
    expect(await anchorOf(id)).toEqual({
      status: 'keyed',
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
      collision_review: null,
    });
  });

  it('建號與分號都補零；段可以填段碼，也可以填段名', async () => {
    const byCode = await create(body({ anchor: { key: { ...KEY, buildingNo: '7', subNo: '3' } } }));
    expect(await anchorOf(byCode)).toMatchObject({ section_code: '0021', building_no: '00007', sub_no: '003' });
    const byName = await create(body({ anchor: { key: { ...KEY, section: '龍泉 二', buildingNo: '8' } } }));
    expect(await anchorOf(byName)).toMatchObject({ section_code: '0022', building_no: '00008' });
  });

  it('跨越段從別名行政區選：鍵存主行政區', async () => {
    const id = await create(body({ anchor: { key: { city: 'F', town: '33', section: '1818', buildingNo: '1' } } }));
    expect(await anchorOf(id)).toMatchObject({
      status: 'keyed',
      town_code: '18',
      town_name: '中和區',
      section_code: '1818',
    });
  });

  it('暫無建號（key 為 null）：只需門牌，座標選填，錨點維持待驗證', async () => {
    const id = await create(body({ anchor: { key: null, latitude: 25.0338, longitude: 121.5435 } }));
    expect(await anchorOf(id)).toEqual({ ...PENDING, latitude: 25.0338, longitude: 121.5435 });
  });

  it('填了鍵也可以同時給座標', async () => {
    const id = await create(body({ anchor: { key: KEY, latitude: 25.03, longitude: 121.54 } }));
    expect(await anchorOf(id)).toMatchObject({ status: 'keyed', latitude: 25.03, longitude: 121.54 });
  });

  it('清單也帶 anchor', async () => {
    const keyed = await create(body({ name: '有建號', anchor: { key: KEY } }));
    const pending = await create(body({ name: '暫無建號', anchor: { key: null } }));
    const { data } = await json(await getList());
    expect(data.map((p: { id: string; anchor: { status: string } }) => [p.id, p.anchor.status])).toEqual([
      [pending, 'pending_verification'],
      [keyed, 'keyed'],
    ]);
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
    ['緯度超出範圍', { key: null, latitude: 91, longitude: 121 }],
    ['經度超出範圍', { key: null, latitude: 25, longitude: 181 }],
    ['只給緯度', { key: null, latitude: 25 }],
    ['座標不是數字', { key: null, latitude: '25', longitude: '121' }],
    ['anchor 不是物件', 'x'],
    ['key 不是物件', { key: 'x' }],
  ])('%s：回 400，不建物件', async (_name, anchor) => {
    const res = await post(body({ anchor }));
    expect(res.status).toBe(400);
    expect((await json(await getList())).data).toEqual([]);
  });

  describe('撞號（MIL-144）', () => {
    const NOTICE = '此產權已在平台登錄，已送審核';
    const ownerRows = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      kit.asOwner(async (db) => (await db.query<T>(sql, params)).rows);

    it('撞到別的組織：照樣建立物件，回固定訊息與審核單號，物件的產權維持待驗證', async () => {
      actAs(kit.orgB);
      await create(body({ name: 'B 的秘密物件', anchor: { key: KEY } }));
      actAs(kit.orgA);
      const res = await post(body({ name: 'A 的物件', anchor: { key: KEY } }));
      expect(res.status).toBe(201);
      const { data } = await json(res);
      expect(Object.keys(data).sort()).toEqual(['id', 'review']);
      expect(data.review).toEqual({ ticket: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/), message: NOTICE });

      // 物件已建立，掛在待驗證的產權上，物件頁讀得到審核單號
      const anchor = await anchorOf(data.id);
      expect(anchor).toMatchObject({ ...PENDING, collision_review: { ticket: data.review.ticket } });
      expect((await json(await getList())).data.map((p: { id: string }) => p.id)).toEqual([data.id]);

      // 宣稱的鍵存在審核台項目，不進唯一索引
      const items = await ownerRows<{ id: string; type: string; payload: Record<string, any> }>( // eslint-disable-line @typescript-eslint/no-explicit-any
        `SELECT id, type, payload FROM registry.review_items WHERE type = 'anchor_collision'`,
      );
      expect(items).toEqual([
        {
          id: data.review.ticket,
          type: 'anchor_collision',
          payload: expect.objectContaining({
            claimant_org_id: kit.orgA,
            claimed_key: { city_code: 'A', town_code: '02', section_code: '0021', building_no: '01234', sub_no: '000' },
          }),
        },
      ]);
    });

    it('回應本文與錯誤都不含對方組織的名稱、統編、人員、物件與 ID', async () => {
      actAs(kit.orgB);
      const theirs = await create(body({ name: 'B 的秘密物件', anchor: { key: KEY } }));
      const theirUnit = (await json(await get(theirs))).data.rental_unit_id;
      actAs(kit.orgA);
      const res = await post(body({ name: 'A 的物件', anchor: { key: KEY } }));
      const text = await res.text();
      expect(text).not.toMatch(/秘密|B 組織/);
      expect(text).not.toContain(theirs);
      expect(text).not.toContain(theirUnit);
      // 對方的物件頁、清單與通知沒有任何變化
      actAs(kit.orgB);
      expect((await json(await getList())).data.map((p: { id: string }) => p.id)).toEqual([theirs]);
      expect(await anchorOf(theirs)).toMatchObject({ status: 'keyed', building_no: '01234', collision_review: null });
      const notifications = await withTx({ kind: 'org', orgId: kit.orgB }, async (tx) => (await tx.query('SELECT id FROM org.notifications')).rows);
      expect(notifications).toEqual([]);
    });

    it('在撞號者的稽核鏈寫 property.anchor_collision，payload 不含鍵、地址與對方的任何資料', async () => {
      actAs(kit.orgB);
      await create(body({ name: 'B 的秘密物件', anchor: { key: KEY } }));
      actAs(kit.orgA);
      const { data } = await json(await post(body({ anchor: { key: KEY } })));
      const rows = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) =>
        (await tx.query<{ action: string; object_id: string; payload: Record<string, unknown> }>(
          `SELECT action, object_id, payload FROM audit.events WHERE action LIKE 'property.%' ORDER BY seq`,
        )).rows,
      );
      const unitId = (await json(await get(data.id))).data.rental_unit_id;
      expect(rows).toEqual([
        { action: 'property.create', object_id: data.id, payload: { rental_unit_id: unitId } },
        { action: 'property.anchor_collision', object_id: data.id, payload: { rental_unit_id: unitId, review_item_id: data.review.ticket } },
      ]);
      expect(JSON.stringify(rows)).not.toMatch(/秘密|B 組織|01234/);
    });

    it('撞到自己組織：回自己的那筆物件，不建物件、錨點與審核台項目', async () => {
      const first = await create(body({ name: '第一筆', anchor: { key: KEY } }));
      const res = await post(body({ name: '重複的', anchor: { key: KEY } }));
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ data: { id: first, existing: true } });
      expect((await json(await getList())).data).toHaveLength(1);
      expect(await ownerRows('SELECT id FROM registry.anchors')).toHaveLength(1);
      expect(await ownerRows('SELECT id FROM registry.review_items')).toEqual([]);
    });

    it('超過上限：回 429 請使用者聯絡平台，不建物件，仍留稽核事件，並排一張審核台項目通知營運者', async () => {
      await kit.asOwner((db) => db.query(`UPDATE registry.platform_settings SET int_value = 1`));
      actAs(kit.orgB);
      await create(body({ anchor: { key: KEY } }));
      actAs(kit.orgA);
      expect((await post(body({ name: '第一次', anchor: { key: KEY } }))).status).toBe(201);
      const limited = await post(body({ name: '第二次', anchor: { key: KEY } }));
      expect(limited.status).toBe(429);
      expect(await json(limited)).toEqual({ error: expect.stringContaining('請聯絡平台') });
      expect(JSON.stringify(await json(await post(body({ name: '第三次', anchor: { key: KEY } }))))).not.toMatch(/B 組織/);

      // 第二次與第三次都沒有建物件，錨點也沒有留下半成品
      expect((await json(await getList())).data.map((p: { name: string }) => p.name)).toEqual(['第一次']);
      expect(await ownerRows('SELECT id FROM registry.anchors')).toHaveLength(2);

      // 稽核事件沒有跟著回滾；營運者佇列有一張撞號超限項目，次數累計
      const audit = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) =>
        (await tx.query<{ action: string }>(`SELECT action FROM audit.events WHERE action = 'property.anchor_collision_limited'`)).rows,
      );
      expect(audit).toHaveLength(2);
      const items = await ownerRows<{ type: string; subject_id: string; payload: Record<string, unknown> }>(
        `SELECT type, subject_id, payload FROM registry.review_items WHERE type = 'anchor_collision_limit'`,
      );
      expect(items).toEqual([{ type: 'anchor_collision_limit', subject_id: kit.orgA, payload: expect.objectContaining({ limit: 1, hits: 2 }) }]);
    });
  });
});

describe('POST /api/properties/[id]/anchor-key（補建號）', () => {
  it('待驗證的錨點補建號後轉已建號，回應帶新的產權', async () => {
    const id = await create(body({ anchor: { key: null } }));
    const res = await setKey(id, KEY);
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data).toMatchObject({ id, anchor: { status: 'keyed', building_no: '01234', sub_no: '000', section_name: '龍泉 一' } });
    expect(await anchorOf(id)).toEqual(data.anchor);
  });

  it('沒給鍵（或本文不是物件）：回 400', async () => {
    const id = await create();
    expect((await setKey(id, {})).status).toBe(400);
    expect((await setKey(id, 'x')).status).toBe(400);
    expect((await anchorOf(id)).status).toBe('pending_verification');
  });

  it('鍵有誤：回 400 與原因，錨點維持待驗證', async () => {
    const id = await create();
    const res = await setKey(id, { ...KEY, section: '9999' });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('找不到段');
    expect((await anchorOf(id)).status).toBe('pending_verification');
  });

  it('已建號的物件不能再補建號：回 409', async () => {
    const id = await create(body({ anchor: { key: KEY } }));
    const res = await setKey(id, { ...KEY, buildingNo: '9' });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe('產權已建號，不能再補建號');
    expect(await anchorOf(id)).toMatchObject({ building_no: '01234' });
  });

  describe('撞號（MIL-144）', () => {
    const NOTICE = '此產權已在平台登錄，已送審核';

    it('撞到別的組織：回固定訊息與審核單號，物件維持待驗證並顯示審核單號', async () => {
      actAs(kit.orgB);
      await create(body({ name: 'B 的秘密物件', anchor: { key: KEY } }));
      actAs(kit.orgA);
      const id = await create();
      const res = await setKey(id, KEY);
      expect(res.status).toBe(200);
      const { data } = await json(res);
      expect(Object.keys(data).sort()).toEqual(['anchor', 'id', 'review']);
      expect(data.review).toEqual({ ticket: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/), message: NOTICE });
      expect(data.anchor).toMatchObject({ status: 'pending_verification', building_no: null, collision_review: { ticket: data.review.ticket } });
      expect(JSON.stringify(data)).not.toMatch(/秘密|B 組織/);
      expect(await anchorOf(id)).toEqual(data.anchor);
    });

    it('撞到自己組織：回自己的那筆物件，補建號的物件維持待驗證，不建審核台項目', async () => {
      const first = await create(body({ anchor: { key: KEY } }));
      const id = await create();
      const res = await setKey(id, KEY);
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ data: { id: first, existing: true } });
      expect((await anchorOf(id)).status).toBe('pending_verification');
      const items = await kit.asOwner(async (db) => (await db.query('SELECT id FROM registry.review_items')).rows);
      expect(items).toEqual([]);
    });

    it('改登錄沒人用的鍵：轉已建號，審核單號不再顯示', async () => {
      actAs(kit.orgB);
      await create(body({ anchor: { key: KEY } }));
      actAs(kit.orgA);
      const id = await create();
      await setKey(id, KEY);
      const res = await setKey(id, { ...KEY, buildingNo: '777' });
      expect(res.status).toBe(200);
      expect((await json(res)).data.anchor).toMatchObject({ status: 'keyed', building_no: '00777', collision_review: null });
    });

    it('超過上限：回 429，物件維持待驗證，留稽核事件', async () => {
      await kit.asOwner((db) => db.query(`UPDATE registry.platform_settings SET int_value = 1`));
      actAs(kit.orgB);
      await create(body({ anchor: { key: KEY } }));
      actAs(kit.orgA);
      const first = await create();
      const second = await create();
      expect((await setKey(first, KEY)).status).toBe(200);
      const limited = await setKey(second, KEY);
      expect(limited.status).toBe(429);
      expect(await json(limited)).toEqual({ error: expect.stringContaining('請聯絡平台') });
      expect((await anchorOf(second)).status).toBe('pending_verification');
      const audit = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) =>
        (await tx.query(`SELECT action FROM audit.events WHERE action = 'property.anchor_collision_limited'`)).rows,
      );
      expect(audit).toHaveLength(1);
    });
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
    expect((await anchorOf(mine)).status).toBe('pending_verification');
  });

  it('寫一筆稽核事件 property.anchor_key，payload 不含鍵與地址', async () => {
    const id = await create();
    await setKey(id, KEY);
    const rows = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) =>
      (await tx.query<{ action: string; object_id: string; payload: Record<string, unknown> }>(
        `SELECT action, object_id, payload FROM audit.events WHERE action = 'property.anchor_key'`,
      )).rows,
    );
    const unitId = (await json(await get(id))).data.rental_unit_id;
    expect(rows).toEqual([{ action: 'property.anchor_key', object_id: id, payload: { rental_unit_id: unitId } }]);
  });
});
