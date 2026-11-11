import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceOwnership, createPropertyAt, lapseOwnership } from '@/lib/ownership/test-kit';
import { actAs, actAsParty, setupRouteDb, type RouteDb } from '@/lib/pg/route-test-kit';
import { flattenPropertyGroups } from '@/lib/properties/group-rows';
import { statusPresentation } from '@/lib/status-presentation';
import type { PropertyGroup } from '@/lib/types';
import { POST as addSublet } from './[id]/sublet-units/route';
import { GET as getList, POST } from './route';

vi.mock('@/lib/current-request-context', async () => ({
  requestContext: (await import('@/lib/pg/route-test-kit')).stubRequestContext,
}));

// MIL-202：物件列表依物件分組（GET /api/properties?group=object）。連線是 PGlite 的 app_rw。
// 驗證 response body 的分組與核對狀態，以及不洩漏別的組織與登記庫的資料。
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

const SHARED_KEY = { city: 'A', town: '02', section: '0021', buildingNo: '7777', subNo: '' };

type Group = Omit<PropertyGroup, 'units'> & {
  units: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const json = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, url = 'http://localhost/api/properties', payload?: unknown) =>
  new NextRequest(url, { method, body: payload === undefined ? undefined : JSON.stringify(payload) });

const groupsText = async () => (await getList(req('GET', 'http://localhost/api/properties?group=object'))).text();
const groups = async (): Promise<Group[]> => (JSON.parse(await groupsText()) as { data: Group[] }).data;

async function register(name: string, key: Record<string, string>): Promise<string> {
  const res = await POST(req('POST', undefined, { name, address: '台北市大安區和平東路二段 100 號 3 樓', equipment: [], anchor: { key } }));
  expect(res.status).toBe(201);
  return (await json(res)).data.id;
}

async function sublet(sourceId: string, label: string, name?: string): Promise<string> {
  const res = await addSublet(req('POST', undefined, { label, name }), ctx(sourceId));
  expect(res.status).toBe(201);
  return (await json(res)).data.id;
}

const unitIdOf = (propertyId: string, orgId: string = kit.orgA) =>
  kit.asOwner(async (db) => {
    await db.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
    return (await db.query<{ rental_unit_id: string }>('SELECT rental_unit_id FROM org.properties WHERE id = $1', [propertyId])).rows[0].rental_unit_id;
  });

const mergeUnit = (unitId: string, intoUnitId: string) =>
  kit.asOwner((db) => db.query(`UPDATE registry.rental_units SET status = 'merged', merged_into_id = $2 WHERE id = $1`, [unitId, intoUnitId]));

