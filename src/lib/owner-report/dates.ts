// 日期工具。日期一律是 YYYY-MM-DD 字串，代表台灣當地日期，不讀系統時鐘。

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_MS = 86_400_000;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** 日期必須存在於日曆上。不合法丟 RangeError。 */
export function assertDate(value: string, name: string): void {
  const m = typeof value === 'string' ? DATE_RE.exec(value) : null;
  if (!m) throw new RangeError(`${name}必須是 YYYY-MM-DD：${JSON.stringify(value)}`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`${name}不是存在的日期：${value}`);
  }
}

export interface MonthBounds {
  month: string;
  start: string;
  end: string;
}

/** `YYYY-MM` 換成當月第一天與最後一天。不合法丟 RangeError。 */
export function monthBounds(month: string): MonthBounds {
  const m = typeof month === 'string' ? MONTH_RE.exec(month) : null;
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
    throw new RangeError(`月份必須是 YYYY-MM：${JSON.stringify(month)}`);
  }
  const [year, mon] = [Number(m[1]), Number(m[2])];
  return {
    month,
    start: `${pad(year, 4)}-${pad(mon, 2)}-01`,
    end: `${pad(year, 4)}-${pad(mon, 2)}-${pad(daysInMonth(year, mon), 2)}`,
  };
}

/** later 與 earlier 相差的日曆日數。later 較晚時為正。兩者都必須是合法日期。 */
export function diffDays(later: string, earlier: string): number {
  assertDate(later, '日期');
  assertDate(earlier, '日期');
  const toDay = (v: string) =>
    Math.round(Date.UTC(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, Number(v.slice(8, 10))) / DAY_MS);
  return toDay(later) - toDay(earlier);
}

/** 字串遞增比較。依序比較多個鍵，全部相等回傳 0。 */
export function compareText(...pairs: Array<readonly [string, string]>): number {
  for (const [a, b] of pairs) {
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

/** 日期落在該月（含頭尾）。 */
export function inMonth(date: string, bounds: MonthBounds): boolean {
  return date >= bounds.start && date <= bounds.end;
}
