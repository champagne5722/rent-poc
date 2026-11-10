// 審核台的等待時間與逾時判斷（MIL-201，ADR-0028 決議 3、Consequences）。
// 目標是 1 個工作日內完成核對。純函式，時間由參數傳入。
//
// 工作日的算法（待法務確認與待訪談驗證）：
// - 以臺北時間（UTC+8，沒有夏令時間）的星期一到星期五計算，每個工作日算 24 小時。
// - 週六與週日不計。國定假日與補班日先不處理，等有公告資料再補。
// - 週五晚上送出的項目，週末不計入等待時間，所以週末不會讓項目逾時。

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TAIPEI_OFFSET_MS = 8 * HOUR_MS;

/** 核對的目標時限，單位是工作日。 */
export const REVIEW_TARGET_BUSINESS_DAYS = 1;

/** 從 start 到 end 之間，落在臺北時間週一到週五的毫秒數。end 不晚於 start 回 0。 */
export function businessMsBetween(start: Date, end: Date): number {
  const from = start.getTime() + TAIPEI_OFFSET_MS;
  const to = end.getTime() + TAIPEI_OFFSET_MS;
  if (!(to > from)) return 0;
  let total = 0;
  // 以臺北時間的日為單位走過去，從 from 所在日的 00:00 起算
  for (let dayStart = Math.floor(from / DAY_MS) * DAY_MS; dayStart < to; dayStart += DAY_MS) {
    // 位移後的時間戳以 UTC 讀星期，就是臺北時間的星期
    const weekday = new Date(dayStart).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    total += Math.min(to, dayStart + DAY_MS) - Math.max(from, dayStart);
  }
  return total;
}

/** 是否超過核對的目標時限。剛好等於時限不算逾時。 */
export function isReviewOverdue(createdAt: Date, endAt: Date, targetBusinessDays: number = REVIEW_TARGET_BUSINESS_DAYS): boolean {
  return businessMsBetween(createdAt, endAt) > targetBusinessDays * DAY_MS;
}
