import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgDriver } from '@/lib/pg/drivers';
import { createPgTestDatabase, type PgTestDatabase } from '@/lib/pg/pg-database-kit';
import { newUlid } from '@/lib/pg/ulid';
import { createWithTx, type WithTx } from '@/lib/pg/with-tx';
import { EQUIPMENT_OPTIONS } from '@/lib/types';
import {
  createProperty,
  getProperty,
  listProperties,
  listVocabulary,
  parsePropertyInput,
  registerProperty,
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
      // 沒有建號的舊資料：鍵與座標都是空值。對外狀態是常數，不讀內部狀態（MIL-196）
      anchor: expect.objectContaining({ building_no: null, latitude: null }),
      verification_status: 'pending_verification',
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

  describe('物件的建號（MIL-143、MIL-196）', () => {
    const key = { city: 'A', town: '02', section: '0021', buildingNo: '4242', subNo: '' };
    const keyedInput = (buildingNo: string) => input({ anchor: { key: { ...key, buildingNo } } });
    /** 讀取結果的 anchor 只有建號摘要的欄位，沒有內部狀態與審核單號。 */
    const onlyKeySummary = (anchor: object | null | undefined) => {
      expect(Object.keys(anchor ?? {}).sort()).toEqual([
        'building_no',
        'city_code',
        'city_name',
        'latitude',
        'longitude',
        'section_code',
        'section_name',
        'sub_no',
        'town_code',
        'town_name',
      ]);
    };

    it('建立時填鍵：名稱取自參照表；補建號後一樣；pg 的座標是 number', async () => {
      const id = await withTx({ kind: 'org', orgId: orgA }, (tx) =>
        createProperty(tx, input({ anchor: { key: { ...key, buildingNo: '4201' }, latitude: 25.0338, longitude: 121.5435 } })),
      );
      const keyed = await withTx({ kind: 'org', orgId: orgA }, (tx) => getProperty(tx, id));
      expect(keyed!.anchor).toEqual({
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
      expect(keyed!.verification_status).toBe('pending_verification');

      const noKeyId = await withTx({ kind: 'org', orgId: orgA }, (tx) => createProperty(tx, input()));
      const after = await withTx({ kind: 'org', orgId: orgA }, (tx) =>
        setPropertyAnchorKey(tx, noKeyId, { cityCode: 'A', townCode: '02', sectionCode: '0021', buildingNo: '04202', subNo: '000' }),
      );
      expect(after).toMatchObject({ kind: 'accepted', anchor: { building_no: '04202' } });
    });

    it('撞到別的組織：結果與不重複相同，讀得到自己填的鍵，內部狀態不外露；既有登錄方不受影響', async () => {
      const first = await withTx({ kind: 'org', orgId: orgA }, (tx) => registerProperty(tx, keyedInput('4243')));
      expect(first).toEqual({ kind: 'created', id: expect.any(String) });
      const second = await withTx({ kind: 'org', orgId: orgB }, (tx) => registerProperty(tx, keyedInput('4243')));
      expect(second).toEqual({ kind: 'created', id: expect.any(String) });
      const claimant = await withTx({ kind: 'org', orgId: orgB }, (tx) => getProperty(tx, (second as { id: string }).id));
      expect(claimant!.anchor).toMatchObject({ building_no: '04243', city_name: '臺北市', section_name: '龍泉 一' });
      expect(claimant!.verification_status).toBe('pending_verification');
      expect(claimant!.unit!.display_code).not.toBeNull();
      onlyKeySummary(claimant!.anchor);
      const holder = await withTx({ kind: 'org', orgId: orgA }, (tx) => getProperty(tx, (first as { id: string }).id));
      expect(holder!.anchor).toMatchObject({ building_no: '04243' });
      onlyKeySummary(holder!.anchor);

      // 內部：宣稱方的物件待驗證，宣稱的鍵在審核項目，既有登錄方的物件不變
      const { rows } = await dbh.owner.query(
        `SELECT a.status, a.building_no FROM registry.anchors a JOIN registry.rental_units u ON u.anchor_id = a.id JOIN org.properties p ON p.rental_unit_id = u.id WHERE p.id = ANY($1::text[]) ORDER BY p.id`,
        [[(first as { id: string }).id, (second as { id: string }).id]],
      );
      expect(rows).toEqual([
        { status: 'keyed', building_no: '04243' },
        { status: 'pending_verification', building_no: null },
      ]);
    });

    it('撞到自己組織：回自己的物件，交易退回這次建立的列與登錄事件，不留半成品', async () => {
      const first = await withTx({ kind: 'org', orgId: orgA }, (tx) => registerProperty(tx, keyedInput('4245')));
      const countAnchors = async () => (await dbh.owner.query('SELECT count(*)::int AS n FROM registry.anchors')).rows;
      const countCreateEvents = () =>
        withTx({ kind: 'org', orgId: orgA }, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM audit.events WHERE action = 'property.create'`)).rows);
      const before = { anchors: await countAnchors(), events: await countCreateEvents() };
      const again = await withTx({ kind: 'org', orgId: orgA }, (tx) => registerProperty(tx, keyedInput('4245')));
      expect(again).toEqual({ kind: 'existing', id: (first as { id: string }).id });
      expect({ anchors: await countAnchors(), events: await countCreateEvents() }).toEqual(before);
    });

    it('兩個交易同時搶同一個鍵：一個取得鍵，另一個走撞號流程，兩邊回應相同，不得回傳唯一索引的錯誤', async () => {
      const results = await Promise.allSettled([
        withTx({ kind: 'org', orgId: orgA }, (tx) => registerProperty(tx, keyedInput('4244'))),
        withTx({ kind: 'org', orgId: orgB }, (tx) => registerProperty(tx, keyedInput('4244'))),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const kinds = results.map((r) => (r as PromiseFulfilledResult<{ kind: string }>).value.kind);
      expect(kinds).toEqual(['created', 'created']);
      // 內部：剛好一個撞號項目
      const { rows } = await dbh.owner.query(
        `SELECT count(*)::int AS n FROM registry.review_items WHERE type = 'anchor_collision' AND payload -> 'claimed_key' ->> 'building_no' = '04244'`,
      );
      expect(rows).toEqual([{ n: 1 }]);
    });

    it('同一個組織並行撞號：次數在函式內檢查，並行請求都成立，警示剛好累計 2 次（上限 2，4 個並行請求）', async () => {
      const racer = newUlid();
      await dbh.owner.query(`SET ROLE app_owner; INSERT INTO control.orgs (id, name, kind) VALUES ('${racer}', 'C', 'owner'); RESET ROLE`);
      // 4 個不同的鍵：同一個組織撞同一個鍵第二次會得到自己既有的物件，並行的請求才不會因為先後而得到不同的結果
      const keys = ['4250', '4251', '4252', '4253'];
      for (const building of keys) await withTx({ kind: 'org', orgId: orgA }, (tx) => registerProperty(tx, keyedInput(building)));
      await dbh.owner.query(`UPDATE registry.platform_settings SET int_value = 2 WHERE key = 'anchor_collision_daily_limit'`);
      try {
        const results = await Promise.all(
          keys.map((building) => withTx({ kind: 'org', orgId: racer }, (tx) => registerProperty(tx, keyedInput(building)))),
        );
        expect(results.map((r) => r.kind)).toEqual(['created', 'created', 'created', 'created']);
        const items = await dbh.owner.query(
          `SELECT count(*)::int AS n FROM registry.review_items WHERE type = 'anchor_collision' AND payload ->> 'claimant_org_id' = $1`,
          [racer],
        );
        expect(items.rows).toEqual([{ n: 4 }]);
        // 前兩次在額度內，第三、四次超過：只累計 2 次，而且只有一張警示項目
        const alert = await dbh.owner.query(
          `SELECT payload ->> 'hits' AS hits FROM registry.review_items WHERE type = 'anchor_collision_limit' AND subject_id = $1`,
          [racer],
        );
        expect(alert.rows).toEqual([{ hits: '2' }]);
      } finally {
        await dbh.owner.query(`UPDATE registry.platform_settings SET int_value = 50 WHERE key = 'anchor_collision_daily_limit'`);
      }
    });
  });
});
