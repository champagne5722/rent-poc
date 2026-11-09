import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTx } from '../pg/database';
import { setupRouteDb, type RouteDb } from '../pg/route-test-kit';
import { newUlid } from '../pg/ulid';

// MIL-106 的 registry 表（0042）：app_rw 不能直接讀寫，只能呼叫定義者函式（ADR-0012 決議 8）。

let kit: RouteDb;
beforeAll(async () => {
  kit = await setupRouteDb();
});
afterAll(() => kit.close());
beforeEach(() => kit.reset());

const TABLES = ['registry.practice_entities', 'registry.practice_licenses', 'registry.review_items'];

describe('registry 的執業主體表', () => {
  it.each(TABLES)('%s：app_rw 沒有任何直接權限', async (table) => {
    for (const sql of [`SELECT * FROM ${table}`, `DELETE FROM ${table}`, `UPDATE ${table} SET created_at = now()`]) {
      await expect(withTx({ kind: 'org', orgId: kit.orgA }, (tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it('claim_practice_entity：一般成員脈絡的 app_rw 可以呼叫，PUBLIC 沒有預設權限', async () => {
    const { rows } = await kit.asOwner(async (db) =>
      db.query<{ ok: boolean }>(
        `SELECT has_function_privilege('app_rw', 'registry.claim_practice_entity(text,text,text,text,text[],text,text[],text[])', 'EXECUTE') AS ok`,
      ),
    );
    expect(rows[0].ok).toBe(true);
    const pub = await kit.asOwner(async (db) =>
      db.query<{ ok: boolean }>(
        `SELECT has_function_privilege('public', 'registry.claim_practice_entity(text,text,text,text,text[],text,text[],text[])', 'EXECUTE') AS ok`,
      ),
    );
    expect(pub.rows[0].ok).toBe(false);
  });

  it('函式拒絕業別數量與 ID 數量不一致的呼叫', async () => {
    await expect(
      withTx({ kind: 'org', orgId: kit.orgA }, (tx) =>
        tx.query(`SELECT registry.claim_practice_entity($1, '11111111', 'x', 'company', ARRAY['management'], $2, ARRAY[]::text[], ARRAY[$3])`, [
          kit.orgA, newUlid(), newUlid(),
        ]),
      ),
    ).rejects.toThrow(/數量不一致/);
  });

  it('資料庫約束：統編 8 碼數字、組織型態、業別、審核項目的種類', async () => {
    const bad = (sql: string, params: unknown[]) =>
      kit.asOwner(async (db) => {
        await expect(db.query(sql, params)).rejects.toThrow(/check constraint|violates/);
      });
    await bad(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, '1234', 'x', 'company', $2)`, [newUlid(), kit.orgA]);
    await bad(`INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id) VALUES ($1, '12345678', 'x', 'partnership', $2)`, [newUlid(), kit.orgA]);
    await bad(`INSERT INTO registry.review_items (id, type, subject_type, subject_id) VALUES ($1, 'unknown', 'x', 'y')`, [newUlid()]);
  });
});
