import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import seedJson from '../registry/section-code/seed.json';
import type { SectionCodeSeed } from '../registry/section-code/types';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-143：段碼參照表、錨點鍵的外鍵與 CHECK、補建號與讀取函式。
// 一律以 app_rw 從外部觀察；要看 registry 的列或繞過函式塞壞資料時，才用 asRole 換成 app_owner。

const seed = seedJson as SectionCodeSeed;

let testDb: TestDb;
let db: PGliteInterface;
let withTx: WithTx;
const orgA = newUlid();
const orgB = newUlid();

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(() => testDb.close());

beforeEach(async () => {
  db = await testDb.fresh();
  withTx = createWithTx(pgliteDriver(db));
  await asRole(db, 'app_owner', () =>
    db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]),
  );
});

/** 組織 orgId 建一個物件（待驗證錨點加 0000 單位），回傳錨點與單位 ID。 */
async function createProperty(orgId: string, name = '物件') {
  return withTx({ kind: 'org', orgId }, async (tx) => {
    const anchorId = newUlid();
    const unitId = newUlid();
    await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [anchorId, unitId, '某地址']);
    await tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [
      newUlid(),
      orgId,
      unitId,
      name,
      '某地址',
    ]);
    return { anchorId, unitId };
  });
}

const assignKey = (
  tx: OrgTx,
  anchorId: string,
  key: { city?: string; town?: string; section?: string; building?: string; sub?: string | null } = {},
) =>
  tx.query<{ outcome: string }>('SELECT * FROM registry.assign_anchor_key($1, $2, $3, $4, $5, $6, $7, $8)', [
    anchorId,
    key.city ?? 'A',
    key.town ?? '02',
    key.section ?? '0001',
    key.building ?? '1234',
    key.sub === undefined ? null : key.sub,
    newUlid(),
    newUlid(),
  ]);

/** 第一個沒註銷、沒有別名的段，測試用。 */
const plain = seed.sections.find((s) => !s.canceled && s.aliasTownCodes.length === 0)!;
const canceled = seed.sections.find((s) => s.canceled)!;
const k = { city: plain.cityCode, town: plain.townCode, section: plain.code };

