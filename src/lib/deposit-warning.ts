// 押金超過 2 個月租金的警告（PRD P0-10 規則 7、AC6）。
// 依據是內政部範本的押金上限。只警告不阻擋；是否改為阻擋待法務確認（MIL-62）。
// 純函式：UI 在欄位步驟與確認頁共用，不碰表單狀態。

/** 內政部範本的押金上限，單位是月租金。 */
export const DEPOSIT_LIMIT_MONTHS = 2;

export interface DepositWarning {
  rent: number;
  deposit: number;
  /** 押金上限金額，等於月租金乘以 DEPOSIT_LIMIT_MONTHS。 */
  limit: number;
  /** 給畫面直接顯示的警告文字。 */
  message: string;
}

function dollars(value: number): string {
  return `$${value.toLocaleString('en-US')}`;
}

/**
 * 押金超過 2 個月租金時回傳警告，否則回 null。
 * 剛好 2 個月不警告。租金或押金未填、租金不是正數、任一值不是有限數字時，無法比較，不警告。
 */
export function depositWarning(
  rent: number | null | undefined,
  deposit: number | null | undefined,
): DepositWarning | null {
  if (rent == null || deposit == null) return null;
  if (!Number.isFinite(rent) || !Number.isFinite(deposit)) return null;
  if (rent <= 0) return null;
  const limit = rent * DEPOSIT_LIMIT_MONTHS;
  if (deposit <= limit) return null;
  return {
    rent,
    deposit,
    limit,
    message: `押金 ${dollars(deposit)} 超過 ${DEPOSIT_LIMIT_MONTHS} 個月租金（${dollars(limit)}）。內政部範本的押金上限為 ${DEPOSIT_LIMIT_MONTHS} 個月租金，請與承租人確認約定金額。`,
  };
}
