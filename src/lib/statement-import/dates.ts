// 日期工具。日期一律是 YYYY-MM-DD 字串，代表台灣當地日期，不經過 Date.now() 或本機時區。
// 曆法運算沿用 receivables 的日期工具，不重複實作。

import { diffDays, parseDate } from '../receivables/dates';

export { diffDays };

export function isRealIsoDate(value: string): boolean {
  try {
    parseDate(value);
    return true;
  } catch {
    return false;
  }
}