describe('段碼參照表', () => {
  it('app_rw 不能直接讀寫（只能經函式）', async () => {
    await expect(db.query('SELECT * FROM registry.areas')).rejects.toThrow(/permission denied/);
    await expect(db.query('SELECT * FROM registry.sections')).rejects.toThrow(/permission denied/);
    await expect(db.query(`INSERT INTO registry.sections (city_code, town_code, code, name) VALUES ('A','01','9999','x')`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('migration 載入的行政區與 seed 檔逐列相同', async () => {
    const { rows } = await asRole(db, 'app_owner', () =>
      db.query<{ city_code: string; town_code: string; city_name: string; town_name: string }>(
        'SELECT city_code, town_code, city_name, town_name FROM registry.areas ORDER BY city_code, town_code',
      ),
    );
    const names = new Map(seed.cities.map((c) => [c.code, c.name]));
    const expected = seed.towns
      .map((t) => ({ city_code: t.cityCode, town_code: t.code, city_name: names.get(t.cityCode), town_name: t.name }))
      .sort((a, b) => (a.city_code + a.town_code).localeCompare(b.city_code + b.town_code));
    expect(rows).toHaveLength(365);
    expect(rows).toEqual(expected);
  });

  it('migration 載入的段與 seed 檔逐列相同，含別名行政區與註銷旗標', async () => {
    const { rows } = await asRole(db, 'app_owner', () =>
      db.query<{
        city_code: string;
        town_code: string;
        code: string;
        name: string;
        sub_name: string;
        alias_town_codes: string[];
        canceled: boolean;
      }>(
        'SELECT city_code, town_code, code, name, sub_name, alias_town_codes, canceled FROM registry.sections ORDER BY city_code, town_code, code',
      ),
    );
    const expected = seed.sections
      .map((s) => ({
        city_code: s.cityCode,
        town_code: s.townCode,
        code: s.code,
        name: s.name,
        sub_name: s.subName,
        alias_town_codes: s.aliasTownCodes,
        canceled: s.canceled,
      }))
      .sort((a, b) => (a.city_code + a.town_code + a.code).localeCompare(b.city_code + b.town_code + b.code));
    expect(rows).toHaveLength(17878);
    expect(rows).toEqual(expected);
  });

  it('跨越段只有一列（主行政區），別名行政區記在欄位裡', async () => {
    const { rows } = await asRole(db, 'app_owner', () =>
      db.query(`SELECT town_code, alias_town_codes FROM registry.sections WHERE city_code = 'F' AND code = '1818'`),
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { alias_town_codes: string[] }).alias_town_codes.length).toBeGreaterThan(0);
  });

  it('桃園 0400 與嘉義縣 1754 維持兩個不同的段', async () => {
    const { rows } = await asRole(db, 'app_owner', () =>
      db.query<{ city_code: string; n: string }>(
        `SELECT city_code, count(*)::text AS n FROM registry.sections
          WHERE (city_code = 'H' AND code = '0400') OR (city_code = 'Q' AND code = '1754')
          GROUP BY city_code ORDER BY city_code`,
      ),
    );
    expect(rows).toEqual([
      { city_code: 'H', n: '2' },
      { city_code: 'Q', n: '2' },
    ]);
  });

  it('參照表只增改，不刪列', async () => {
    await expect(asRole(db, 'app_owner', () => db.query(`DELETE FROM registry.sections WHERE code = '0001'`))).rejects.toThrow(
      /只增改/,
    );
    await expect(asRole(db, 'app_owner', () => db.query(`DELETE FROM registry.areas WHERE city_code = 'A'`))).rejects.toThrow(/只增改/);
  });
});

describe('錨點鍵的外鍵與 CHECK', () => {
  const insertAnchor = (cols: Record<string, unknown>) =>
    asRole(db, 'app_owner', () => {
      const entries = Object.entries({ id: newUlid(), ...cols });
      return db.query(
        `INSERT INTO registry.anchors (${entries.map(([c]) => c).join(', ')}) VALUES (${entries.map((_, i) => `$${i + 1}`).join(', ')})`,
        entries.map(([, v]) => v),
      );
    });
  const full = { city_code: plain.cityCode, town_code: plain.townCode, section_code: plain.code, building_no: '00123', sub_no: '000' };

  it('合法的完整鍵可寫入', async () => {
    await expect(insertAnchor({ ...full, status: 'keyed' })).resolves.toBeDefined();
  });

  it.each([
    ['縣市小寫', { city_code: 'a' }],
    ['縣市兩碼', { city_code: 'AB' }],
    ['鄉鎮市區一碼', { town_code: '2' }],
    ['鄉鎮市區非數字', { town_code: 'AB' }],
    ['段碼三碼', { section_code: '001' }],
    ['段碼五碼', { section_code: '00001' }],
    ['建號四碼（沒補零）', { building_no: '1234' }],
    ['建號非數字', { building_no: '0012A' }],
    ['分號兩碼', { sub_no: '00' }],
  ])('%s被 CHECK 擋下', async (_name, patch) => {
    await expect(insertAnchor({ ...full, ...patch })).rejects.toThrow(/anchors_|violates|違反/);
  });

  it('參照表沒有的鄉鎮市區被外鍵擋下', async () => {
    await expect(insertAnchor({ ...full, town_code: '99' })).rejects.toThrow(/foreign key|外鍵/i);
  });

  it('參照表沒有的段被外鍵擋下', async () => {
    await expect(insertAnchor({ ...full, section_code: '9999' })).rejects.toThrow(/foreign key|外鍵/i);
  });

  it('鍵只填一部分被擋下', async () => {
    await expect(insertAnchor({ city_code: 'A', town_code: '02' })).rejects.toThrow(/anchors_key_all_or_none/);
  });

  it('已建號的錨點必須有鍵', async () => {
    await expect(insertAnchor({ status: 'keyed' })).rejects.toThrow(/anchors_keyed_has_key/);
  });

  it('待驗證的錨點五欄全空可寫入，座標要成對且在範圍內', async () => {
    await expect(insertAnchor({})).resolves.toBeDefined();
    await expect(insertAnchor({ latitude: 25.03 })).rejects.toThrow(/anchors_coordinates/);
    await expect(insertAnchor({ latitude: 91, longitude: 121 })).rejects.toThrow(/anchors_coordinates/);
    await expect(insertAnchor({ latitude: 25.03, longitude: 121.56 })).resolves.toBeDefined();
  });
});

describe('registry.assign_anchor_key（補建號）', () => {
  it('沒有撞號時錨點轉已建號，建號補成 5 碼，空白分號存 000', async () => {
    const { anchorId } = await createProperty(orgA);
    const status = await withTx({ kind: 'org', orgId: orgA }, async (tx) => {
      const { rows } = await assignKey(tx, anchorId, { ...k, building: '1234', sub: '' });
      return rows[0].outcome;
    });
    expect(status).toBe('keyed');
    const { rows } = await asRole(db, 'app_owner', () =>
      db.query(`SELECT status, city_code, town_code, section_code, building_no, sub_no FROM registry.anchors WHERE id = $1`, [anchorId]),
    );
    expect(rows).toEqual([
      { status: 'keyed', city_code: plain.cityCode, town_code: plain.townCode, section_code: plain.code, building_no: '01234', sub_no: '000' },
    ]);
  });

  it('分號 1 到 3 位補成 3 碼', async () => {
    const { anchorId } = await createProperty(orgA);
    await withTx({ kind: 'org', orgId: orgA }, (tx) => assignKey(tx, anchorId, { ...k, building: '5', sub: '7' }));
    const { rows } = await asRole(db, 'app_owner', () =>
      db.query(`SELECT building_no, sub_no FROM registry.anchors WHERE id = $1`, [anchorId]),
    );
    expect(rows).toEqual([{ building_no: '00005', sub_no: '007' }]);
  });

  it.each([
    ['建號空白', { building: '' }],
    ['建號全為零', { building: '00000' }],
    ['建號超過 5 位', { building: '123456' }],
    ['建號含字母', { building: '12A' }],
    ['分號超過 3 位', { sub: '1234' }],
    ['縣市小寫', { city: 'a' }],
  ])('%s：回格式錯誤', async (_name, patch) => {
    const { anchorId } = await createProperty(orgA);
    await expect(withTx({ kind: 'org', orgId: orgA }, (tx) => assignKey(tx, anchorId, { ...k, ...patch }))).rejects.toMatchObject({
      code: '22023',
    });
  });

  it('段碼不存在或已註銷：回錯誤，錨點維持待驗證', async () => {
    const { anchorId } = await createProperty(orgA);
    await expect(
      withTx({ kind: 'org', orgId: orgA }, (tx) => assignKey(tx, anchorId, { city: 'A', town: '02', section: '9999' })),
    ).rejects.toThrow(/段小段不存在/);
    await expect(
      withTx({ kind: 'org', orgId: orgA }, (tx) =>
        assignKey(tx, anchorId, { city: canceled.cityCode, town: canceled.townCode, section: canceled.code }),
      ),
    ).rejects.toThrow(/已註銷/);
    const { rows } = await asRole(db, 'app_owner', () => db.query(`SELECT status FROM registry.anchors WHERE id = $1`, [anchorId]));
    expect(rows).toEqual([{ status: 'pending_verification' }]);
  });

  it('別名行政區不是鍵：只接受主行政區', async () => {
    const aliased = seed.sections.find((s) => s.aliasTownCodes.length > 0 && !s.canceled)!;
    const { anchorId } = await createProperty(orgA);
    await expect(
      withTx({ kind: 'org', orgId: orgA }, (tx) =>
        assignKey(tx, anchorId, { city: aliased.cityCode, town: aliased.aliasTownCodes[0], section: aliased.code }),
      ),
    ).rejects.toThrow(/段小段不存在/);
  });

  it('別的組織的錨點與不存在的錨點，錯誤完全相同', async () => {
    const mine = await createProperty(orgA);
    const asB = await withTx({ kind: 'org', orgId: orgB }, (tx) => assignKey(tx, mine.anchorId, k)).catch((e) => e);
    const missing = await withTx({ kind: 'org', orgId: orgB }, (tx) => assignKey(tx, newUlid(), k)).catch((e) => e);
    expect(asB).toMatchObject({ code: 'P0002' });
    expect({ code: asB.code, message: asB.message }).toEqual({ code: missing.code, message: missing.message });
    const { rows } = await asRole(db, 'app_owner', () => db.query(`SELECT status FROM registry.anchors WHERE id = $1`, [mine.anchorId]));
    expect(rows).toEqual([{ status: 'pending_verification' }]);
  });

  it('已建號的物件通過核對前能修正建號（MIL-196）：回 keyed，鍵更新', async () => {
    const { anchorId } = await createProperty(orgA);
    await withTx({ kind: 'org', orgId: orgA }, (tx) => assignKey(tx, anchorId, k));
    const fixed = await withTx({ kind: 'org', orgId: orgA }, (tx) => assignKey(tx, anchorId, { ...k, building: '9' }));
    expect(fixed.rows[0].outcome).toBe('keyed');
    const { rows } = await asRole(db, 'app_owner', () => db.query(`SELECT status, building_no FROM registry.anchors WHERE id = $1`, [anchorId]));
    expect(rows).toEqual([{ status: 'keyed', building_no: '00009' }]);
  });

  it('已合併或停用的物件不能修正建號：回 55000，訊息稱「物件」', async () => {
    const { anchorId } = await createProperty(orgA);
    await asRole(db, 'app_owner', () => db.query(`UPDATE registry.anchors SET status = 'retired' WHERE id = $1`, [anchorId]));
    await expect(withTx({ kind: 'org', orgId: orgA }, (tx) => assignKey(tx, anchorId, k))).rejects.toMatchObject({
      code: '55000',
      message: '物件目前不能修正建號',
    });
  });

  it('沒有組織脈絡時拒絕', async () => {
    const { anchorId } = await createProperty(orgA);
    await expect(withTx({ kind: 'control' }, (tx) => tx.query('SELECT * FROM registry.assign_anchor_key($1, $2, $3, $4, $5, NULL, $6, $7)', [anchorId, k.city, k.town, k.section, '1', newUlid(), newUlid()]))).rejects.toThrow(/組織脈絡/);
  });
});

describe('registry.get_anchors_for_units', () => {
  const read = (orgId: string, unitIds: string[]) =>
    withTx({ kind: 'org', orgId }, async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>('SELECT * FROM registry.get_anchors_for_units($1::text[])', [unitIds]);
      return rows;
    });

  it('待驗證的錨點：狀態與座標，鍵與名稱為空', async () => {
    const { unitId, anchorId } = await createProperty(orgA);
    const rows = await read(orgA, [unitId]);
    expect(rows).toEqual([
      expect.objectContaining({
        unit_id: unitId,
        anchor_id: anchorId,
        status: 'pending_verification',
        city_code: null,
        building_no: null,
        latitude: null,
        longitude: null,
      }),
    ]);
  });

  it('已建號的錨點：回編碼與名稱（縣市、鄉鎮市區、段小段）', async () => {
    const { unitId, anchorId } = await createProperty(orgA);
    await withTx({ kind: 'org', orgId: orgA }, (tx) => assignKey(tx, anchorId, { ...k, building: '88', sub: '1' }));
    const [row] = await read(orgA, [unitId]);
    const city = seed.cities.find((c) => c.code === plain.cityCode)!;
    const town = seed.towns.find((t) => t.cityCode === plain.cityCode && t.code === plain.townCode)!;
    expect(row).toMatchObject({
      status: 'keyed',
      city_code: plain.cityCode,
      town_code: plain.townCode,
      section_code: plain.code,
      building_no: '00088',
      sub_no: '001',
      city_name: city.name,
      town_name: town.name,
      section_name: plain.name,
      section_sub_name: plain.subName,
    });
  });

  it('只回呼叫者組織有物件的單位：別的組織的單位 ID 得到空結果，與不存在相同', async () => {
    const mine = await createProperty(orgA);
    expect(await read(orgB, [mine.unitId])).toEqual([]);
    expect(await read(orgB, [newUlid()])).toEqual([]);
    expect(await read(orgA, [mine.unitId, newUlid()])).toHaveLength(1);
  });

  it('沒有組織脈絡時回空結果', async () => {
    const mine = await createProperty(orgA);
    const rows = await withTx({ kind: 'control' }, async (tx) => {
      const { rows } = await tx.query('SELECT * FROM registry.get_anchors_for_units($1::text[])', [[mine.unitId]]);
      return rows;
    });
    expect(rows).toEqual([]);
  });
});