describe('依物件分組的讀取', () => {
  it('沒有物件時回空陣列', async () => {
    expect(await groups()).toEqual([]);
  });

  it('整戶與分租單位歸同一筆：組的 id 是整戶的營運資料 ID，單位依後綴排序並帶自訂名稱', async () => {
    const whole = await createPropertyAt(kit, 'verified', { name: '大安區整層' });
    const room301 = await sublet(whole, '301', '大安區 301 房');
    const room302 = await sublet(whole, '302', '大安區 302 房');
    const other = await createPropertyAt(kit, 'verified', { name: '另一間房子' });

    const result = await groups();
    expect(result.map((g) => g.id)).toEqual([other, whole]); // 新的在前
    const group = result.find((g) => g.id === whole)!;
    expect(group.units.map((u) => [u.id, u.name, u.unit.suffix])).toEqual([
      [whole, '大安區整層', '0000'],
      [room301, '大安區 301 房', '0001'],
      [room302, '大安區 302 房', '0002'],
    ]);
    expect(result.find((g) => g.id === other)!.units.map((u) => u.id)).toEqual([other]);
  });

  it('組的欄位：核對狀態與建號在組，單位不重複帶；單位沿用物件的欄位', async () => {
    const whole = await createPropertyAt(kit, 'verified');
    await sublet(whole, '301');
    const [group] = await groups();
    expect(Object.keys(group).sort()).toEqual(['address', 'anchor', 'id', 'units', 'verification_status']);
    expect(group.verification_status).toBe('verified');
    expect(group.anchor).toMatchObject({ city_code: 'A', town_code: '02', section_code: '0021', section_name: '龍泉 一' });
    expect(group.address).toBe('台北市大安區某路 1 號');
    for (const unit of group.units) {
      expect(unit).not.toHaveProperty('anchor');
      expect(unit).not.toHaveProperty('verification_status');
      expect(unit).toMatchObject({
        id: expect.any(String),
        rental_unit_id: expect.any(String),
        name: expect.any(String),
        unit: expect.objectContaining({ suffix: expect.any(String) }),
        archived_at: null,
      });
    }
  });

  it('核對狀態：沒送件、待核對、已核對、文件不符、已失效，名稱都登記在狀態呈現表', async () => {
    const unsubmitted = await createPropertyAt(kit, 'unsubmitted');
    const pending = await createPropertyAt(kit, 'pending_verification');
    const verified = await createPropertyAt(kit, 'verified');
    const failed = await createPropertyAt(kit, 'failed');
    const lapsed = await createPropertyAt(kit, 'verified');
    await lapseOwnership(kit, lapsed);

    const status = new Map((await groups()).map((g) => [g.id, g.verification_status]));
    expect(status.get(unsubmitted)).toBe('pending_verification');
    expect(status.get(pending)).toBe('pending_verification');
    expect(status.get(verified)).toBe('verified');
    expect(status.get(failed)).toBe('failed');
    expect(status.get(lapsed)).toBe('pending_verification');
    expect((['pending_verification', 'verified', 'failed'] as const).map((k) => statusPresentation('propertyVerification', k).label)).toEqual([
      '待平台核對文件',
      '已核對',
      '文件不符',
    ]);
  });

  it('封存的單位照樣列在組裡並帶 archived_at', async () => {
    const whole = await createPropertyAt(kit, 'verified');
    const room = await sublet(whole, '301');
    await kit.asOwner(async (db) => {
      await db.query(`SELECT set_config('app.org_id', $1, false)`, [kit.orgA]);
      await db.query(`UPDATE org.properties SET archived_at = now() WHERE id = $1`, [room]);
    });
    const [group] = await groups();
    expect(group.units.map((u) => [u.id, u.archived_at !== null])).toEqual([
      [whole, false],
      [room, true],
    ]);
  });

  it('沒有整戶時，組的 id 是後綴最小的單位', async () => {
    const whole = await createPropertyAt(kit, 'verified');
    const room1 = await sublet(whole, '301');
    const room2 = await sublet(whole, '302');
    await kit.asOwner(async (db) => {
      await db.query(`SELECT set_config('app.org_id', $1, false)`, [kit.orgA]);
      await db.query('DELETE FROM org.properties WHERE id = $1', [whole]);
    });
    const [group] = await groups();
    expect(group.id).toBe(room1);
    expect(group.units.map((u) => u.id)).toEqual([room1, room2]);
  });

  it('扁平的 GET /api/properties 形狀不變：一列一個租賃單位，含 anchor 與 verification_status', async () => {
    const whole = await createPropertyAt(kit, 'verified');
    const room = await sublet(whole, '301');
    const flat = (await json(await getList())).data as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(flat.map((p) => p.id).sort()).toEqual([whole, room].sort());
    for (const p of flat) expect(p).toMatchObject({ verification_status: 'verified', anchor: expect.objectContaining({ city_code: 'A' }) });
    expect(flat.every((p) => !('units' in p))).toBe(true);
  });

  it('攤平後與扁平列表逐列相同，物件列表頁的畫面不變', async () => {
    const whole = await createPropertyAt(kit, 'verified', { name: 'A 整戶' });
    await sublet(whole, '301', 'A 301');
    await createPropertyAt(kit, 'failed', { name: '另一間' });
    const flat = (await json(await getList())).data;
    expect(flattenPropertyGroups((await groups()) as PropertyGroup[])).toEqual(flat);
  });

  it('不是組織身分回 403', async () => {
    actAsParty();
    expect((await getList(req('GET', 'http://localhost/api/properties?group=object'))).status).toBe(403);
  });
});

