// 登錄入帳確認的請求檢查（MIL-125）。純函式，沒有 I/O。route 在開交易前先檢查，格式錯誤時不佔連線。
// JSON 與 multipart 兩種請求長一樣的欄位，multipart 的值都是字串，所以數字與布林都要接受字串。

import { isUlid } from '../pg/ulid';
import { isValidEffectiveDate } from './header';
import { RECEIPT_PURPOSES, type ReceiptPurpose } from './receipt-types';

export interface ReceiptRequest {
  /** 表單產生的冪等鍵，連點兩次只入帳一次。 */
  idempotencyKey: string;
  purpose: ReceiptPurpose;
  amount: number;
  valueDate: string;
  paymentAccountId: string;
  acknowledgeHolderWarning: boolean;
}

export type ParseReceiptRequestResult = { ok: true; value: ReceiptRequest } | { ok: false; error: string };

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

function readAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string' && /^[0-9]{1,16}$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

export function parseReceiptRequest(raw: unknown): ParseReceiptRequestResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: '請求內容不合法' };
  const body = raw as Record<string, unknown>;

  if (typeof body.idempotencyKey !== 'string' || !KEY_PATTERN.test(body.idempotencyKey)) {
    return { ok: false, error: '表單的識別碼不合法，請重新整理頁面' };
  }
  if (typeof body.purpose !== 'string' || !(RECEIPT_PURPOSES as readonly string[]).includes(body.purpose)) {
    return { ok: false, error: '請選擇入帳用途：租金或押金' };
  }
  const amount = readAmount(body.amount);
  if (amount === null || amount <= 0) return { ok: false, error: '入帳金額必須是大於 0 的整數元' };
  if (typeof body.valueDate !== 'string' || !isValidEffectiveDate(body.valueDate)) {
    return { ok: false, error: '入帳日必須是存在的日期（YYYY-MM-DD）' };
  }
  if (typeof body.paymentAccountId !== 'string' || !isUlid(body.paymentAccountId)) {
    return { ok: false, error: '請選擇收款帳戶' };
  }
  const ack = body.acknowledgeHolderWarning;
  if (ack !== undefined && ack !== true && ack !== false && ack !== 'true' && ack !== 'false' && ack !== '') {
    return { ok: false, error: '押金帳戶規則的確認欄位不合法' };
  }
  return {
    ok: true,
    value: {
      idempotencyKey: body.idempotencyKey,
      purpose: body.purpose as ReceiptPurpose,
      amount,
      valueDate: body.valueDate,
      paymentAccountId: body.paymentAccountId,
      acknowledgeHolderWarning: ack === true || ack === 'true',
    },
  };
}

/** 證明檔大小上限。 */
export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;

export const EVIDENCE_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
} as const;
export type EvidenceContentType = keyof typeof EVIDENCE_TYPES;

/** 看檔案開頭的位元組判斷類型，不信任瀏覽器回報的 Content-Type。不是允許的類型回 null。 */
export function sniffEvidenceType(bytes: Uint8Array): EvidenceContentType | null {
  const startsWith = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  return null;
}

/** 顯示用的檔名：去掉路徑、控制字元，最長 200 字。去掉後是空的就用預設名稱。 */
export function safeEvidenceName(name: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex -- 要過濾的就是控制字元
  const base = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const cut = [...base].slice(0, 200).join('');
  return cut === '' ? fallback : cut;
}
