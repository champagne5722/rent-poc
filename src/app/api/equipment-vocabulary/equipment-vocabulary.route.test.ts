import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { actAs, actAsError, nextAnchorKey, setupRouteDb, type RouteDb } from '@/lib/pg/route-test-kit';
import { isUlid } from '@/lib/pg/ulid';
import { Unauthenticated } from '@/lib/request-context';
import { EQUIPMENT_OPTIONS } from '@/lib/types';
import { POST as createProperty } from '../properties/route';
import { GET, POST } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-81：設備詞彙庫 route 的 response body。每個組織各有一份，平台預設在前、自訂在後。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(async () => {
  await kit.reset();
  actAs(kit.orgA);
});

type Item = { id: string; name: string; is_custom: boolean; created_at: string };
const json = (res: Response) => res.json() as Promise<{ data?: Item | Item[]; error?: string }>;
const list = async () => (await json(await GET())).data as Item[];
const add = (name: unknown) =>
  POST(new NextRequest('http://localhost/api/equipment-vocabulary', { method: 'POST', body: JSON.stringify({ name }) }));
const names = (items: Item[]) => items.map((i) => i.name);

describe('GET /api/equipment-vocabulary', () => {
  it('第一次使用就有平台預設項目，順序同 EQUIPMENT_OPTIONS，都不是自訂', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const items = (await json(res)).data as Item[];
    expect(names(items)).toEqual([...EQUIPMENT_OPTIONS]);
    expect(items.every((i) => !i.is_custom && isUlid(i.id))).toBe(true);
    expect(items[0]).toEqual({ id: items[0].id, name: '冷氣', is_custom: false, created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  });

  it('重複讀取不會重複補預設項目', async () => {
    await GET();
    await GET();
    expect(await list()).toHaveLength(EQUIPMENT_OPTIONS.length);
  });

  it('沒有登入回 401', async () => {
    actAsError(new Unauthenticated());
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: '尚未登入或沒有存取權' });
  });
});

describe('POST /api/equipment-vocabulary', () => {
  it('新增自訂項目回 201 與完整項目，之後排在清單最後', async () => {
    const res = await add('掃地機器人');
    expect(res.status).toBe(201);
    const { data } = await json(res);
    expect(data).toEqual({ id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/), name: '掃地機器人', is_custom: true, created_at: expect.any(String) });
    expect(names(await list()).at(-1)).toBe('掃地機器人');
  });

  it('平台預設在前、自訂在後，自訂依新增順序', async () => {
    for (const n of ['烘衣機', '掃地機器人', '空氣清淨機']) await add(n);
    const items = await list();
    expect(names(items)).toEqual([...EQUIPMENT_OPTIONS, '烘衣機', '掃地機器人', '空氣清淨機']);
    expect(items.slice(0, EQUIPMENT_OPTIONS.length).every((i) => !i.is_custom)).toBe(true);
    expect(items.slice(EQUIPMENT_OPTIONS.length).every((i) => i.is_custom)).toBe(true);
  });

  it('第一個動作就是新增時，預設項目仍然在前，且與預設同名算重複', async () => {
    const res = await add('冷氣');
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: '「冷氣」已在設備詞彙庫中' });
    expect(names(await list())).toEqual([...EQUIPMENT_OPTIONS]);
  });

  it('名稱重複回 409，不新增第二筆', async () => {
    await add('掃地機器人');
    const res = await add('掃地機器人');
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: '「掃地機器人」已在設備詞彙庫中' });
    expect((await list()).filter((i) => i.name === '掃地機器人')).toHaveLength(1);
  });

  it('名稱前後空白會被修掉', async () => {
    expect(((await json(await add('  烘衣機  '))).data as Item).name).toBe('烘衣機');
  });

  it.each([['空字串', ''], ['全空白', '   '], ['不是文字', 5], ['沒給', undefined]])('%s回 400', async (_label, name) => {
    const res = await add(name);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: '請輸入設備名稱' });
  });

  it('物件表單就地新增的設備（存物件時補進詞彙庫）同樣排在預設之後', async () => {
    await createProperty(
      new NextRequest('http://localhost/api/properties', {
        method: 'POST',
        body: JSON.stringify({ name: 'n', address: 'a', equipment: [{ name: '按摩浴缸', quantity: 1 }, { name: '冷氣', quantity: 1 }], anchor: { key: nextAnchorKey() } }),
      }),
    );
    const items = await list();
    expect(names(items)).toEqual([...EQUIPMENT_OPTIONS, '按摩浴缸']);
    expect(items.find((i) => i.name === '冷氣')?.is_custom).toBe(false);
  });
});

describe('組織隔離', () => {
  it('兩個組織能有同名的自訂項目', async () => {
    expect((await add('掃地機器人')).status).toBe(201);
    actAs(kit.orgB);
    expect((await add('掃地機器人')).status).toBe(201);
  });

  it('B 組織看不到 A 組織的自訂項目，自己也有一份完整的平台預設', async () => {
    await add('掃地機器人');
    actAs(kit.orgB);
    expect(names(await list())).toEqual([...EQUIPMENT_OPTIONS]);
  });

  it('撞名的回應不透露別的組織：B 加 A 已有的名稱，得到的是一般的新增成功', async () => {
    await add('A 專屬項目');
    actAs(kit.orgB);
    const res = await add('A 專屬項目');
    expect(res.status).toBe(201);
    actAs(kit.orgA);
    expect((await list()).filter((i) => i.name === 'A 專屬項目')).toHaveLength(1);
  });
});
