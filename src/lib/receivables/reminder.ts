// 繳租提醒的確認規則與代收交付逾期標示（MIL-42 Q1、ADR-0014 決議 14、ADR-0050 決議 13）。
// 純函式，時間由參數傳入。

import { DAY_MS, diffDays, parseDate, parseInstant } from './dates';

/**
 * 同一期別 24 小時內已手動提醒時，再按必須先確認。
 * 距上次不滿 24 小時回傳 true，剛好 24 小時回傳 false。從沒提醒過回傳 false。
 * 上次時間晚於現在（時鐘不同步）視為仍在 24 小時內。時間是含時區的 ISO 8601 字串。
 */
export function shouldConfirmReminder(lastReminderAt: string | null, now: string): boolean {
  const nowMs = parseInstant(now);
  if (lastReminderAt === null) return false;
  return nowMs - parseInstant(lastReminderAt) < DAY_MS;
}

/** 社宅代管案件代收租金的交付期限天數（社宅範本 §8，PRD P0-19）。 */
export const SOCIAL_HOUSING_HANDOVER_DAYS = 5;

export type HandoverDelayLabel =
  /** 「逾約定 N 日」：N 是約定日數。 */
  | { key: 'over_agreed_days'; agreedDays: number; elapsedDays: number }
  /** 「逾 5 日」：社宅代管案件。 */
  | { key: 'over_social_housing_5_days'; limitDays: typeof SOCIAL_HOUSING_HANDOVER_DAYS; elapsedDays: number };

/**
 * 代收交付逾期標示。經過日數是入帳日到交付日的日曆日數。
 * 社宅代管案件超過 5 日時一律標示「逾 5 日」，優先於「逾約定 N 日」。
 * 其餘情況超過約定日數時標示「逾約定 N 日」。沒有逾期回傳 null。
 * 尚未交付（handedOverAt 為 null）時以 `today` 計算。沒有 `today` 時回傳 null。
 * 系統顯示的是約定日數，不是法定期限。
 */
export function handoverDelayLabel(
  agreedDays: number | null,
  handedOverAt: string | null,
  receivedAt: string,
  isSocialHousing: boolean,
  today?: string,
): HandoverDelayLabel | null {
  if (agreedDays !== null && (!Number.isInteger(agreedDays) || agreedDays < 0)) {
    throw new RangeError(`約定日數必須是 0 以上的整數：${agreedDays}`);
  }
  parseDate(receivedAt);
  const endDate = handedOverAt ?? today;
  if (handedOverAt !== null) parseDate(handedOverAt);
  if (endDate === undefined) return null;
  const elapsedDays = diffDays(endDate, receivedAt);
  if (elapsedDays < 0) throw new RangeError(`交付日早於入帳日：${endDate} 早於 ${receivedAt}`);

  if (isSocialHousing && elapsedDays > SOCIAL_HOUSING_HANDOVER_DAYS) {
    return { key: 'over_social_housing_5_days', limitDays: SOCIAL_HOUSING_HANDOVER_DAYS, elapsedDays };
  }
  if (agreedDays !== null && elapsedDays > agreedDays) {
    return { key: 'over_agreed_days', agreedDays, elapsedDays };
  }
  return null;
}
