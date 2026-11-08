// 接手時的收款帳戶規則（ADR-0024 決議 9、P0-22 規則 4）。純函式，client 與 server 共用。

/** 記憶體 adapter 經 Server Action 收證明檔案，受 Next.js 預設 1 MB 請求上限限制，所以先訂 800 KB。 */
export const EVIDENCE_FILE_MAX_BYTES = 800 * 1024;

export const EVIDENCE_FILE_TOO_LARGE = `證明檔案超過 ${EVIDENCE_FILE_MAX_BYTES / 1024} KB。請壓縮後再上傳，或改填說明。`;

/**
 * 收款帳戶持有人是否變更。目前沒有收款帳戶時不算變更。
 * TODO(MIL-105, MIL-107) evaluateHolderRule：E 線提供後換成押金收取規則的判斷，這裡先比對持有人名稱。
 */
export function accountHolderChanges(currentHolder: string | null, nextHolder: string | null): boolean {
  return currentHolder !== null && nextHolder !== null && currentHolder !== nextHolder;
}

/** YYYY-MM-DD，而且是日曆上存在的日期。 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
