import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTx } from '@/lib/pg/database';
import { actAs, actAsError, setupRouteDb, type RouteDb } from '@/lib/pg/route-test-kit';
import { isUlid, newUlid } from '@/lib/pg/ulid';
import { createProperty } from '@/lib/properties';
import { Unauthenticated } from '@/lib/request-context';
import { GET as getVocabulary } from '../equipment-vocabulary/route';
import { DELETE, GET as getOne, PUT } from './[id]/route';
import { GET as getList, POST } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-81：物件 route 的 response body。連線是 PGlite 的 app_rw，RLS 生效。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
});

const NAME = '大安區溫馨兩房';
const body = (overrides: Record<string, unknown> = {}) => ({
  name: NAME,
  address: '台北市大安區和平東路二段 100 號 3 樓',
  type: '整層住家',
  size: 18.5,
  default_rent: 28000,
  note: '近捷運',
  equipment: [{ name: '冷氣', quantity: 2 }],
  ...overrides,
});

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const post = (payload: unknown) =>
  POST(new NextRequest('http://localhost/api/properties', { method: 'POST', body: JSON.stringify(payload) }));
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, payload?: unknown) =>
  new NextRequest('http://localhost/api/properties/x', { method, body: payload === undefined ? undefined : JSON.stringify(payload) });

async function create(payload = body()): Promise<string> {
  const res = await post(payload);
  expect(res.status).toBe(201);
  return (await json(res)).data.id;
}

describe('GET /api/properties（清單）', () => {
  it('沒有物件時回空陣列', async () => {
    const res = await getList();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: [] });
  });

  it('新的在前，每筆有完整欄位，ID 是 ULID', async () => {
    const first = await create(body({ name: '第一間' }));
    const second = await create(body({ name: '第二間', equipment: [] }));
    const res = await getList();
    const { data } = await json(res);
    expect(data.map((p: { id: string }) => p.id)).toEqual([second, first]);
    expect(data[1]).toEqual({
      id: first,
      rental_unit_id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      // 沒有給產權時是待驗證錨點，鍵與座標都是空值（MIL-143；產權的完整案例見 anchor.route.test.ts）
      anchor: expect.objectContaining({ status: 'pending_verification', building_no: null }),
      name: '第一間',
      address: '台北市大安區和平東路二段 100 號 3 樓',
      type: '整層住家',
      size: 18.5,
      default_rent: 28000,
      note: '近捷運',
      equipment: [{ name: '冷氣', quantity: 2 }],
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      updated_at: null,
    });
  });

  it('只看得到自己組織的物件', async () => {
    await create(body({ name: 'A 的物件' }));
    actAs(kit.orgB);
    await create(body({ name: 'B 的物件' }));
    const { data } = await json(await getList());
    expect(data.map((p: { name: string }) => p.name)).toEqual(['B 的物件']);
  });

  it('沒有登入回 401', async () => {
    actAsError(new Unauthenticated());
    const res = await getList();
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: '尚未登入或沒有存取權' });
  });
});

