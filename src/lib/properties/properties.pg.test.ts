import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgDriver } from '@/lib/pg/drivers';
import { createPgTestDatabase, type PgTestDatabase } from '@/lib/pg/pg-database-kit';
import { newUlid } from '@/lib/pg/ulid';
import { createWithTx, type WithTx } from '@/lib/pg/with-tx';
import { EQUIPMENT_OPTIONS } from '@/lib/types';
import {
  AnchorKeyCollisionError,
  createProperty,
  getProperty,
  listProperties,
  listVocabulary,
  parsePropertyInput,
  removeProperty,
  setPropertyAnchorKey,
  updateProperty,
} from '.';

// 真實 PostgreSQL（pg 驅動、連線池 2 條、app_rw）。PGlite 與 pg 的型別轉換不完全相同：
// timestamptz、jsonb、text[]、count(*)。route 層測試用 PGlite，這裡確認 pg 路徑一樣。
// 只在有 TEST_DATABASE_URL 時執行（見 pg-integration.test.ts）。

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('物件與設備詞彙庫 repository（真實 PostgreSQL）', () => {
  let dbh: PgTestDatabase;
  let withTx: WithTx;
  const orgA = newUlid();
  const orgB = newUlid();

  beforeAll(async () => {
    dbh = await createPgTestDatabase(adminUrl!, 2);
    withTx = createWithTx(pgDriver(dbh.pool));
    await dbh.owner.query(`SET ROLE app_owner; INSERT INTO control.orgs (id, name, kind) VALUES ('${orgA}', 'A', 'owner'), ('${orgB}', 'B', 'owner'); RESET ROLE`);
  });
  afterAll(async () => {
    await dbh.close();
  });

  const input = (over: Record<string, unknown> = {}) => {
    const parsed = parsePropertyInput({ name: '物件', address: '台北市大安區某路 1 號', equipment: [{ name: '冷氣', quantity: 2 }], ...over });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };

  it('建立、讀取、修改、刪除，型別都轉對（ULID、數字、ISO 時間、設備陣列）', async () => {
    const id = await withTx({ kind: 'org', orgId: orgA }, (tx) => createProperty(tx, input({ size: 18.5, default_rent: 28000 })));
    const created = await withTx({ kind: 'org', orgId: orgA }, (tx) => getProperty(tx, id));
    expect(created).toEqual({
      id,
      rental_unit_id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      unit: { suffix: '0000', label: null, floor: null, unit_type: 'whole', status: 'active', display_code: null },
      archived_at: null,
      anchor: expect.objectContaining({ status: 'pending_verification', building_no: null, latitude: null }),
      name: '物件',
      address: '台北市大安區某路 1 號',
      type: '整層住家',
      size: 18.5,
      default_rent: 28000,
      note: '',
      equipment: [{ name: '冷氣', quantity: 2 }],
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      updated_at: null,
    });

    const updated = await withTx({ kind: 'org', orgId: orgA }, (tx) => updateProperty(tx, id, input({ name: '改名', equipment: [] })));
    expect(updated).toMatchObject({ name: '改名', equipment: [], rental_unit_id: created!.rental_unit_id });
    expect(updated!.updated_at).toMatch(/^\d{4}-/);

    expect(await withTx({ kind: 'org', orgId: orgA }, (tx) => removeProperty(tx, id))).toBe('deleted');
    expect(await withTx({ kind: 'org', orgId: orgA }, (tx) => getProperty(tx, id))).toBeNull();
  });

  it('建物件的同一個交易建待驗證錨點與 0000 單位；交易失敗時兩者一起回滾', async () => {
    const before = await dbh.owner.query('SELECT count(*)::int AS n FROM registry.anchors');
    await expect(
      withTx({ kind: 'org', orgId: orgA }, async (tx) => {
        await createProperty(tx, input());
        throw new Error('故意失敗');
      }),
    ).rejects.toThrow('故意失敗');
    expect((await dbh.owner.query('SELECT count(*)::int AS n FROM registry.anchors')).rows).toEqual(before.rows);

    const id = await withTx({ kind: 'org', orgId: orgA }, (tx) => createProperty(tx, input()));
    const unit = await withTx({ kind: 'org', orgId: orgA }, async (tx) => (await getProperty(tx, id))!.rental_unit_id);
    const { rows } = await dbh.owner.query(
      `SELECT a.status, u.suffix FROM registry.rental_units u JOIN registry.anchors a ON a.id = u.anchor_id WHERE u.id = $1`,
      [unit],
    );
    expect(rows).toEqual([{ status: 'pending_verification', suffix: '0000' }]);
  });

  it('別的組織讀不到、改不到、刪不到；app_rw 不能直接碰 registry', async () => {
    const id = await withTx({ kind: 'org', orgId: orgA }, (tx) => createProperty(tx, input({ name: 'A 的' })));
    expect(await withTx({ kind: 'org', orgId: orgB }, (tx) => getProperty(tx, id))).toBeNull();
    expect(await withTx({ kind: 'org', orgId: orgB }, (tx) => updateProperty(tx, id, input()))).toBeNull();
    expect(await withTx({ kind: 'org', orgId: orgB }, (tx) => removeProperty(tx, id))).toBe('not_found');
    expect((await withTx({ kind: 'org', orgId: orgB }, (tx) => listProperties(tx))).map((p) => p.name)).not.toContain('A 的');
    await expect(dbh.pool.query('SELECT * FROM registry.anchors')).rejects.toThrow(/permission denied/);
  });

  it('設備詞彙庫：預設在前、自訂在後，兩個組織各一份（連線池 2 條，逐個交易）', async () => {
    const a = await withTx({ kind: 'org', orgId: orgA }, (tx) => listVocabulary(tx));
    expect(a.slice(0, EQUIPMENT_OPTIONS.length).map((v) => v.name)).toEqual([...EQUIPMENT_OPTIONS]);
    await withTx({ kind: 'org', orgId: orgA }, (tx) => createProperty(tx, input({ equipment: [{ name: '真實庫專屬', quantity: 1 }] })));
    const a2 = await withTx({ kind: 'org', orgId: orgA }, (tx) => listVocabulary(tx));
    expect(a2.at(-1)).toMatchObject({ name: '真實庫專屬', is_custom: true });
    const b = await withTx({ kind: 'org', orgId: orgB }, (tx) => listVocabulary(tx));
    expect(b.map((v) => v.name)).not.toContain('真實庫專屬');
  });

  it('同時兩個交易第一次讀詞彙庫，預設項目不重複也不失敗', async () => {
    const org = newUlid();
    await dbh.owner.query(`SET ROLE app_owner; INSERT INTO control.orgs (id, name, kind) VALUES ('${org}', 'C', 'owner'); RESET ROLE`);
    const results = await Promise.all([1, 2, 3, 4].map(() => withTx({ kind: 'org', orgId: org }, (tx) => listVocabulary(tx))));
    for (const r of results) expect(r.filter((v) => !v.is_custom)).toHaveLength(EQUIPMENT_OPTIONS.length);
    const final = await withTx({ kind: 'org', orgId: org }, (tx) => listVocabulary(tx));
    expect(final).toHaveLength(EQUIPMENT_OPTIONS.length);
  });

  describe('產權錨點（MIL-143）', () => {
    const key = { city: 'A', town: '02', section: '0021', buildingNo: '4242', subNo: '' };
    const keyedInput = (buildingNo: string) => input({ anchor: { key: { ...key, buildingNo } } });

    it('建立時填鍵：已建號，名稱取自參照表；補建號後一樣；pg 的座標是 number', async () => {
      const id = await withTx({ kind: 'org', orgId: orgA }, (tx) =>
        createProperty(tx, input({ anchor: { key: { ...key, buildingNo: '4201' }, latitude: 25.0338, longitude: 121.5435 } })),
      );
      const keyed = await withTx({ kind: 'org', orgId: orgA }, (tx) => getProperty(tx, id));
      expect(keyed!.anchor).toEqual({
        status: 'keyed',
        city_code: 'A',
        town_code: '02',
        section_code: '0021',
        building_no: '04201',
        sub_no: '000',
        city_name: '臺北市',
        town_name: '大安區',
        section_name: '龍泉 一',
        latitude: 25.0338,
        longitude: 121.5435,
      });

      const pendingId = await withTx({ kind: 'org', orgId: orgA }, (tx) => createProperty(tx, input()));
      const after = await withTx({ kind: 'org', orgId: orgA }, (tx) =>
        setPropertyAnchorKey(tx, pendingId, { cityCode: 'A', townCode: '02', sectionCode: '0021', buildingNo: '04202', subNo: '000' }),
      );
      expect(after).toMatchObject({ status: 'keyed', building_no: '04202' });
    });

    it('撞號丟固定錯誤，交易回滾不留半成品', async () => {
      await withTx({ kind: 'org', orgId: orgA }, (tx) => createProperty(tx, keyedInput('4243')));
      const before = (await dbh.owner.query('SELECT count(*)::int AS n FROM registry.anchors')).rows;
      await expect(withTx({ kind: 'org', orgId: orgB }, (tx) => createProperty(tx, keyedInput('4243')))).rejects.toThrow(
        AnchorKeyCollisionError,
      );
      expect((await dbh.owner.query('SELECT count(*)::int AS n FROM registry.anchors')).rows).toEqual(before);
    });

    it('兩個交易同時搶同一個鍵：一個成功，另一個也得到固定的撞號錯誤，不是唯一索引的錯誤', async () => {
      const results = await Promise.allSettled([
        withTx({ kind: 'org', orgId: orgA }, (tx) => createProperty(tx, keyedInput('4244'))),
        withTx({ kind: 'org', orgId: orgB }, (tx) => createProperty(tx, keyedInput('4244'))),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toBeInstanceOf(AnchorKeyCollisionError);
    });
  });
});
