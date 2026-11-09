import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContract } from '@/lib/contracts';
import { withTx } from '@/lib/pg/database';
import { actAs, setupRouteDb, type RouteDb } from '@/lib/pg/route-test-kit';
import { newUlid } from '@/lib/pg/ulid';
import { createProperty, parsePropertyInput, type PropertyInput } from '@/lib/properties';
import type { ContractFields } from '@/lib/types';
import { POST as createContractRoute } from '../contracts/route';
import { POST as postAnchorKey } from './[id]/anchor-key/route';
import { DELETE, GET as getOne, PUT } from './[id]/route';
import { GET as listSublets, POST as addSublet } from './[id]/sublet-units/route';
import { GET as getList, POST } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-145：分租單位、顯示編碼、封存與刪除。連線是 PGlite 的 app_rw，合約也在 PostgreSQL（MIL-83），接縫在同一個交易內查。
// 段碼用真實資料：臺北市(A) 大安區(02) 龍泉 一(0021)。

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
const DISPLAY_CODE = /^A02-[0-9A-HJKMNP-TV-Z]{6}$/;

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, payload?: unknown) =>
  new NextRequest('http://localhost/api/properties/x', { method, body: payload === undefined ? undefined : JSON.stringify(payload) });

async function create(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await POST(req('POST', { name: '大安區溫馨兩房', address: '台北市大安區和平東路二段 100 號 3 樓', equipment: [], ...overrides }));
  expect(res.status).toBe(201);
  return (await json(res)).data.id;
}
const createKeyed = () => create({ anchor: { key: KEY } });
const get = async (id: string) => (await json(await getOne(req('GET'), ctx(id)))).data;
const sublet = (id: string, payload: unknown) => addSublet(req('POST', payload), ctx(id));
const count = (sql: string) => kit.asOwner(async (db) => (await db.query<{ n: number }>(sql)).rows[0].n);
const unitCount = () => count('SELECT count(*)::int AS n FROM registry.rental_units');

/** 在 PostgreSQL 放一份合約。status 與租期止日由測試決定，狀態在同組織的交易內直接改。 */
async function addContract(
  propertyId: string,
  status: string,
  endDate: string,
  contractType: 'lease' | 'management' = 'lease',
  orgId: string = kit.orgA,
): Promise<string> {
  const id = await withTx({ kind: 'org', orgId }, (tx) =>
    createContract(tx, { property_id: propertyId, fields: { endDate } as unknown as ContractFields, contract_type: contractType }),
  );
  await withTx({ kind: 'org', orgId }, (tx) => tx.query('UPDATE org.contracts SET status = $1 WHERE id = $2', [status, id]));
  return id;
}

