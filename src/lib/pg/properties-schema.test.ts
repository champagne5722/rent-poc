import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type WithTx } from './with-tx';

// MIL-81：registry 骨架、物件與設備詞彙庫的表。只用 app_rw 的身分從外部觀察。

describe('物件與設備詞彙庫的表', () => {
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
    await asRole(db, 'app_owner', async () => {
      await db.query(`INSERT INTO control.orgs (id, name, kind) VALUES ($1, 'A', 'owner'), ($2, 'B', 'owner')`, [orgA, orgB]);
    });
  });

  const createUnit = (orgId: string) =>
    withTx({ kind: 'org', orgId }, async (tx) => {
      const anchorId = newUlid();
      const unitId = newUlid();
      await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [anchorId, unitId, '台北市大安區某路 1 號']);
      return { anchorId, unitId };
    });

  const insertProperty = (tx: Parameters<Parameters<WithTx>[1]>[0], orgId: string, unitId: string, name = '物件') =>
    tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [
      newUlid(),
      orgId,
      unitId,
      name,
      '某地址',
    ]);

  describe('registry', () => {
    it('app_rw 不能直接讀寫錨點與租賃單位', async () => {
      await expect(db.query('SELECT * FROM registry.anchors')).rejects.toThrow(/permission denied/);
      await expect(db.query('SELECT * FROM registry.rental_units')).rejects.toThrow(/permission denied/);
      await expect(
        db.query(`INSERT INTO registry.anchors (id) VALUES ('${newUlid()}')`),
      ).rejects.toThrow(/permission denied/);
    });

    it('在組織脈絡內呼叫函式，得到錨點 ID 與單位 ID，兩者都是呼叫端給的 ULID', async () => {
      const { anchorId, unitId } = await createUnit(orgA);
      const { rows } = await asRole(db, 'app_owner', () =>
        db.query<{ status: string; suffix: string; unit_type: string; unit_status: string; anchor_id: string }>(
          `SELECT a.status, u.suffix, u.unit_type, u.status AS unit_status, u.anchor_id
             FROM registry.rental_units u JOIN registry.anchors a ON a.id = u.anchor_id WHERE u.id = $1`,
          [unitId],
        ),
      );
      expect(rows).toEqual([
        { status: 'pending_verification', suffix: '0000', unit_type: 'whole', unit_status: 'active', anchor_id: anchorId },
      ]);
    });

    it('錨點的五欄鍵在待驗證時全部為空，兩個待驗證錨點不互相衝突', async () => {
      await createUnit(orgA);
      await expect(createUnit(orgB)).resolves.toBeDefined();
    });

    it('沒有組織脈絡時拒絕建立（登入、webhook 等入口不得建錨點）', async () => {
      await expect(
        withTx({ kind: 'control' }, (tx) =>
          tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [newUlid(), newUlid(), 'x']),
        ),
      ).rejects.toThrow(/組織脈絡/);
    });

    it('ID 不是 ULID 時拒絕', async () => {
      await expect(
        withTx({ kind: 'org', orgId: orgA }, (tx) =>
          tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', ['12', newUlid(), 'x']),
        ),
      ).rejects.toThrow(/check|violates/i);
    });

    it('函式失敗時錨點不會單獨留下（同一個交易）', async () => {
      const anchorId = newUlid();
      await expect(
        withTx({ kind: 'org', orgId: orgA }, (tx) =>
          tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [anchorId, 'bad', 'x']),
        ),
      ).rejects.toThrow();
      const { rows } = await asRole(db, 'app_owner', () =>
        db.query('SELECT 1 FROM registry.anchors WHERE id = $1', [anchorId]),
      );
      expect(rows).toEqual([]);
    });

    it('函式的擁有者是 app_owner，沒有 BYPASSRLS 也不是 superuser（ADR-0012 決議 8）', async () => {
      const { rows } = await testDb.base.query<{ owner: string; bypass: boolean; super: boolean }>(
        `SELECT r.rolname AS owner, r.rolbypassrls AS bypass, r.rolsuper AS super
           FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.proname = 'create_pending_anchor'`,
      );
      expect(rows).toEqual([{ owner: 'app_owner', bypass: false, super: false }]);
    });

    it('函式固定 search_path，且不開放給 PUBLIC', async () => {
      const { rows } = await testDb.base.query<{ config: string[]; secdef: boolean; acl: string | null }>(
        `SELECT proconfig AS config, prosecdef AS secdef, proacl::text AS acl
           FROM pg_proc WHERE proname = 'create_pending_anchor'`,
      );
      expect(rows[0].secdef).toBe(true);
      expect(rows[0].config).toContain('search_path=registry, pg_temp');
      expect(rows[0].acl).not.toMatch(/(^|[{,])=X/); // 空角色名開頭的項目就是 PUBLIC
    });
  });

  describe('org.properties', () => {
    it('租賃單位 ID 不得為空', async () => {
      await expect(
        withTx({ kind: 'org', orgId: orgA }, (tx) =>
          tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, NULL, $3, $4)', [
            newUlid(),
            orgA,
            'n',
            'a',
          ]),
        ),
      ).rejects.toThrow(/null value/);
    });

    it('租賃單位 ID 必須存在於 registry，app_rw 沒有 registry 權限也寫得進有效 ID', async () => {
      const { unitId } = await createUnit(orgA);
      await expect(withTx({ kind: 'org', orgId: orgA }, (tx) => insertProperty(tx, orgA, unitId))).resolves.toBeDefined();
      await expect(
        withTx({ kind: 'org', orgId: orgA }, (tx) => insertProperty(tx, orgA, newUlid())),
      ).rejects.toThrow(/foreign key/i);
    });

    it('別的組織看不到我的物件，也改不到', async () => {
      const { unitId } = await createUnit(orgA);
      await withTx({ kind: 'org', orgId: orgA }, (tx) => insertProperty(tx, orgA, unitId));
      const seenByB = await withTx({ kind: 'org', orgId: orgB }, (tx) => tx.query('SELECT id FROM org.properties'));
      expect(seenByB.rows).toEqual([]);
      const changed = await withTx({ kind: 'org', orgId: orgB }, (tx) =>
        tx.query(`UPDATE org.properties SET name = 'x' RETURNING id`),
      );
      expect(changed.rows).toEqual([]);
      const deleted = await withTx({ kind: 'org', orgId: orgB }, (tx) => tx.query('DELETE FROM org.properties RETURNING id'));
      expect(deleted.rows).toEqual([]);
    });

    it('沒有組織脈絡時 0 筆', async () => {
      const { unitId } = await createUnit(orgA);
      await withTx({ kind: 'org', orgId: orgA }, (tx) => insertProperty(tx, orgA, unitId));
      const rows = await withTx({ kind: 'control' }, (tx) => tx.query('SELECT id FROM org.properties'));
      expect(rows.rows).toEqual([]);
    });

    it('不能寫入別的組織的 org_id', async () => {
      const { unitId } = await createUnit(orgA);
      await expect(withTx({ kind: 'org', orgId: orgA }, (tx) => insertProperty(tx, orgB, unitId))).rejects.toThrow(
        /row-level security/,
      );
    });

    it('同一個租賃單位可以被兩個組織各建一個物件（換經理人，ADR-0013 決議 9）', async () => {
      const { unitId } = await createUnit(orgA);
      await withTx({ kind: 'org', orgId: orgA }, (tx) => insertProperty(tx, orgA, unitId));
      await expect(withTx({ kind: 'org', orgId: orgB }, (tx) => insertProperty(tx, orgB, unitId))).resolves.toBeDefined();
    });

    it('type 只收三種型態', async () => {
      const { unitId } = await createUnit(orgA);
      await expect(
        withTx({ kind: 'org', orgId: orgA }, (tx) =>
          tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address, type) VALUES ($1,$2,$3,$4,$5,$6)', [
            newUlid(),
            orgA,
            unitId,
            'n',
            'a',
            '別墅',
          ]),
        ),
      ).rejects.toThrow(/check/i);
    });
  });

  describe('org.equipment_vocabulary', () => {
    const add = (orgId: string, name: string) =>
      withTx({ kind: 'org', orgId }, (tx) =>
        tx.query('INSERT INTO org.equipment_vocabulary (id, org_id, name, is_custom) VALUES ($1, $2, $3, true)', [
          newUlid(),
          orgId,
          name,
        ]),
      );

    it('兩個組織能有同名的設備項目', async () => {
      await add(orgA, '掃地機器人');
      await expect(add(orgB, '掃地機器人')).resolves.toBeDefined();
    });

    it('同一個組織不能有同名項目', async () => {
      await add(orgA, '掃地機器人');
      await expect(add(orgA, '掃地機器人')).rejects.toThrow(/duplicate key|unique/i);
    });

    it('B 組織看不到 A 組織的項目，也不會因為撞名知道 A 有這個項目', async () => {
      await add(orgA, '掃地機器人');
      const seen = await withTx({ kind: 'org', orgId: orgB }, (tx) => tx.query('SELECT name FROM org.equipment_vocabulary'));
      expect(seen.rows).toEqual([]);
      await expect(add(orgB, '掃地機器人')).resolves.toBeDefined();
    });

    it('名稱不得為空白', async () => {
      await expect(add(orgA, '   ')).rejects.toThrow(/check/i);
    });
  });
});
