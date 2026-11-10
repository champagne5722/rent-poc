import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import seedJson from '../registry/section-code/seed.json';
import type { SectionCodeSeed } from '../registry/section-code/types';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-145：分租單位發號、持有計數與 retired 轉換、封存欄位、單位讀取函式。
// 一律以 app_rw 從外部觀察；要看 registry 的列或繞過函式塞資料時，才用 asRole 換成 app_owner。

const seed = seedJson as SectionCodeSeed;
/** 第一個沒註銷、沒有別名的段，測試用。 */
const plain = seed.sections.find((s) => !s.canceled && s.aliasTownCodes.length === 0)!;

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

interface Created {
  anchorId: string;
  unitId: string;
  propertyId: string;
}

/** 組織建一個物件（待驗證錨點加 0000 單位）。 */
const createWhole = (orgId: string): Promise<Created> =>
  withTx({ kind: 'org', orgId }, async (tx) => {
    const anchorId = newUlid();
    const unitId = newUlid();
    const propertyId = newUlid();
    await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [anchorId, unitId, '某地址']);
    await insertProperty(tx, orgId, propertyId, unitId);
    return { anchorId, unitId, propertyId };
  });

const insertProperty = (tx: OrgTx, orgId: string, propertyId: string, unitId: string) =>
  tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [
    propertyId,
    orgId,
    unitId,
    '物件',
    '某地址',
  ]);

/** 組織在 sourceUnitId 的錨點下新增分租單位與物件。 */
const addSublet = (orgId: string, sourceUnitId: string, label = '301', floor: string | null = null) =>
  withTx({ kind: 'org', orgId }, async (tx) => {
    const unitId = newUlid();
    const { rows } = await tx.query<{ anchor_id: string; unit_id: string; suffix: string }>(
      'SELECT * FROM registry.create_sublet_unit($1, $2, $3, $4)',
      [sourceUnitId, unitId, label, floor],
    );
    const propertyId = newUlid();
    await insertProperty(tx, orgId, propertyId, unitId);
    return { ...rows[0], propertyId };
  });

/** 以呼叫者組織的身分補建號（真實路徑），錨點轉 keyed。 */
const keyAnchor = (orgId: string, anchorId: string, buildingNo = '1234') =>
  withTx({ kind: 'org', orgId }, (tx) =>
    tx.query('SELECT * FROM registry.assign_anchor_key($1, $2, $3, $4, $5, NULL, $6)', [anchorId, plain.cityCode, plain.townCode, plain.code, buildingNo, newUlid()]),
  );

const unitRow = (unitId: string) =>
  asRole(db, 'app_owner', async () => {
    const { rows } = await db.query<{
      anchor_id: string;
      suffix: string;
      label: string | null;
      floor: string | null;
      unit_type: string;
      status: string;
      holder_count: number;
    }>('SELECT anchor_id, suffix, label, floor, unit_type, status, holder_count FROM registry.rental_units WHERE id = $1', [unitId]);
    return rows[0];
  });

/** 以 B 組織探測，與 A 組織的錯誤比較時要逐字相同。 */
const failure = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    return { code, message };
  }
  return null;
};