describe('POST /api/properties（建立）', () => {
  it('回 201 與 ULID，單筆讀得回來', async () => {
    const res = await post(body());
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(Object.keys(created)).toEqual(['data']);
    expect(Object.keys(created.data)).toEqual(['id']);
    expect(isUlid(created.data.id)).toBe(true);
    const one = await json(await getOne(req('GET'), ctx(created.data.id)));
    expect(one.data.name).toBe(NAME);
  });

  it('同一交易建待驗證錨點與 0000 整戶單位，物件的租賃單位 ID 指向它', async () => {
    const id = await create();
    const { data } = await json(await getOne(req('GET'), ctx(id)));
    const { rows } = await kit.asOwner((db) =>
      db.query<{ status: string; suffix: string; unit_type: string; address: string; normalized: string }>(
        `SELECT a.status, u.suffix, u.unit_type, a.address, a.address_normalized AS normalized
           FROM registry.rental_units u JOIN registry.anchors a ON a.id = u.anchor_id WHERE u.id = $1`,
        [data.rental_unit_id],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending_verification', suffix: '0000', unit_type: 'whole' });
    expect(rows[0].address).toBe('台北市大安區和平東路二段 100 號 3 樓');
    expect(rows[0].normalized).toBeTruthy();
  });

  it('每個物件各有自己的錨點與單位', async () => {
    const a = await create();
    const b = await create();
    const units = await Promise.all([a, b].map(async (id) => (await json(await getOne(req('GET'), ctx(id)))).data.rental_unit_id));
    expect(new Set(units).size).toBe(2);
  });

  it('沒給型態時用整層住家，沒給選填欄位時存空值', async () => {
    const id = await create({ name: '最小物件', address: '某地址' } as never);
    const { data } = await json(await getOne(req('GET'), ctx(id)));
    expect(data).toMatchObject({ type: '整層住家', size: null, default_rent: null, note: '', equipment: [] });
  });

  it('清單裡詞彙庫沒有的設備補成自訂項目', async () => {
    await create(body({ equipment: [{ name: '按摩浴缸', quantity: 1 }] }));
    const { data } = await json(await getVocabulary());
    expect(data.at(-1)).toMatchObject({ name: '按摩浴缸', is_custom: true });
    expect(data.filter((v: { name: string }) => v.name === '按摩浴缸')).toHaveLength(1);
  });

  it.each([
    ['名稱空白', body({ name: '  ' }), '名稱與地址為必填'],
    ['沒有地址', body({ address: undefined }), '名稱與地址為必填'],
    ['設備數量為 0', body({ equipment: [{ name: '冷氣', quantity: 0 }] }), '設備清單格式有誤：每項需有名稱且數量為正整數，且不可重複'],
    ['設備重複', body({ equipment: [{ name: '冷氣', quantity: 1 }, { name: '冷氣', quantity: 1 }] }), '設備清單格式有誤：每項需有名稱且數量為正整數，且不可重複'],
    ['型態不在清單內', body({ type: '別墅' }), '型態需為整層住家、套房、雅房其中之一'],
    ['預設租金不是整數', body({ default_rent: 1000.5 }), '預設租金需為不小於 0 的整數'],
    ['預設租金超過資料庫上限', body({ default_rent: 2_147_483_648 }), '預設租金需為不小於 0 的整數'],
    ['坪數是負數', body({ size: -1 }), '坪數需為不小於 0 的數字'],
  ])('%s回 400，不建任何資料', async (_label, payload, message) => {
    const res = await post(payload);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: message });
    expect((await json(await getList())).data).toEqual([]);
  });

  it('本文不是合法 JSON 回 400', async () => {
    const res = await POST(new NextRequest('http://localhost/api/properties', { method: 'POST', body: '{壞掉' }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: '請求內容格式有誤' });
  });
});

describe('GET /api/properties/[id]（單筆）', () => {
  it('回該筆物件', async () => {
    const id = await create();
    const res = await getOne(req('GET'), ctx(id));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ id, name: NAME, equipment: [{ name: '冷氣', quantity: 2 }] });
  });
});

describe('PUT /api/properties/[id]（修改）', () => {
  it('回 200 與 ID，內容更新，租賃單位不變，updated_at 有值', async () => {
    const id = await create();
    const before = (await json(await getOne(req('GET'), ctx(id)))).data;
    const res = await PUT(req('PUT', body({ name: '改名了', default_rent: 30000, equipment: [] })), ctx(id));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: { id } });
    const after = (await json(await getOne(req('GET'), ctx(id)))).data;
    expect(after).toMatchObject({ name: '改名了', default_rent: 30000, equipment: [], rental_unit_id: before.rental_unit_id });
    expect(after.updated_at).toMatch(/^\d{4}-/);
  });

  it('沒給型態時保留原型態', async () => {
    const id = await create(body({ type: '套房' }));
    await PUT(req('PUT', body({ type: undefined })), ctx(id));
    expect((await json(await getOne(req('GET'), ctx(id)))).data.type).toBe('套房');
  });

  it('本文有誤回 400，原資料不變', async () => {
    const id = await create();
    const res = await PUT(req('PUT', body({ name: '' })), ctx(id));
    expect(res.status).toBe(400);
    expect((await json(await getOne(req('GET'), ctx(id)))).data.name).toBe(NAME);
  });
});

describe('DELETE /api/properties/[id]（刪除）', () => {
  it('回 200 與 ID，之後查不到，租賃單位與錨點留在 registry', async () => {
    const id = await create();
    const unitId = (await json(await getOne(req('GET'), ctx(id)))).data.rental_unit_id;
    const res = await DELETE(req('DELETE'), ctx(id));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: { id } });
    expect((await getOne(req('GET'), ctx(id))).status).toBe(404);
    expect((await json(await getList())).data).toEqual([]);
    const { rows } = await kit.asOwner((db) => db.query('SELECT 1 FROM registry.rental_units WHERE id = $1', [unitId]));
    expect(rows).toHaveLength(1);
  });

  it('重複刪除回 404', async () => {
    const id = await create();
    await DELETE(req('DELETE'), ctx(id));
    expect((await DELETE(req('DELETE'), ctx(id))).status).toBe(404);
  });
});

