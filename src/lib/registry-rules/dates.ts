// 日期工具，只給 registry-rules 內部用，不從 index 匯出。
// 日期一律是 YYYY-MM-DD 字串（台灣日期），用 UTC 計算，不依賴執行環境的時區。

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(date: string): { y: number; m: number; d: number } | null {
  const match = ISO_DATE.exec(date);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

function format(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function mustParse(date: string): { y: number; m: number; d: number } {
  const parsed = parse(date);
  if (!parsed) throw new RangeError(`日期格式必須是有效的 YYYY-MM-DD：${date}`);
  return parsed;
}

export function isIsoDate(value: string): boolean {
  return parse(value) !== null;
}

export function addDays(date: string, days: number): string {
  const { y, m, d } = mustParse(date);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return format(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** 加減月份。目標月份沒有該日時截到當月最後一天（8/31 減 6 個月是 2/28）。 */
export function addMonths(date: string, months: number): string {
  const { y, m, d } = mustParse(date);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return format(ny, nm, Math.min(d, lastDay));
}

export function addYears(date: string, years: number): string {
  return addMonths(date, years * 12);
}
