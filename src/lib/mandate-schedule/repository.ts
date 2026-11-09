// 委託標的清單的 repository（MIL-74，第二次同步 main 時搬進 PostgreSQL）。表的說明見 db/migrations/0013_contract_mandate_items.sql。
//
// 形狀照 src/lib/practitioner-assignment/repository.ts：第一個參數是 withTx 給的 tx（OrgTx），
// 不傳 org_id：INSERT 取交易的 app.org_id，查詢靠 RLS 篩選。別的組織的合約和不存在的合約沒有差別。

import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { MANDATE_SCOPES, normalizeScopes, type MandateItem, type MandateScope } from './index';

interface MandateItemRow {
  property_id: string;
  property_name: string;
  property_address: string;
  scopes: unknown;
}

// scopes 是 jsonb，讀出來就是陣列。只留認得的範圍，順序照 MANDATE_SCOPES
function parseScopes(raw: unknown): MandateScope[] {
  return Array.isArray(raw) ? MANDATE_SCOPES.filter((s) => raw.includes(s)) : [];
}

/** 依列順序讀回清單。 */
export async function getMandateItems(tx: OrgTx, contractId: string): Promise<MandateItem[]> {
  const { rows } = await tx.query<MandateItemRow>(
    `SELECT property_id, property_name, property_address, scopes
       FROM org.contract_mandate_items WHERE contract_id = $1 ORDER BY position`,
    [contractId],
  );
  return rows.map((r) => ({
    propertyId: r.property_id,
    propertyName: r.property_name,
    propertyAddress: r.property_address,
    scopes: parseScopes(r.scopes),
  }));
}

const INSERT_ITEM = `INSERT INTO org.contract_mandate_items
    (id, org_id, contract_id, position, property_id, property_name, property_address, scopes)
  VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6, $7::jsonb)`;

/**
 * 整批取代。同一個租賃單位出現兩列時整批拒絕（唯一鍵），交易回滾，原本的清單不變。
 * 合約不存在（含別的組織的合約）時複合外鍵擋下。
 */
export async function replaceMandateItems(
  tx: OrgTx,
  contractId: string,
  items: readonly MandateItem[],
): Promise<void> {
  await tx.query('DELETE FROM org.contract_mandate_items WHERE contract_id = $1', [contractId]);
  let position = 0;
  for (const item of items) {
    await tx.query(INSERT_ITEM, [
      newUlid(),
      contractId,
      position++,
      item.propertyId,
      item.propertyName,
      item.propertyAddress,
      JSON.stringify(normalizeScopes(item.scopes)),
    ]);
  }
}

/** 複製為新草稿時沿用清單。 */
export async function copyMandateItems(tx: OrgTx, fromContractId: string, toContractId: string): Promise<void> {
  const { rows } = await tx.query<MandateItemRow & { position: number }>(
    `SELECT position, property_id, property_name, property_address, scopes
       FROM org.contract_mandate_items WHERE contract_id = $1 ORDER BY position`,
    [fromContractId],
  );
  for (const r of rows) {
    await tx.query(INSERT_ITEM, [
      newUlid(),
      toContractId,
      r.position,
      r.property_id,
      r.property_name,
      r.property_address,
      JSON.stringify(r.scopes),
    ]);
  }
}