// P0-02 AC1：A 組織以 B 組織的 ID 呼叫，回應與資料不存在完全相同。格式錯誤的 ID 也相同。
describe('跨組織與格式錯誤的 ID', () => {
  const NOT_FOUND = { error: '物件不存在' };

  async function snapshot(res: Response) {
    return { status: res.status, body: await res.text(), contentType: res.headers.get('content-type') };
  }

  const calls: Array<[string, (id: string) => Promise<Response>]> = [
    ['GET', (id) => getOne(req('GET'), ctx(id))],
    ['PUT（本文正確）', (id) => PUT(req('PUT', body()), ctx(id))],
    ['PUT（本文有誤）', (id) => PUT(req('PUT', body({ name: '' })), ctx(id))],
    ['DELETE', (id) => DELETE(req('DELETE'), ctx(id))],
  ];

  describe.each(calls)('%s', (_label, call) => {
    it('別的組織的 ID、不存在的 ID、格式錯誤的 ID，三者的回應逐位元相同', async () => {
      actAs(kit.orgB);
      const bId = await create(body({ name: 'B 的秘密物件' }));
      actAs(kit.orgA);

      const cross = await snapshot(await call(bId));
      const missing = await snapshot(await call(newUlid()));
      const malformed = await Promise.all(['12', 'not-a-ulid', 'z'.repeat(26), bId.toLowerCase(), `${bId}0`].map(async (id) => snapshot(await call(id))));

      expect(cross.status).toBe(404);
      expect(JSON.parse(cross.body)).toEqual(NOT_FOUND);
      expect(missing).toEqual(cross);
      for (const m of malformed) expect(m).toEqual(cross);
    });
  });

  it('A 的修改與刪除沒有動到 B 的物件', async () => {
    actAs(kit.orgB);
    const bId = await create(body({ name: 'B 的物件' }));
    actAs(kit.orgA);
    await PUT(req('PUT', body({ name: '被改掉了' })), ctx(bId));
    await DELETE(req('DELETE'), ctx(bId));
    actAs(kit.orgB);
    expect((await json(await getOne(req('GET'), ctx(bId)))).data.name).toBe('B 的物件');
  });
});

// 稽核（ADR-0019，MIL-81 建議項）：建立、修改、刪除與業務資料同一個交易寫事件，鏈由組織決定。
describe('稽核事件', () => {
  const events = (orgId: string) =>
    withTx({ kind: 'org', orgId }, async (tx) =>
      (await tx.query<{ action: string; actor_type: string; object_type: string; object_id: string; payload: Record<string, unknown> }>(
        `SELECT action, actor_type, object_type, object_id, payload FROM audit.events ORDER BY seq`,
      )).rows,
    );

  it('建立、修改、刪除各寫一筆，payload 不含名稱與地址', async () => {
    const id = await create();
    const unitId = (await json(await getOne(req('GET'), ctx(id)))).data.rental_unit_id;
    await PUT(req('PUT', body({ name: '改名', note: '新備註' })), ctx(id));
    await DELETE(req('DELETE'), ctx(id));
    expect(await events(kit.orgA)).toEqual([
      { action: 'property.create', actor_type: 'party', object_type: 'property', object_id: id, payload: { rental_unit_id: unitId } },
      { action: 'property.update', actor_type: 'party', object_type: 'property', object_id: id, payload: { changed: ['name', 'note'] } },
      { action: 'property.delete', actor_type: 'party', object_type: 'property', object_id: id, payload: { rental_unit_id: unitId } },
    ]);
  });

  it('寫在該組織自己的鏈，別的組織看不到', async () => {
    await create();
    expect(await events(kit.orgB)).toEqual([]);
  });

  it('changed 列出被改的欄位名稱：地址、設備也算，沒有變動時不寫事件', async () => {
    const id = await create();
    await PUT(req('PUT', body()), ctx(id)); // 內容完全相同
    await PUT(req('PUT', body({ address: '新地址', equipment: [] })), ctx(id));
    const rows = await events(kit.orgA);
    expect(rows.map((r) => r.action)).toEqual(['property.create', 'property.update']);
    expect(rows[1].payload).toEqual({ changed: ['address', 'equipment'] });
  });

  it('交易回滾時事件跟著回滾，物件也不留', async () => {
    await expect(
      withTx({ kind: 'org', orgId: kit.orgA }, async (tx) => {
        await createProperty(tx, { name: 'n', address: 'a', size: null, default_rent: null, note: '', equipment: [] });
        throw new Error('故意失敗');
      }),
    ).rejects.toThrow('故意失敗');
    expect(await events(kit.orgA)).toEqual([]);
    expect((await json(await getList())).data).toEqual([]);
  });

  it('找不到物件的修改與刪除不寫事件', async () => {
    await PUT(req('PUT', body()), ctx(newUlid()));
    await DELETE(req('DELETE'), ctx(newUlid()));
    expect(await events(kit.orgA)).toEqual([]);
  });
});