describe('POST /api/properties/[id]/sublet-units（新增分租單位）', () => {
  it('在同一錨點下建分租單位與新物件：後綴 0001 起，房號只存標籤，顯示編碼不含建號', async () => {
    const wholeId = await createKeyed();
    const whole = await get(wholeId);

    const res = await sublet(wholeId, { label: '301', floor: '3F' });
    expect(res.status).toBe(201);
    const created = (await json(res)).data;
    expect(created).toEqual({ id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/), suffix: '0001' });

    const property = await get(created.id);
    expect(property).toMatchObject({
      name: '大安區溫馨兩房 301',
      address: whole.address,
      type: '套房',
      size: null,
      default_rent: null,
      equipment: [],
      archived_at: null,
      // 沿用同一錨點：產權摘要與整戶相同
      anchor: whole.anchor,
      unit: { suffix: '0001', label: '301', floor: '3F', unit_type: 'sublet', status: 'active', display_code: expect.stringMatching(DISPLAY_CODE) },
    });
    expect(property.rental_unit_id).not.toBe(whole.rental_unit_id);
    // 顯示編碼是縣市字母加鄉鎮編碼、連字號、單位 ULID 末 6 碼
    expect(property.unit.display_code).toBe(`A02-${property.rental_unit_id.slice(-6)}`);
    expect(JSON.stringify(property.unit)).not.toContain('01234');

    const second = (await json(await sublet(wholeId, { label: '3F-1', name: '三樓一號房', type: '雅房' }))).data;
    expect(second.suffix).toBe('0002');
    expect(await get(second.id)).toMatchObject({ name: '三樓一號房', type: '雅房', unit: { label: '3F-1', floor: null } });
  });

  it('錨點只有一個：新單位與整戶掛在同一個錨點', async () => {
    const wholeId = await createKeyed();
    await sublet(wholeId, { label: '301' });
    await sublet(wholeId, { label: '302' });
    expect(await count('SELECT count(*)::int AS n FROM registry.anchors')).toBe(1);
    expect(await unitCount()).toBe(3);
  });

  it('待驗證的錨點也能新增，顯示編碼為空，補建號後整戶與分租一起有編碼', async () => {
    const wholeId = await create();
    const created = (await json(await sublet(wholeId, { label: '301' }))).data;
    expect((await get(created.id)).unit.display_code).toBeNull();

    const keyRes = await postAnchorKey(req('POST', KEY), ctx(wholeId));
    expect(keyRes.status).toBe(200);
    expect((await get(created.id)).unit.display_code).toMatch(DISPLAY_CODE);
    expect((await get(wholeId)).unit.display_code).toMatch(DISPLAY_CODE);
  });

  it('改房號不改單位後綴', async () => {
    const wholeId = await createKeyed();
    const created = (await json(await sublet(wholeId, { label: '301' }))).data;
    await kit.asOwner((db) => db.query(`UPDATE registry.rental_units SET label = '3F-1' WHERE suffix = '0001'`));
    expect((await get(created.id)).unit).toMatchObject({ label: '3F-1', suffix: '0001' });
  });

  it('不得掛到別的組織的錨點：B 對 A 的物件、不存在的物件、格式錯誤的 ID，回應逐位元相同，也沒有建任何單位', async () => {
    const aId = await createKeyed();
    const unitsBefore = await unitCount();
    actAs(kit.orgB);
    const snapshot = async (res: Response) => ({ status: res.status, body: await res.text() });
    const cross = await snapshot(await sublet(aId, { label: '301' }));
    const missing = await snapshot(await sublet(newUlid(), { label: '301' }));
    const malformed = await snapshot(await sublet('not-a-ulid', { label: '301' }));
    const badBody = await snapshot(await sublet(aId, { label: '' }));
    expect(cross).toEqual({ status: 404, body: JSON.stringify({ error: '物件不存在' }) });
    expect(missing).toEqual(cross);
    expect(malformed).toEqual(cross);
    expect(badBody).toEqual(cross);
    expect(await unitCount()).toBe(unitsBefore);
  });

  it('本文有誤回 400，不建單位也不佔後綴', async () => {
    const wholeId = await createKeyed();
    const unitsBefore = await unitCount();
    for (const payload of [{}, { label: '' }, { label: '   ' }, { label: 'a'.repeat(41) }, { label: '301', floor: 3 }, { label: '301', type: '別墅' }, { label: '301', confirmed: 'yes' }, []]) {
      expect((await sublet(wholeId, payload)).status, JSON.stringify(payload)).toBe(400);
    }
    expect(await unitCount()).toBe(unitsBefore);
    expect((await json(await sublet(wholeId, { label: '301' }))).data.suffix).toBe('0001');
  });

  it('沒有登入回 401', async () => {
    const wholeId = await createKeyed();
    const { actAsError } = await import('@/lib/pg/route-test-kit');
    const { Unauthenticated } = await import('@/lib/request-context');
    actAsError(new Unauthenticated());
    expect((await sublet(wholeId, { label: '301' })).status).toBe(401);
  });

  describe('整戶有生效中的租賃合約（P0-06 AC4）', () => {
    it('已完成且租期未屆滿：先回 409 與 code，不建單位；帶 confirmed 才建立', async () => {
      const wholeId = await createKeyed();
      await addContract(wholeId, 'completed', '2999-12-31');
      const unitsBefore = await unitCount();

      const warned = await sublet(wholeId, { label: '301' });
      expect(warned.status).toBe(409);
      expect(await json(warned)).toEqual({ error: '整戶有已完成且租期未屆滿的租賃合約，新增分租單位前請先確認', code: 'whole_unit_active_lease' });
      expect(await unitCount()).toBe(unitsBefore);

      const confirmed = await sublet(wholeId, { label: '301', confirmed: true });
      expect(confirmed.status).toBe(201);
      expect(await unitCount()).toBe(unitsBefore + 1);
    });

    it('從分租物件新增時，也看整戶的合約', async () => {
      const wholeId = await createKeyed();
      const first = (await json(await sublet(wholeId, { label: '301' }))).data.id;
      await addContract(wholeId, 'completed', '2999-12-31');
      expect((await sublet(first, { label: '302' })).status).toBe(409);
    });

    it.each([
      ['租期已屆滿', 'completed', '2000-01-01', 'lease'],
      ['草稿', 'draft', '2999-12-31', 'lease'],
      ['簽署中', 'awaiting_landlord', '2999-12-31', 'lease'],
      ['已拒簽', 'declined', '2999-12-31', 'lease'],
      ['委託管理合約', 'completed', '2999-12-31', 'management'],
    ] as const)('不警告：%s', async (_label, status, endDate, type) => {
      const wholeId = await createKeyed();
      await addContract(wholeId, status, endDate, type);
      expect((await sublet(wholeId, { label: '301' })).status).toBe(201);
    });

    it('別的物件的合約不影響這個物件', async () => {
      const wholeId = await createKeyed();
      const other = await create({ address: '別處' });
      await addContract(other, 'completed', '2999-12-31');
      expect((await sublet(wholeId, { label: '301' })).status).toBe(201);
    });
  });

  it('封存的物件不能新增分租單位', async () => {
    const wholeId = await createKeyed();
    await addContract(wholeId, 'draft', '2999-12-31');
    await DELETE(req('DELETE'), ctx(wholeId));
    const res = await sublet(wholeId, { label: '301' });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: '物件已封存，不能新增分租單位' });
  });

  it('寫稽核事件：分租單位建立，payload 只有租賃單位 ID 與後綴，不含房號與地址', async () => {
    const wholeId = await createKeyed();
    const created = (await json(await sublet(wholeId, { label: '301', floor: '3F' }))).data;
    const unitId = (await get(created.id)).rental_unit_id;
    const events = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) =>
      (await tx.query(`SELECT action, object_type, object_id, payload FROM audit.events WHERE action = 'property.sublet_create'`)).rows,
    );
    expect(events).toEqual([
      { action: 'property.sublet_create', object_type: 'property', object_id: created.id, payload: { rental_unit_id: unitId, suffix: '0001' } },
    ]);
  });
});

