import type { RemitterKind } from './types';
import { REMITTER_KINDS } from './types';

// 匯款識別的輸入檢查與正規化（ADR-0050 決議 6，MIL-123）。純函式，沒有 I/O。
// 戶名與帳號末五碼都先正規化再存。對帳檔的列（MIL-129）比對時，兩邊用同一個函式正規化，
// 所以全形與半形、前後空白、連續空白不會讓同一個人配不上。

export const MAX_PAYER_NAME_LENGTH = 60;

export interface RemitterInput {
  kind: RemitterKind;
  value: string;
}

export type RemitterInputResult = { ok: true; value: RemitterInput } | { ok: false; error: string };

/** 戶名正規化：NFKC、任何空白（含全形空白、Tab、換行）合成一個半形空白、去除前後空白。 */
export function normalizePayerName(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** 帳號末五碼正規化：NFKC 後去除前後空白。是否為五位數字由 parseRemitterInput 檢查。 */
export function normalizeAccountLast5(raw: string): string {
  return raw.normalize('NFKC').trim();
}

export function parseRemitterInput(raw: unknown): RemitterInputResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '匯款識別必須是物件' };
  const { kind, value } = raw as Record<string, unknown>;
  if (typeof kind !== 'string' || !(REMITTER_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: '匯款識別的種類必須是付款人戶名或付款帳號末五碼' };
  }
  if (typeof value !== 'string') return { ok: false, error: '匯款識別的內容必須是文字' };

  if (kind === 'payer_name') {
    const name = normalizePayerName(value);
    if (name === '') return { ok: false, error: '付款人戶名不得空白' };
    if ([...name].length > MAX_PAYER_NAME_LENGTH) return { ok: false, error: `付款人戶名不得超過 ${MAX_PAYER_NAME_LENGTH} 字` };
    return { ok: true, value: { kind, value: name } };
  }
  const last5 = normalizeAccountLast5(value);
  if (!/^[0-9]{5}$/.test(last5)) return { ok: false, error: '付款帳號末五碼必須是 5 位數字' };
  return { ok: true, value: { kind: 'account_last5', value: last5 } };
}