describe('registry.create_sublet_unit：發號', () => {
  it('同一錨點下從 0001 起依序發號，房號與樓層只存標籤，類型是 sublet', async () => {
    const whole = await createWhole(orgA);
    const first = await addSublet(orgA, whole.unitId, '301', '3F');
    const second = await addSublet(orgA, whole.unitId, '3F-1');
    expect(first).toMatchObject({ anchor_id: whole.anchorId, suffix: '0001' });
    expect(second).toMatchObject({ anchor_id: whole.anchorId, suffix: '0002' });
    expect(await unitRow(first.unit_id)).toEqual({
      anchor_id: whole.anchorId,
      suffix: '0001',
      label: '301',
      floor: '3F',
      unit_type: 'sublet',
      status: 'active',
      holder_count: 1,
    });
    expect(await unitRow(second.unit_id)).toMatchObject({ label: '3F-1', floor: null, suffix: '0002' });
  });

  it('從分租單位的物件來源也能再加，仍在同一個錨點', async () => {
    const whole = await createWhole(orgA);
    const first = await addSublet(orgA, whole.unitId);
    const second = await addSublet(orgA, first.unit_id, '302');
    expect(second).toMatchObject({ anchor_id: whole.anchorId, suffix: '0002' });
  });

  it('不同錨點各自從 0001 起', async () => {
    const one = await createWhole(orgA);
    const two = await createWhole(orgA);
    await addSublet(orgA, one.unitId);
    expect(await addSublet(orgA, two.unitId)).toMatchObject({ suffix: '0001' });
  });

  it('改房號不改單位後綴', async () => {
    const whole = await createWhole(orgA);
    const sublet = await addSublet(orgA, whole.unitId, '301');
    await asRole(db, 'app_owner', () => db.query('UPDATE registry.rental_units SET label = $2 WHERE id = $1', [sublet.unit_id, '3F-1']));
    expect(await unitRow(sublet.unit_id)).toMatchObject({ label: '3F-1', suffix: '0001' });
  });

  it('已退場單位的後綴不重用', async () => {
    const whole = await createWhole(orgA);
    const first = await addSublet(orgA, whole.unitId);
    await withTx({ kind: 'org', orgId: orgA }, (tx) => tx.query('DELETE FROM org.properties WHERE id = $1', [first.propertyId]));
    expect((await unitRow(first.unit_id)).status).toBe('retired');
    expect(await addSublet(orgA, whole.unitId)).toMatchObject({ suffix: '0002' });
  });

  it('不得掛到別的組織的錨點：別人的單位與不存在的單位得到相同的錯誤', async () => {
    const whole = await createWhole(orgA);
    const probe = (unitId: string) =>
      failure(() =>
        withTx({ kind: 'org', orgId: orgB }, (tx) =>
          tx.query('SELECT * FROM registry.create_sublet_unit($1, $2, $3, NULL)', [unitId, newUlid(), '301']),
        ),
      );
    const others = await probe(whole.unitId);
    const missing = await probe(newUlid());
    expect(others).toEqual({ code: 'P0002', message: '租賃單位不存在' });
    expect(others).toEqual(missing);
    expect((await unitRow(whole.unitId)).holder_count).toBe(1);
  });

  it('沒有組織脈絡時拒絕', async () => {
    await expect(db.query('SELECT * FROM registry.create_sublet_unit($1, $2, $3, NULL)', [newUlid(), newUlid(), '301'])).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('房號為空、過長與樓層過長時拒絕', async () => {
    const whole = await createWhole(orgA);
    for (const [label, floor] of [['', null], ['   ', null], ['a'.repeat(41), null], ['301', 'f'.repeat(21)]] as const) {
      const result = await failure(() => addSublet(orgA, whole.unitId, label, floor));
      expect(result?.code, `${label}/${floor}`).toBe('22023');
    }
  });

  it('錨點已合併時拒絕', async () => {
    const whole = await createWhole(orgA);
    await asRole(db, 'app_owner', () => db.query(`UPDATE registry.anchors SET status = 'retired' WHERE id = $1`, [whole.anchorId]));
    expect((await failure(() => addSublet(orgA, whole.unitId)))?.code).toBe('55000');
  });

  it('兩個組織共用一個單位時，任一方都能在同一錨點下發號，號碼不重複', async () => {
    const whole = await createWhole(orgA);
    await withTx({ kind: 'org', orgId: orgB }, (tx) => insertProperty(tx, orgB, newUlid(), whole.unitId));
    const a = await addSublet(orgA, whole.unitId);
    const b = await addSublet(orgB, whole.unitId);
    expect([a.suffix, b.suffix]).toEqual(['0001', '0002']);
  });
});

describe('租賃單位的 CHECK', () => {
  const insertUnit = (anchorId: string, suffix: string, unitType: string, status = 'active') =>
    asRole(db, 'app_owner', () =>
      db.query('INSERT INTO registry.rental_units (id, anchor_id, suffix, unit_type, status) VALUES ($1, $2, $3, $4, $5)', [
        newUlid(),
        anchorId,
        suffix,
        unitType,
        status,
      ]),
    );

  it('整戶必須是 0000，分租不得是 0000，後綴必須 4 碼數字，類型與狀態限定集合', async () => {
    const whole = await createWhole(orgA);
    await expect(insertUnit(whole.anchorId, '0003', 'whole')).rejects.toThrow(/rental_units_whole_suffix/);
    await expect(insertUnit(whole.anchorId, '0000', 'sublet')).rejects.toThrow(/rental_units_whole_suffix/);
    await expect(insertUnit(whole.anchorId, '12', 'sublet')).rejects.toThrow(/rental_units_suffix_format/);
    await expect(insertUnit(whole.anchorId, '0005', 'room')).rejects.toThrow(/rental_units_type_values/);
    await expect(insertUnit(whole.anchorId, '0005', 'sublet', 'gone')).rejects.toThrow(/rental_units_status_values/);
    await insertUnit(whole.anchorId, '0005', 'sublet', 'merged');
  });
});

describe('持有計數與 retired 轉換', () => {
  it('建立物件時單位持有計數是 1，單位是 active', async () => {
    const whole = await createWhole(orgA);
    expect(await unitRow(whole.unitId)).toMatchObject({ status: 'active', holder_count: 1 });
  });

  it('最後一個物件刪除時單位轉 retired，錨點與單位列留在 registry', async () => {
    const whole = await createWhole(orgA);
    await withTx({ kind: 'org', orgId: orgA }, (tx) => tx.query('DELETE FROM org.properties WHERE id = $1', [whole.propertyId]));
    expect(await unitRow(whole.unitId)).toMatchObject({ status: 'retired', holder_count: 0, suffix: '0000' });
    const anchors = await asRole(db, 'app_owner', () => db.query('SELECT status FROM registry.anchors WHERE id = $1', [whole.anchorId]));
    expect(anchors.rows).toEqual([{ status: 'pending_verification' }]);
  });

  it('兩個組織都有物件指向同一個單位：A 刪除後仍是 active，B 也刪除才轉 retired', async () => {
    const whole = await createWhole(orgA);
    const bProperty = newUlid();
    await withTx({ kind: 'org', orgId: orgB }, (tx) => insertProperty(tx, orgB, bProperty, whole.unitId));
    expect((await unitRow(whole.unitId)).holder_count).toBe(2);

    await withTx({ kind: 'org', orgId: orgA }, (tx) => tx.query('DELETE FROM org.properties WHERE id = $1', [whole.propertyId]));
    expect(await unitRow(whole.unitId)).toMatchObject({ status: 'active', holder_count: 1 });

    await withTx({ kind: 'org', orgId: orgB }, (tx) => tx.query('DELETE FROM org.properties WHERE id = $1', [bProperty]));
    expect(await unitRow(whole.unitId)).toMatchObject({ status: 'retired', holder_count: 0 });
  });

  it('封存的物件仍算持有：封存不轉 retired', async () => {
    const whole = await createWhole(orgA);
    await withTx({ kind: 'org', orgId: orgA }, (tx) => tx.query('UPDATE org.properties SET archived_at = now() WHERE id = $1', [whole.propertyId]));
    expect(await unitRow(whole.unitId)).toMatchObject({ status: 'active', holder_count: 1 });
  });

  it('A 組織刪除自己的物件，不影響 B 組織的單位', async () => {
    const a = await createWhole(orgA);
    const b = await createWhole(orgB);
    await withTx({ kind: 'org', orgId: orgA }, (tx) => tx.query('DELETE FROM org.properties'));
    expect((await unitRow(a.unitId)).status).toBe('retired');
    expect(await unitRow(b.unitId)).toMatchObject({ status: 'active', holder_count: 1 });
  });

  it('retired 的單位又有物件指向時回到 active', async () => {
    const whole = await createWhole(orgA);
    await withTx({ kind: 'org', orgId: orgA }, (tx) => tx.query('DELETE FROM org.properties WHERE id = $1', [whole.propertyId]));
    await withTx({ kind: 'org', orgId: orgB }, (tx) => insertProperty(tx, orgB, newUlid(), whole.unitId));
    expect(await unitRow(whole.unitId)).toMatchObject({ status: 'active', holder_count: 1 });
  });

  it('merged 的單位在持有歸零後仍是 merged', async () => {
    const whole = await createWhole(orgA);
    await asRole(db, 'app_owner', () => db.query(`UPDATE registry.rental_units SET status = 'merged' WHERE id = $1`, [whole.unitId]));
    await withTx({ kind: 'org', orgId: orgA }, (tx) => tx.query('DELETE FROM org.properties WHERE id = $1', [whole.propertyId]));
    expect(await unitRow(whole.unitId)).toMatchObject({ status: 'merged', holder_count: 0 });
  });

  it('改物件指向的單位時，舊單位減一、新單位加一', async () => {
    const one = await createWhole(orgA);
    const two = await createWhole(orgA);
    await withTx({ kind: 'org', orgId: orgA }, (tx) =>
      tx.query('UPDATE org.properties SET rental_unit_id = $2 WHERE id = $1', [one.propertyId, two.unitId]),
    );
    expect(await unitRow(one.unitId)).toMatchObject({ status: 'retired', holder_count: 0 });
    expect(await unitRow(two.unitId)).toMatchObject({ status: 'active', holder_count: 2 });
  });
});

describe('registry.get_unit_details', () => {
  const details = (orgId: string, unitIds: string[]) =>
    withTx({ kind: 'org', orgId }, async (tx) => (await tx.query('SELECT * FROM registry.get_unit_details($1::text[])', [unitIds])).rows);

  it('待驗證的錨點沒有縣市與鄉鎮編碼', async () => {
    const whole = await createWhole(orgA);
    expect(await details(orgA, [whole.unitId])).toEqual([
      {
        unit_id: whole.unitId,
        suffix: '0000',
        label: null,
        floor: null,
        unit_type: 'whole',
        status: 'active',
        display_unit_id: whole.unitId,
        display_city_code: null,
        display_town_code: null,
      },
    ]);
  });

  it('補建號後有編碼；分租單位帶自己的房號與樓層，編碼取錨點的縣市與鄉鎮', async () => {
    const whole = await createWhole(orgA);
    const sublet = await addSublet(orgA, whole.unitId, '301', '3F');
    await keyAnchor(orgA, whole.anchorId);
    const rows = await details(orgA, [whole.unitId, sublet.unit_id]);
    expect(rows).toHaveLength(2);
    const row = rows.find((r) => r.unit_id === sublet.unit_id);
    expect(row).toMatchObject({
      suffix: '0001',
      label: '301',
      floor: '3F',
      unit_type: 'sublet',
      display_unit_id: sublet.unit_id,
      display_city_code: plain.cityCode,
      display_town_code: plain.townCode,
    });
  });

  it('只回自己組織有物件的單位：別人的單位與不存在的單位得到空結果', async () => {
    const whole = await createWhole(orgA);
    expect(await details(orgB, [whole.unitId, newUlid()])).toEqual([]);
  });

  it('被合併的單位顯示存續單位的 ID 與編碼', async () => {
    const survivor = await createWhole(orgB);
    await keyAnchor(orgB, survivor.anchorId);
    const merged = await createWhole(orgA);
    await asRole(db, 'app_owner', () =>
      db.query(`UPDATE registry.rental_units SET status = 'merged', merged_into_id = $2 WHERE id = $1`, [merged.unitId, survivor.unitId]),
    );
    const [row] = await details(orgA, [merged.unitId]);
    expect(row).toMatchObject({
      unit_id: merged.unitId,
      status: 'merged',
      display_unit_id: survivor.unitId,
      display_city_code: plain.cityCode,
      display_town_code: plain.townCode,
    });
  });
});

describe('registry.get_sibling_units', () => {
  const siblings = (orgId: string, unitId: string) =>
    withTx({ kind: 'org', orgId }, async (tx) => (await tx.query('SELECT * FROM registry.get_sibling_units($1)', [unitId])).rows);

  it('列出同一錨點下自己組織的單位，依後綴排序，含物件 ID', async () => {
    const whole = await createWhole(orgA);
    const first = await addSublet(orgA, whole.unitId, '301');
    const second = await addSublet(orgA, whole.unitId, '302');
    const other = await createWhole(orgA);
    const rows = await siblings(orgA, first.unit_id);
    expect(rows.map((r) => [r.suffix, r.property_id, r.label])).toEqual([
      ['0000', whole.propertyId, null],
      ['0001', first.propertyId, '301'],
      ['0002', second.propertyId, '302'],
    ]);
    expect(rows.map((r) => r.property_id)).not.toContain(other.propertyId);
  });

  it('別的組織有物件的單位不會出現，來源單位不是自己的就得到空結果', async () => {
    const whole = await createWhole(orgA);
    await withTx({ kind: 'org', orgId: orgB }, (tx) => insertProperty(tx, orgB, newUlid(), whole.unitId));
    await addSublet(orgA, whole.unitId, '301');
    expect((await siblings(orgB, whole.unitId)).map((r) => r.suffix)).toEqual(['0000']);
    expect(await siblings(orgB, newUlid())).toEqual([]);
    const other = await createWhole(orgA);
    expect(await siblings(orgB, other.unitId)).toEqual([]);
  });
});

describe('org.properties.archived_at', () => {
  it('預設是空值，只有自己組織改得到', async () => {
    const whole = await createWhole(orgA);
    const read = (orgId: string) =>
      withTx({ kind: 'org', orgId }, async (tx) => (await tx.query<{ archived_at: Date | null }>('SELECT archived_at FROM org.properties')).rows);
    expect(await read(orgA)).toEqual([{ archived_at: null }]);
    const result = await withTx({ kind: 'org', orgId: orgB }, (tx) =>
      tx.query('UPDATE org.properties SET archived_at = now() WHERE id = $1 RETURNING id', [whole.propertyId]),
    );
    expect(result.rows).toEqual([]);
    expect(await read(orgA)).toEqual([{ archived_at: null }]);
  });
});