describe('GET /api/properties/[id]/sublet-units（同一產權的單位）', () => {
  it('列出自己組織在同一錨點下的物件與單位，依後綴排序，含顯示編碼', async () => {
    const wholeId = await createKeyed();
    const a = (await json(await sublet(wholeId, { label: '301' }))).data.id;
    const b = (await json(await sublet(a, { label: '302' }))).data.id;
    const otherAnchor = await create({ address: '別處' });
    const res = await listSublets(req('GET'), ctx(a));
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data.map((u: { property_id: string; suffix: string; label: string | null }) => [u.property_id, u.suffix, u.label])).toEqual([
      [wholeId, '0000', null],
      [a, '0001', '301'],
      [b, '0002', '302'],
    ]);
    expect(data.map((u: { property_id: string }) => u.property_id)).not.toContain(otherAnchor);
    expect(data[1]).toMatchObject({ name: '大安區溫馨兩房 301', unit_type: 'sublet', status: 'active', archived_at: null, display_code: expect.stringMatching(DISPLAY_CODE) });
  });

  it('別的組織與不存在的 ID 回同一個 404', async () => {
    const aId = await createKeyed();
    actAs(kit.orgB);
    const cross = await listSublets(req('GET'), ctx(aId));
    const missing = await listSublets(req('GET'), ctx(newUlid()));
    expect(cross.status).toBe(404);
    expect(await cross.text()).toBe(await missing.text());
  });
});

describe('顯示編碼', () => {
  it('物件清單與單筆都有顯示編碼；整戶與分租共用縣市與鄉鎮，末 6 碼各自是自己的單位 ULID', async () => {
    const wholeId = await createKeyed();
    const subId = (await json(await sublet(wholeId, { label: '301' }))).data.id;
    const list = (await json(await getList())).data as Array<{ id: string; rental_unit_id: string; unit: { display_code: string } }>;
    for (const p of list) expect(p.unit.display_code).toBe(`A02-${p.rental_unit_id.slice(-6)}`);
    expect(list.map((p) => p.id).sort()).toEqual([wholeId, subId].sort());
  });

  it('別的組織的清單看不到這些物件與單位', async () => {
    await createKeyed();
    actAs(kit.orgB);
    expect((await json(await getList())).data).toEqual([]);
  });
});

