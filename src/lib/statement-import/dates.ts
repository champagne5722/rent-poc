// 日期工具。日期一律是 YYYY-MM-DD 字串，代表台灣當地日期，不經過 Date.now() 或本機時區。

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isRealIsoDate(value: string): boolean {
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** 兩個日期相差的天數（a 減 b）。不合法時丟 RangeError。 */
export function diffDays(a: string, b: string): number {
  for (const v of [a, b]) {
    if (!isRealIsoDate(v)) throw new RangeError(`日期必須是 YYYY-MM-DD：${v}`);
  }
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
}
