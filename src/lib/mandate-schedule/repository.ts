// 委託標的清單的 repository（MIL-74）。介面一律回傳 Promise，A 線遷移到 PostgreSQL 時只換內部。
// 表的說明見 tables.ts。

import type Database from 'better-sqlite3';
import { getDb } from '../db';
import { MANDATE_SCOPES, normalizeScopes, type MandateItem, type MandateScope } from './index';

interface MandateItemRow {
  property_id: string;
  property_name: string;
  property_address: string;
  scopes: string;
}

function parseScopes(raw: string): MandateScope[] {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? MANDATE_SCOPES.filter((s) => parsed.includes(s)) : [];
}

/** 依列順序讀回清單。 */
export async function getMandateItems(
  contractId: number,
  db: Database.Database = getDb(),
): Promise<MandateItem[]> {
  const rows = db
    .prepare('SELECT * FROM contract_mandate_items WHERE contract_id = ? ORDER BY position')
    .all(contractId) as MandateItemRow[];
  return rows.map((r) => ({
    propertyId: r.property_id,
    propertyName: r.property_name,
    propertyAddress: r.property_address,
    scopes: parseScopes(r.scopes),
  }));
}

/** 整批取代。同一個租賃單位出現兩列時整批拒絕，原本的清單不變。 */
export async function replaceMandateItems(
  contractId: number,
  items: readonly MandateItem[],
  db: Database.Database = getDb(),
): Promise<void> {
  db.transaction(() => {
    db.prepare('DELETE FROM contract_mandate_items WHERE contract_id = ?').run(contractId);
    const insert = db.prepare(
      `INSERT INTO contract_mandate_items (contract_id, position, property_id, property_name, property_address, scopes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    items.forEach((item, position) => {
      insert.run(contractId, position, item.propertyId, item.propertyName, item.propertyAddress, JSON.stringify(normalizeScopes(item.scopes)));
    });
  })();
}

/** 複製為新草稿時沿用清單。 */
export async function copyMandateItems(
  fromContractId: number,
  toContractId: number,
  db: Database.Database = getDb(),
): Promise<void> {
  db.prepare(
    `INSERT INTO contract_mandate_items (contract_id, position, property_id, property_name, property_address, scopes)
     SELECT ?, position, property_id, property_name, property_address, scopes
       FROM contract_mandate_items WHERE contract_id = ?`,
  ).run(toContractId, fromContractId);
}
