// 事件 payload 的欄位讀取小工具。其他線寫自己的事件定義時也用這些，檢查規則才一致。

import { isValidLedgerId } from './accounts';

export function asRecord(raw: unknown, errors: string[]): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push('payload 必須是物件');
    return null;
  }
  return raw as Record<string, unknown>;
}

/** 讀必填的 ID 欄位。不合法時記錄錯誤並回傳空字串，呼叫端用錯誤清單判斷。 */
export function readId(source: Record<string, unknown>, key: string, errors: string[]): string {
  const value = source[key];
  if (!isValidLedgerId(value)) {
    errors.push(`${key} 必須是 1 到 64 字的英數、底線或連字號`);
    return '';
  }
  return value;
}

/**
 * 讀金額欄位，必須是不為負的安全整數。
 * `required` 為 false 時，缺值視為 0。`positive` 為 true 時，0 也不接受。
 */
export function readAmount(
  source: Record<string, unknown>,
  key: string,
  errors: string[],
  options: { required?: boolean; positive?: boolean } = {},
): number {
  const { required = true, positive = false } = options;
  const value = source[key];
  if (value === undefined && !required) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    errors.push(`${key} 必須是整數元的安全整數`);
    return 0;
  }
  if (value < 0 || (positive && value === 0)) {
    errors.push(positive ? `${key} 必須大於 0` : `${key} 不得為負`);
    return 0;
  }
  return value;
}
