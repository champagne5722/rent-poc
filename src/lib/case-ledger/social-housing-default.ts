import type { OrgTx } from '../pg/with-tx';

// 獨立成一個檔：建立案件的程式（case-store/commands.ts）只需要這個函式，不該因此匯入通知與寄信模組。

/**
 * 建立案件時，社宅旗標的預設值：有委託管理案件時帶入它的旗標，沒有或看不到時是 false（ADR-0050 決議 10）。
 * 委託管理案件的旗標就是委託管理合約的設定，由 MIL-116、MIL-119 建立委託管理案件時寫入。
 */
export async function resolveSocialHousingDefault(tx: OrgTx, linkedMandateCaseId: string | null): Promise<boolean> {
  if (linkedMandateCaseId === null) return false;
  const { rows } = await tx.query<{ social_housing: boolean }>(
    `SELECT social_housing FROM org.cases WHERE id = $1 AND kind = 'management'`,
    [linkedMandateCaseId],
  );
  return rows[0]?.social_housing ?? false;
}