describe('DELETE /api/properties/[id]（刪除或封存）', () => {
  it('沒有合約：刪除物件列，單位轉 retired，單位與錨點留在 registry', async () => {
    const wholeId = await createKeyed();
    const subId = (await json(await sublet(wholeId, { label: '301' }))).data.id;
    const subUnit = (await get(subId)).rental_unit_id;

    const res = await DELETE(req('DELETE'), ctx(subId));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: { id: subId, result: 'deleted' } });
    expect((await getOne(req('GET'), ctx(subId))).status).toBe(404);

    const { rows } = await kit.asOwner((db) => db.query('SELECT status, holder_count FROM registry.rental_units WHERE id = $1', [subUnit]));
    expect(rows).toEqual([{ status: 'retired', holder_count: 0 }]);
    expect(await count('SELECT count(*)::int AS n FROM registry.anchors')).toBe(1);
  });

  it('有任何合約（草稿也算）：改為封存，物件列還在，單位仍是 active', async () => {
    const id = await createKeyed();
    const unitId = (await get(id)).rental_unit_id;
    await addContract(id, 'draft', '2999-12-31');

    const res = await DELETE(req('DELETE'), ctx(id));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: { id, result: 'archived' } });

    const property = await get(id);
    expect(property.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const { rows } = await kit.asOwner((db) => db.query('SELECT status FROM registry.rental_units WHERE id = $1', [unitId]));
    expect(rows).toEqual([{ status: 'active' }]);
    // 封存的物件仍在清單，由畫面決定預設隱藏
    expect(((await json(await getList())).data as Array<{ id: string }>).map((p) => p.id)).toEqual([id]);
  });

  it('重複封存仍回 archived，封存時間不變，稽核只寫一筆', async () => {
    const id = await createKeyed();
    await addContract(id, 'completed', '2000-01-01');
    await DELETE(req('DELETE'), ctx(id));
    const first = (await get(id)).archived_at;
    const again = await DELETE(req('DELETE'), ctx(id));
    expect(await json(again)).toEqual({ data: { id, result: 'archived' } });
    expect((await get(id)).archived_at).toBe(first);
    const events = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) =>
      (await tx.query(`SELECT action, payload FROM audit.events WHERE action = 'property.archive'`)).rows,
    );
    expect(events).toEqual([{ action: 'property.archive', payload: { rental_unit_id: (await get(id)).rental_unit_id } }]);
  });

  it('另一個組織的合約資料不會影響判斷：合約只認物件 ID', async () => {
    const id = await createKeyed();
    const bProperty = await withTx({ kind: 'org', orgId: kit.orgB }, (tx) => createProperty(tx, (parsePropertyInput({ name: 'B 的', address: '別處', equipment: [] }) as { ok: true; value: PropertyInput }).value));
    await addContract(bProperty, 'draft', '2999-12-31', 'lease', kit.orgB);
    expect(await json(await DELETE(req('DELETE'), ctx(id)))).toEqual({ data: { id, result: 'deleted' } });
  });

  it('封存的物件不得編輯、建合約、補建號', async () => {
    const id = await create();
    await addContract(id, 'draft', '2999-12-31');
    await DELETE(req('DELETE'), ctx(id));

    const put = await PUT(req('PUT', { name: '改名', address: '改地址', equipment: [] }), ctx(id));
    expect(put.status).toBe(409);
    expect(await json(put)).toEqual({ error: '物件已封存，不能編輯' });
    expect((await get(id)).name).toBe('大安區溫馨兩房');

    const contract = await createContractRoute(
      new NextRequest('http://localhost/api/contracts', { method: 'POST', body: JSON.stringify({ property_id: id }) }),
    );
    expect(contract.status).toBe(409);
    expect(await json(contract)).toEqual({ error: '物件已封存，不能建立合約' });

    const key = await postAnchorKey(req('POST', KEY), ctx(id));
    expect(key.status).toBe(409);
    expect(await json(key)).toEqual({ error: '物件已封存，不能補建號' });
  });

  it('封存寫稽核事件，payload 只有租賃單位 ID', async () => {
    const id = await create();
    await addContract(id, 'draft', '2999-12-31');
    await DELETE(req('DELETE'), ctx(id));
    const events = await withTx({ kind: 'org', orgId: kit.orgA }, async (tx) =>
      (await tx.query(`SELECT action, object_id, payload FROM audit.events ORDER BY seq`)).rows,
    );
    expect(events.map((e) => e.action)).toEqual(['property.create', 'contract.create', 'property.archive']);
  });
});

describe('整戶改分租沿用同一產權錨點', () => {
  it('整戶物件刪除後單位 retired，原錨點不變；再從別的來源新增分租，後綴不重用 0000', async () => {
    const wholeId = await createKeyed();
    const first = (await json(await sublet(wholeId, { label: '301' }))).data.id;
    await DELETE(req('DELETE'), ctx(wholeId));
    expect(await count(`SELECT count(*)::int AS n FROM registry.rental_units WHERE status = 'retired'`)).toBe(1);

    const second = (await json(await sublet(first, { label: '302' }))).data;
    expect(second.suffix).toBe('0002');
    expect(await count('SELECT count(*)::int AS n FROM registry.anchors')).toBe(1);
  });
});
