// 日期工具。日期一律是 YYYY-MM-DD 字串，代表台灣當地日期，不經過 Date.now() 或本機時區。

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const TAIPEI_OFFSET_MS = 8 * 3_600_000;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export interface YmdParts {
  year: number;
  month: number;
  day: number;
}

/** 解析並驗證 YYYY-MM-DD。不合法時丟 RangeError。 */
export function parseDate(value: string): YmdParts {
  const m = DATE_RE.exec(value);
  if (!m) throw new RangeError(`日期格式必須是 YYYY-MM-DD：${value}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`不存在的日期：${value}`);
  }
  return { year, month, day };
}

export function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function toDayNumber(value: string): number {
  const { year, month, day } = parseDate(value);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

/** later 與 earlier 相差的日曆日數。later 較晚時為正。 */
export function diffDays(later: string, earlier: string): number {
  return toDayNumber(later) - toDayNumber(earlier);
}

/** 把 ISO 8601 時間點（含時區）換成台灣日期。呼叫端用它由時間戳取得 `today`。 */
export function toTaipeiDate(instant: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError(`無法解析的時間：${instant}`);
  const d = new Date(ms + TAIPEI_OFFSET_MS);
  return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 金額必須是 0 以上的安全整數元。 */
export function assertMoney(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} 必須是 0 以上的安全整數元：${value}`);
  }
}
