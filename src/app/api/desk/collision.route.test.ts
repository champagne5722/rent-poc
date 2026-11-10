import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRequestContext } from '@/lib/auth/login-flow';
import { actAs, actAsContext } from '@/lib/pg/route-test-kit';
import { setupPracticeKit, type PracticeKit } from '@/lib/practice-entities/test-kit';
import { POST as createProperty } from '../properties/route';
import { GET as itemRoute } from './items/[id]/route';
import { GET as queueRoute } from './queue/route';

// MIL-144：審核台列出撞號項目。項目顯示宣稱方、宣稱的鍵與等待時間，不含既有登錄方的任何資料。
// 判定（同一產權、退回補件）屬 MIL-146，這裡只驗列出與詳情。

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));
let kit: PracticeKit;
vi.mock('@/lib/practice-entities/deps', () => ({ defaultFlowDeps: () => kit.deps }));

beforeAll(async () => {
  kit = await setupPracticeKit();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const KEY = { city: 'A', town: '02', section: '0021', buildingNo: '1234', subNo: '' };
const create = (name: string, key = KEY) =>
  createProperty(
    new NextRequest('http://localhost/api/properties', {
      method: 'POST',
      body: JSON.stringify({ name, address: '台北市大安區和平東路二段 100 號', equipment: [], anchor: { key } }),
    }),
  );

async function actAsOperator() {
  const op = await kit.operatorAccount();
  actAsContext(await resolveRequestContext(op.token, new Date(Date.now() + 120_000), 'test'));
}

async function collide(): Promise<string> {
  actAs(kit.kit.orgA);
  expect((await create('A 的秘密物件')).status).toBe(201);
  actAs(kit.kit.orgB);
  const res = await create('B 的物件');
  expect(res.status).toBe(201);
  // 回應不再帶審核單號（ADR-0028 決議 2）。測試從資料庫讀出審核單號，模擬營運者在審核台看到的項目
  const rows = await kit.kit.asOwner(async (db) => (await db.query<{ id: string }>(`SELECT id FROM registry.review_items WHERE type = 'anchor_collision'`)).rows);
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

describe('審核台列出撞號項目', () => {
  it('佇列有撞號項目：類型、宣稱方、宣稱的鍵與名稱、等待時間', async () => {
    const ticket = await collide();
    await actAsOperator();
    const res = await queueRoute(new Request('http://localhost/api/desk/queue?status=open'));
    expect(res.status).toBe(200);
    const item = (await json(res)).data.items.find((i: { id: string }) => i.id === ticket);
    expect(item).toMatchObject({
      type: 'anchor_collision',
      status: 'open',
      waitingMs: expect.any(Number),
      summary: {
        claimantOrgName: 'B 組織',
        claimedKey: { cityCode: 'A', townCode: '02', sectionCode: '0021', buildingNo: '01234', subNo: '000' },
        claimedKeyNames: { cityName: '臺北市', townName: '大安區', sectionName: '龍泉', sectionSubName: '一' },
      },
    });
    expect(item.waitingMs).toBeGreaterThanOrEqual(0);
  });

  it('佇列與詳情都不含既有登錄方的組織名稱與物件', async () => {
    const ticket = await collide();
    await actAsOperator();
    const queue = await (await queueRoute(new Request('http://localhost/api/desk/queue?status=open'))).text();
    const detailRes = await itemRoute(new Request('http://localhost/x'), { params: Promise.resolve({ id: ticket }) });
    expect(detailRes.status).toBe(200);
    const detailText = JSON.stringify(await json(detailRes));
    for (const text of [queue, detailText]) {
      expect(text).not.toContain('A 組織');
      expect(text).not.toContain('秘密');
    }
  });

  it('詳情頁帶宣稱方與宣稱的鍵，沒有判定用的資料', async () => {
    const ticket = await collide();
    await actAsOperator();
    const res = await itemRoute(new Request('http://localhost/x'), { params: Promise.resolve({ id: ticket }) });
    const { data } = await json(res);
    expect(data.item).toMatchObject({ id: ticket, type: 'anchor_collision', status: 'open' });
    expect(data.collision).toMatchObject({
      claimantOrgName: 'B 組織',
      claimedKey: { buildingNo: '01234' },
      limit: null,
    });
    expect(data.entity).toBeNull();
    expect(data.evidence).toEqual([]);
  });

  it('撞號超限項目：顯示宣稱方、上限與次數。超過次數時登錄照常成立', async () => {
    await kit.kit.asOwner((db) => db.query(`UPDATE registry.platform_settings SET int_value = 1`));
    await collide();
    // 同一個組織撞同一個鍵第二次會得到自己既有的物件，所以第二、三次撞 A 的另外兩個鍵
    const keys = [{ ...KEY, buildingNo: '2222' }, { ...KEY, buildingNo: '3333' }];
    actAs(kit.kit.orgA);
    for (const key of keys) expect((await create('A 的另一個物件', key)).status).toBe(201);
    actAs(kit.kit.orgB);
    expect((await create('B 的第二個物件', keys[0])).status).toBe(201);
    expect((await create('B 的第三個物件', keys[1])).status).toBe(201);
    await actAsOperator();
    const items = (await json(await queueRoute(new Request('http://localhost/api/desk/queue?status=open')))).data.items;
    const limited = items.find((i: { type: string }) => i.type === 'anchor_collision_limit');
    expect(limited).toMatchObject({ summary: { claimantOrgName: 'B 組織', limit: 1, hits: 2 } });
    const detail = (await json(await itemRoute(new Request('http://localhost/x'), { params: Promise.resolve({ id: limited.id }) }))).data;
    expect(detail.collision).toMatchObject({ claimantOrgName: 'B 組織', claimedKey: null, limit: 1, hits: 2 });
  });

  it('不是平台營運者：回 403', async () => {
    await collide();
    actAs(kit.kit.orgB);
    expect((await queueRoute(new Request('http://localhost/api/desk/queue?status=open'))).status).toBe(403);
  });
});
