// 對帳檔 CSV 解析（ADR-0014 決議 3、7、ADR-0050 決議 7）。純函式，不讀檔、不碰資料庫。

import { tokenizeCsv } from './csv';
import type { ColumnMapping, ParseError, ParseErrorCode, ParseStatementResult, StatementRow } from './types';

const ROC_YEAR_OFFSET = 1911;
const MIN_YEAR = 1911;
const MAX_YEAR = 2999;

function isRealDate(year: number, month: number, day: number): boolean {
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= days;
}

function toIso(year: number, month: number, day: number): string | null {
  if (!isRealDate(year, month, day)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 解析日期儲存格。接受西元與民國年，分隔字元 `-` `/` `.`、中文「年月日」與純數字。
 * 年份 4 位是西元，1 到 3 位是民國。時間部分會被忽略。無法解析時回傳 null。
 */
export function parseStatementDate(raw: string): string | null {
  const normalized = raw.normalize('NFKC').trim();
  const datePart = normalized.split(/[\sT]/)[0];
  let year: number;
  let month: number;
  let day: number;
  let yearDigits: number;

  const separated = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(datePart);
  const chinese = /^(?:民國)?(\d{1,4})年(\d{1,2})月(\d{1,2})日?$/.exec(datePart);
  const compact = /^(\d{7}|\d{8})$/.exec(datePart);
  if (separated || chinese) {
    const m = (separated ?? chinese)!;
    yearDigits = m[1].length;
    [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if (compact) {
    const digits = compact[1];
    const yearLen = digits.length - 4;
    yearDigits = yearLen;
    [year, month, day] = [Number(digits.slice(0, yearLen)), Number(digits.slice(yearLen, yearLen + 2)), Number(digits.slice(yearLen + 2))];
  } else {
    return null;
  }
  if (yearDigits <= 3) {
    if (year < 1) return null;
    year += ROC_YEAR_OFFSET;
  }
  return toIso(year, month, day);
}

export type AmountParse =
  | { ok: true; value: number }
  | { ok: false; code: Extract<ParseErrorCode, 'amount_missing' | 'invalid_amount' | 'amount_not_integer' | 'amount_unsafe'> };

/**
 * 解析金額儲存格，回傳帶正負號的整數元。接受千分位逗號、前導 +/-、括號負數、NT$ 與 $ 符號。
 * 空白與零元回傳 amount_missing。小數部分不為 0 回傳 amount_not_integer。
 */
export function parseStatementAmount(raw: string): AmountParse {
  let text = raw.normalize('NFKC').replace(/\s+/g, '').replace(/NT\$|NTD|\$/gi, '').replace(/,/g, '');
  if (text === '') return { ok: false, code: 'amount_missing' };
  let negative = false;
  const paren = /^\((.*)\)$/.exec(text);
  if (paren) {
    negative = true;
    text = paren[1];
  }
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return { ok: false, code: 'invalid_amount' };
  if (m[1] === '-') negative = !negative;
  if (m[3] !== undefined && /[^0]/.test(m[3])) return { ok: false, code: 'amount_not_integer' };
  const magnitude = Number(m[2]);
  if (!Number.isSafeInteger(magnitude)) return { ok: false, code: 'amount_unsafe' };
  if (magnitude === 0) return { ok: false, code: 'amount_missing' };
  return { ok: true, value: negative ? -magnitude : magnitude };
}

/** 去掉前後空白與 Excel 文字公式 ="123" 的包裝。 */
function cleanCell(raw: string | undefined): string {
  const text = (raw ?? '').trim();
  const wrapped = /^="(.*)"$/.exec(text);
  return wrapped ? wrapped[1].trim() : text;
}

function requiredHeaders(mapping: ColumnMapping): string[] {
  const names = [mapping.transactionDate];
  if ('signed' in mapping.amount) names.push(mapping.amount.signed);
  else {
    names.push(mapping.amount.deposit);
    if (mapping.amount.withdrawal !== undefined) names.push(mapping.amount.withdrawal);
  }
  for (const name of [mapping.summary, mapping.counterpartyName, mapping.counterpartyAccount, mapping.transactionSerial]) {
    if (name !== undefined) names.push(name);
  }
  return names;
}

type AmountOutcome =
  | { kind: 'deposit'; value: number }
  | { kind: 'withdrawal' }
  | { kind: 'error'; code: ParseErrorCode; detail: string };

function readAmount(mapping: ColumnMapping, cell: (name: string | undefined) => string): AmountOutcome {
  const { amount } = mapping;
  if ('signed' in amount) {
    const raw = cell(amount.signed);
    const parsed = parseStatementAmount(raw);
    if (!parsed.ok) return { kind: 'error', code: parsed.code, detail: raw };
    return parsed.value > 0 ? { kind: 'deposit', value: parsed.value } : { kind: 'withdrawal' };
  }
  const depositRaw = cell(amount.deposit);
  const withdrawalRaw = cell(amount.withdrawal);
  const deposit = parseStatementAmount(depositRaw);
  const withdrawal = parseStatementAmount(withdrawalRaw);
  for (const [parsed, raw] of [[deposit, depositRaw], [withdrawal, withdrawalRaw]] as const) {
    if (!parsed.ok && parsed.code !== 'amount_missing') return { kind: 'error', code: parsed.code, detail: raw };
  }
  const detail = [depositRaw, withdrawalRaw].filter((v) => v !== '').join(' / ');
  if (deposit.ok && withdrawal.ok) return { kind: 'error', code: 'amount_conflict', detail };
  if (deposit.ok) {
    if (deposit.value < 0) return { kind: 'error', code: 'invalid_amount', detail: depositRaw };
    return { kind: 'deposit', value: deposit.value };
  }
  if (withdrawal.ok) return { kind: 'withdrawal' };
  return { kind: 'error', code: 'amount_missing', detail };
}

/**
 * 依欄位對應把對帳檔文字解析成標準列。
 * 成功列只含入帳列。出帳列計入 skippedCount，空列計入 blankCount，壞掉的列進 errors，不影響其他列。
 * 表頭之前的說明列會被略過。表頭缺欄位時回傳 header_not_found，沒有任何成功列。
 */
export function parseStatementCsv(text: string, mapping: ColumnMapping): ParseStatementResult {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = tokenizeCsv(body, mapping.delimiter ?? ',');
  const required = requiredHeaders(mapping);
  const result: ParseStatementResult = { rows: [], skippedCount: 0, blankCount: 0, errors: [] };

  // 找表頭：第一個包含全部對應欄位的記錄。找不到時，用命中最多的記錄回報缺哪些欄位。
  let headerIndex = -1;
  let bestHit = -1;
  let bestMissing = [...new Set(required)];
  for (let i = 0; i < records.length; i += 1) {
    const names = new Set(records[i].cells.map((c) => c.trim()));
    const missing = [...new Set(required)].filter((n) => !names.has(n));
    const hit = new Set(required).size - missing.length;
    if (hit > bestHit && hit > 0) {
      bestHit = hit;
      bestMissing = missing;
      headerIndex = i;
    }
    if (missing.length === 0) break;
  }
  if (headerIndex < 0 || bestMissing.length > 0) {
    result.errors.push({ lineNo: null, code: 'header_not_found', detail: bestMissing.join('、') });
    return result;
  }

  const headers = records[headerIndex].cells.map((c) => c.trim());
  const indexOf = (name: string | undefined) => (name === undefined ? -1 : headers.indexOf(name));
  const seen = new Map<string, number>();

  for (const record of records.slice(headerIndex + 1)) {
    const cell = (name: string | undefined) => cleanCell(record.cells[indexOf(name)]);
    if (record.unterminated) {
      result.errors.push({ lineNo: record.lineNo, code: 'unterminated_quote', detail: '' });
    }
    if (record.cells.every((c) => c.trim() === '')) {
      result.blankCount += 1;
      continue;
    }
    const pushError = (code: ParseErrorCode, detail: string) => {
      const error: ParseError = { lineNo: record.lineNo, code, detail };
      result.errors.push(error);
    };

    const dateRaw = cell(mapping.transactionDate);
    const date = parseStatementDate(dateRaw);
    if (date === null) {
      pushError('invalid_date', dateRaw);
      continue;
    }
    const outcome = readAmount(mapping, cell);
    if (outcome.kind === 'error') {
      pushError(outcome.code, outcome.detail);
      continue;
    }
    if (outcome.kind === 'withdrawal') {
      result.skippedCount += 1;
      continue;
    }

    const summary = cell(mapping.summary);
    const key = JSON.stringify([date, outcome.value, summary]);
    const sameDaySeq = (seen.get(key) ?? 0) + 1;
    seen.set(key, sameDaySeq);
    const serial = cell(mapping.transactionSerial);
    const row: StatementRow = {
      lineNo: record.lineNo,
      transactionDate: date,
      depositAmount: outcome.value,
      summary,
      counterpartyName: cell(mapping.counterpartyName),
      counterpartyAccount: cell(mapping.counterpartyAccount),
      transactionSerial: serial === '' ? null : serial,
      sameDaySeq,
    };
    result.rows.push(row);
  }
  return result;
}
