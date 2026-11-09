import { propertyHasContracts } from '@/lib/contracts';
import type { OrgTx } from '@/lib/pg/with-tx';

// 物件與合約的接縫（MIL-145，MIL-83 之後的實作）。物件與合約都在 PostgreSQL，
// 所以兩個函式用呼叫端的組織交易 `tx` 查 org.contracts，RLS 讓別的組織的合約不算。
//
// - 呼叫端：repository 的 removeProperty（刪除或封存）與 createSubletUnit（新增分租單位前的警告）。
//   呼叫端不必改，簽章沿用 SQLite 版。
// - C 線的案件完成後，「任何合約」改為「任何案件」（ADR-0025 決議 14），只改這裡。
//
// 刪除物件與同時建立合約的競態（MIL-145 交接提到的孤兒合約）由兩層擋住：
// 1. removeProperty 先 `SELECT ... FOR UPDATE` 鎖住物件列。建合約的交易要對這一列做外鍵檢查，
//    需要共享鎖，會排在刪除之後。
// 2. 合約的複合外鍵 (org_id, property_id) 指向 org.properties。排隊的交易醒來時物件已經不在，
//    INSERT 失敗並回滾。測試見 contract-links.pg.test.ts 與 properties.route.test.ts。

/** 物件有沒有任何合約，不分狀態與類型。有就只能封存，不能刪除（P0-06 AC8）。 */
export async function hasContractsForProperty(propertyId: string, tx: OrgTx): Promise<boolean> {
  return propertyHasContracts(tx, propertyId);
}

/** 台北時間的今天，YYYY-MM-DD。合約日期欄位也是這個格式，字串比較即時間比較。 */
export function taipeiToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(now);
}

/**
 * 物件有沒有已完成且租期未屆滿的租賃合約（P0-06 AC4）。租期止日當天仍算未屆滿。
 * 租期止日沒填的已完成合約，無從判斷屆滿，保守視為未屆滿。
 */
export async function hasActiveLeaseForProperty(propertyId: string, tx: OrgTx, now: Date = new Date()): Promise<boolean> {
  const today = taipeiToday(now);
  const { rows } = await tx.query<{ end_date: string | null }>(
    `SELECT fields->>'endDate' AS end_date FROM org.contracts
      WHERE property_id = $1 AND status = 'completed' AND contract_type = 'lease'`,
    [propertyId],
  );
  return rows.some((row) => !row.end_date || row.end_date >= today);
}