describe('被合併的單位', () => {
  it('同一組織兩個物件的單位合併到同一個存續單位：只留較早建立的那一筆，名稱取較早的', async () => {
    const earlier = await createPropertyAt(kit, 'verified', { name: '較早的名稱' });
    const later = await createPropertyAt(kit, 'verified', { name: '較晚的名稱' });
    await mergeUnit(await unitIdOf(later), await unitIdOf(earlier));

    const result = await groups();
    expect(result).toHaveLength(1);
    expect(result[0].units.map((u) => [u.id, u.name])).toEqual([[earlier, '較早的名稱']]);
  });

  it('存續單位的分租單位與被合併單位的錨點一起歸到存續物件：整戶合併後，組內沒有重複的整戶', async () => {
    const survivor = await createPropertyAt(kit, 'verified', { name: '存續整戶' });
    const room = await sublet(survivor, '301', '存續 301');
    const merged = await createPropertyAt(kit, 'verified', { name: '被合併整戶' });
    const mergedRoom = await sublet(merged, '501', '被合併 501');
    // 平台營運者合併：整戶單位併入存續整戶，被合併的物件錨點併入存續錨點。分租單位仍指向被合併的錨點
    const survivorUnit = await unitIdOf(survivor);
    const mergedUnit = await unitIdOf(merged);
    await mergeUnit(mergedUnit, survivorUnit);
    await kit.asOwner(async (db) => {
      const { rows } = await db.query<{ unit: string; anchor: string }>(
        `SELECT id AS unit, anchor_id AS anchor FROM registry.rental_units WHERE id = ANY($1::text[])`,
        [[survivorUnit, mergedUnit]],
      );
      const anchorOf = (u: string) => rows.find((r) => r.unit === u)!.anchor;
      await db.query(`UPDATE registry.anchors SET status = 'merged', merged_into_id = $2 WHERE id = $1`, [anchorOf(mergedUnit), anchorOf(survivorUnit)]);
    });

    const result = await groups();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(survivor);
    expect(result[0].units.map((u) => u.id)).toEqual([survivor, room, mergedRoom]);
    expect(result[0].units.filter((u) => u.unit.suffix === '0000')).toHaveLength(1);
  });

  it('併入別的組織的存續單位：只回呼叫者自己的資料，沒有別的組織的物件、單位或登記庫 ID', async () => {
    actAs(kit.orgB);
    const bWhole = await createPropertyAt(kit, 'verified', { name: 'B 的整戶' });
    const bRoom = await sublet(bWhole, '301', 'B 的 301');
    const bUnit = await unitIdOf(bWhole, kit.orgB);
    actAs(kit.orgA);
    const aWhole = await createPropertyAt(kit, 'verified', { name: 'A 的整戶' });
    await mergeUnit(await unitIdOf(aWhole), bUnit);

    const text = await groupsText();
    const result = (JSON.parse(text) as { data: Group[] }).data;
    expect(result).toHaveLength(1);
    expect(result[0].units.map((u) => u.id)).toEqual([aWhole]);
    expect(result[0].units[0].unit.status).toBe('merged');

    const bAnchor = await kit.asOwner(async (db) => (await db.query<{ anchor_id: string }>('SELECT anchor_id FROM registry.rental_units WHERE id = $1', [bUnit])).rows[0].anchor_id);
    for (const secret of [bWhole, bRoom, bUnit, bAnchor]) expect(text).not.toContain(secret);
    expect(text).not.toContain('B 的');
  });
});

describe('隔離與統一回應', () => {
  it('兩個組織各自只看到自己的物件', async () => {
    const a = await createPropertyAt(kit, 'verified', { name: 'A 的' });
    actAs(kit.orgB);
    const b = await createPropertyAt(kit, 'failed', { name: 'B 的' });
    expect((await groups()).map((g) => [g.id, g.verification_status])).toEqual([[b, 'failed']]);
    actAs(kit.orgA);
    expect((await groups()).map((g) => [g.id, g.verification_status])).toEqual([[a, 'verified']]);
  });

  it('乙公司登錄同一個建號：甲公司的回應逐位元相同，狀態不變', async () => {
    const aId = await register('甲的物件', SHARED_KEY);
    await sublet(aId, '301');
    const before = await groupsText();

    actAs(kit.orgB);
    const bId = await register('乙的物件', SHARED_KEY);
    await advanceOwnership(kit, bId, 'failed', { orgId: kit.orgB });
    actAs(kit.orgA);

    expect(await groupsText()).toBe(before);
  });

  it('甲公司已核對後，乙公司登錄同一個建號並送件：甲公司的回應仍相同', async () => {
    const aId = await register('甲的物件', SHARED_KEY);
    await advanceOwnership(kit, aId, 'verified');
    const before = await groupsText();
    expect(JSON.parse(before).data[0].verification_status).toBe('verified');

    actAs(kit.orgB);
    const bId = await register('乙的物件', SHARED_KEY);
    await advanceOwnership(kit, bId, 'pending_verification', { orgId: kit.orgB });
    actAs(kit.orgA);

    expect(await groupsText()).toBe(before);
  });

  it('撞號的一方仍看到自己填的鍵，狀態是待平台核對文件，回應裡沒有對方的物件', async () => {
    await register('甲的物件', SHARED_KEY);
    actAs(kit.orgB);
    const bId = await register('乙的物件', { ...SHARED_KEY });
    const text = await groupsText();
    const [group] = (JSON.parse(text) as { data: Group[] }).data;
    expect(group.id).toBe(bId);
    expect(group.verification_status).toBe('pending_verification');
    expect(group.anchor).toMatchObject({ city_code: 'A', town_code: '02', section_code: '0021', building_no: '07777' });
    expect(text).not.toContain('甲的物件');
  });

  it('回應不含登記庫的錨點 ID，也不含分組鍵', async () => {
    const whole = await createPropertyAt(kit, 'verified');
    await sublet(whole, '301');
    const text = await groupsText();
    const registryIds = await kit.asOwner(async (db) => (await db.query<{ id: string }>('SELECT id FROM registry.anchors')).rows.map((r) => r.id));
    expect(registryIds.length).toBeGreaterThan(0);
    for (const id of registryIds) expect(text).not.toContain(id);
    expect(text).not.toMatch(/group_key|survivor_key|anchor_id/);
    expect(text).not.toMatch(/[0-9a-f]{32}/);
  });
});
