import type { PGliteInterface } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDriver } from './drivers';
import { asRole, createTestDb, type TestDb } from './test-harness';
import { newUlid } from './ulid';
import { createWithTx, type OrgTx, type WithTx } from './with-tx';

// MIL-83：合約與合約歷程的表。複合外鍵、jsonb、append-only 都從外部（app_rw）觀察。

describe('合約與合約歷程的表', () => {
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

  const inOrg = <T>(orgId: string, fn: (tx: OrgTx) => Promise<T>) => withTx({ kind: 'org', orgId }, fn);

  async function insertProperty(tx: OrgTx, orgId: string): Promise<string> {
    const unitId = newUlid();
    await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [newUlid(), unitId, '某地址']);
    const id = newUlid();
    await tx.query('INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)', [
      id,
      orgId,
      unitId,
      '物件',
      '某地址',
    ]);
    return id;
  }

  const insertContract = (tx: OrgTx, orgId: string, over: { property_id?: string | null; derived_from?: string | null } = {}) => {
    const id = newUlid();
    return tx
      .query('INSERT INTO org.contracts (id, org_id, property_id, derived_from) VALUES ($1, $2, $3, $4)', [
        id,
        orgId,
        over.property_id ?? null,
        over.derived_from ?? null,
      ])
      .then(() => id);
  };

  const insertEvent = (tx: OrgTx, orgId: string, contractId: string, type = 'created') =>
    tx.query('INSERT INTO org.contract_events (id, org_id, contract_id, type, actor) VALUES ($1, $2, $3, $4, $5)', [
      newUlid(),
      orgId,
      contractId,
      type,
      'landlord',
    ]);

  describe('合約到物件的複合外鍵', () => {
    it('同組織的物件可以引用', async () => {
      await inOrg(orgA, async (tx) => {
        const propertyId = await insertProperty(tx, orgA);
        await expect(insertContract(tx, orgA, { property_id: propertyId })).resolves.toBeTruthy();
      });
    });

    it('A 組織的合約不能引用 B 組織的物件（外鍵不受 RLS 影響，只有帶 org_id 擋得住）', async () => {
      const bProperty = await inOrg(orgB, (tx) => insertProperty(tx, orgB));
      await expect(inOrg(orgA, (tx) => insertContract(tx, orgA, { property_id: bProperty }))).rejects.toThrow(
        /foreign key|violates/i,
      );
    });

    it('引用不存在的物件被擋下', async () => {
      await expect(inOrg(orgA, (tx) => insertContract(tx, orgA, { property_id: newUlid() }))).rejects.toThrow(/foreign key|violates/i);
    });

    it('有合約的物件不能刪（ADR-0025 決議 14，資料庫層的最後一道）', async () => {
      const propertyId = await inOrg(orgA, async (tx) => {
        const id = await insertProperty(tx, orgA);
        await insertContract(tx, orgA, { property_id: id });
        return id;
      });
      await expect(inOrg(orgA, (tx) => tx.query('DELETE FROM org.properties WHERE id = $1', [propertyId]))).rejects.toThrow(
        /foreign key|violates/i,
      );
    });

    it('合約刪掉之後，物件就可以刪', async () => {
      const { propertyId, contractId } = await inOrg(orgA, async (tx) => {
        const propertyId = await insertProperty(tx, orgA);
        return { propertyId, contractId: await insertContract(tx, orgA, { property_id: propertyId }) };
      });
      await inOrg(orgA, (tx) => tx.query('DELETE FROM org.contracts WHERE id = $1', [contractId]));
      const deleted = await inOrg(orgA, (tx) => tx.query('DELETE FROM org.properties WHERE id = $1 RETURNING id', [propertyId]));
      expect(deleted.rows).toHaveLength(1);
    });
  });

  describe('衍生關聯與歷程的複合外鍵', () => {
    it('衍生自同組織的合約可以，衍生自別的組織的合約被擋下', async () => {
      const aContract = await inOrg(orgA, (tx) => insertContract(tx, orgA));
      const bContract = await inOrg(orgB, (tx) => insertContract(tx, orgB));
      await expect(inOrg(orgA, (tx) => insertContract(tx, orgA, { derived_from: aContract }))).resolves.toBeTruthy();
      await expect(inOrg(orgA, (tx) => insertContract(tx, orgA, { derived_from: bContract }))).rejects.toThrow(/foreign key|violates/i);
    });

    it('不能衍生自自己', async () => {
      const id = await inOrg(orgA, (tx) => insertContract(tx, orgA));
      await expect(inOrg(orgA, (tx) => tx.query('UPDATE org.contracts SET derived_from = id WHERE id = $1', [id]))).rejects.toThrow(
        /check constraint/i,
      );
    });

    it('歷程只能掛在同組織的合約上', async () => {
      const bContract = await inOrg(orgB, (tx) => insertContract(tx, orgB));
      await expect(inOrg(orgA, (tx) => insertEvent(tx, orgA, bContract))).rejects.toThrow(/foreign key|violates/i);
    });
  });

  describe('歷程 append-only（ADR-0007）', () => {
    it('app_rw 能寫入與讀取，不能修改與刪除，也不能清空', async () => {
      const contractId = await inOrg(orgA, async (tx) => {
        const id = await insertContract(tx, orgA);
        await insertEvent(tx, orgA, id);
        return id;
      });
      const rows = await inOrg(orgA, (tx) => tx.query('SELECT type FROM org.contract_events WHERE contract_id = $1', [contractId]));
      expect(rows.rows).toEqual([{ type: 'created' }]);
      await expect(inOrg(orgA, (tx) => tx.query(`UPDATE org.contract_events SET note = 'x'`))).rejects.toThrow(/permission denied/);
      await expect(inOrg(orgA, (tx) => tx.query('DELETE FROM org.contract_events'))).rejects.toThrow(/permission denied/);
      await expect(inOrg(orgA, (tx) => tx.query('TRUNCATE org.contract_events'))).rejects.toThrow(/permission denied/);
    });

    it('刪除草稿合約時，歷程經外鍵一起刪除，且只刪那一份合約的', async () => {
      const { first, second } = await inOrg(orgA, async (tx) => {
        const first = await insertContract(tx, orgA);
        const second = await insertContract(tx, orgA);
        await insertEvent(tx, orgA, first);
        await insertEvent(tx, orgA, second);
        return { first, second };
      });
      await inOrg(orgA, (tx) => tx.query('DELETE FROM org.contracts WHERE id = $1', [first]));
      const left = await inOrg(orgA, (tx) => tx.query<{ contract_id: string }>('SELECT contract_id FROM org.contract_events'));
      expect(left.rows).toEqual([{ contract_id: second }]);
    });

    it('歷程的類型與行為者有 CHECK', async () => {
      const id = await inOrg(orgA, (tx) => insertContract(tx, orgA));
      await expect(inOrg(orgA, (tx) => insertEvent(tx, orgA, id, 'bogus'))).rejects.toThrow(/check constraint/i);
    });
  });

  describe('欄位', () => {
    it('fields 與 signature_fields 是 jsonb：存進去的物件讀出來內容相同', async () => {
      const fields = { landlordName: '林房東', rent: 20000, equipmentAnnex: [{ name: '冷氣', quantity: 1, repair: 'landlord', note: '' }], routing: { businessType: 'self_managed' } };
      const sig = [{ id: 'a', signer: 'party_a', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.05 }];
      const id = newUlid();
      await inOrg(orgA, (tx) =>
        tx.query('INSERT INTO org.contracts (id, org_id, fields, signature_fields) VALUES ($1, $2, $3::jsonb, $4::jsonb)', [
          id,
          orgA,
          JSON.stringify(fields),
          JSON.stringify(sig),
        ]),
      );
      const { rows } = await inOrg(orgA, (tx) =>
        tx.query<{ fields: unknown; signature_fields: unknown; t: string }>(
          `SELECT fields, signature_fields, pg_typeof(fields)::text AS t FROM org.contracts WHERE id = $1`,
          [id],
        ),
      );
      expect(rows[0].t).toBe('jsonb');
      expect(rows[0].fields).toEqual(fields);
      expect(rows[0].signature_fields).toEqual(sig);
    });

    it('fields 必須是物件、signature_fields 必須是陣列', async () => {
      await expect(inOrg(orgA, (tx) => tx.query(`INSERT INTO org.contracts (id, org_id, fields) VALUES ($1, $2, '[]'::jsonb)`, [newUlid(), orgA]))).rejects.toThrow(
        /check constraint/i,
      );
      await expect(
        inOrg(orgA, (tx) => tx.query(`INSERT INTO org.contracts (id, org_id, signature_fields) VALUES ($1, $2, '{}'::jsonb)`, [newUlid(), orgA])),
      ).rejects.toThrow(/check constraint/i);
    });

    it('預設是草稿與租賃合約；狀態與類型只收已知的值', async () => {
      const id = await inOrg(orgA, (tx) => insertContract(tx, orgA));
      const { rows } = await inOrg(orgA, (tx) => tx.query(`SELECT status, contract_type, fields, signature_fields FROM org.contracts WHERE id = $1`, [id]));
      expect(rows[0]).toEqual({ status: 'draft', contract_type: 'lease', fields: {}, signature_fields: [] });
      await expect(inOrg(orgA, (tx) => tx.query(`UPDATE org.contracts SET status = 'bogus' WHERE id = $1`, [id]))).rejects.toThrow(/check constraint/i);
      await expect(inOrg(orgA, (tx) => tx.query(`UPDATE org.contracts SET contract_type = 'bogus' WHERE id = $1`, [id]))).rejects.toThrow(/check constraint/i);
    });

    it('legacy_id 只在同一組織內唯一', async () => {
      const put = (orgId: string) =>
        inOrg(orgId, (tx) => tx.query('INSERT INTO org.contracts (id, org_id, legacy_id) VALUES ($1, $2, 7)', [newUlid(), orgId]));
      await put(orgA);
      await expect(put(orgB)).resolves.toBeTruthy();
      await expect(put(orgA)).rejects.toThrow(/unique|duplicate/i);
    });
  });
});
