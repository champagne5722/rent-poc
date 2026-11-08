import { getDb } from '@/lib/db';
import type { OrgTx } from '@/lib/pg/with-tx';

// 物件與合約的接縫（MIL-145）。合約還在 SQLite（`contracts.property_id` 存物件 ULID），
// 物件在 PostgreSQL，所以「物件有沒有合約」要從這裡問。
//
// 給 MIL-83 的交接：合約搬進 PostgreSQL 之後，只換這個檔案的實作，呼叫端不改。
// - 兩個函式都收 `tx`（呼叫端的組織交易）。SQLite 版用不到它，PostgreSQL 版用它查 org.contracts。
// - 呼叫端：repository 的 removeProperty（刪除或封存）與 createSubletUnit（新增分租單位前的警告）。
// - C 線的案件完成後，「任何合約」改為「任何案件」（ADR-0025 決議 14），也只改這裡。
// - SQLite 版沒有組織欄位。呼叫端必須先確認物件屬於呼叫者組織，才拿結果做決定。

/** 物件有沒有任何合約，不分狀態與類型。有就只能封存，不能刪除（P0-06 AC8）。 */
export async function hasContractsForProperty(propertyId: string, _tx: OrgTx): Promise<boolean> {
  void _tx;
  const row = getDb().prepare('SELECT 1 AS found FROM contracts WHERE property_id = ? LIMIT 1').get(propertyId);
  return row !== undefined;
}

/** 台北時間的今天，YYYY-MM-DD。合約日期欄位也是這個格式，字串比較即時間比較。 */
export function taipeiToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(now);
}

/**
 * 物件有沒有已完成且租期未屆滿的租賃合約（P0-06 AC4）。租期止日當天仍算未屆滿。
 * 租期止日沒填的已完成合約，無從判斷屆滿，保守視為未屆滿。
 */
export async function hasActiveLeaseForProperty(propertyId: string, _tx: OrgTx, now: Date = new Date()): Promise<boolean> {
  void _tx;
  const today = taipeiToday(now);
  const rows = getDb()
    .prepare("SELECT fields FROM contracts WHERE property_id = ? AND status = 'completed' AND contract_type = 'lease'")
    .all(propertyId) as { fields: string }[];
  return rows.some((row) => {
    const { endDate } = JSON.parse(row.fields) as { endDate?: string };
    return !endDate || endDate >= today;
  });
}
