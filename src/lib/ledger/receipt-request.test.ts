import { describe, expect, it } from 'vitest';
import { newUlid } from '../pg/ulid';
import { parseReceiptRequest, safeEvidenceName, sniffEvidenceType } from './receipt-request';

// MIL-125：登錄請求的欄位檢查。期望值是手寫字面值。

const ACCOUNT = newUlid();
const valid = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: 'form-key-12345',
  purpose: 'rent',
  amount: 30000,
  valueDate: '2026-11-08',
  paymentAccountId: ACCOUNT,
  ...over,
});

describe('parseReceiptRequest', () => {
  it('JSON 請求：通過，確認欄位預設為 false', () => {
    expect(parseReceiptRequest(valid())).toEqual({
      ok: true,
      value: { idempotencyKey: 'form-key-12345', purpose: 'rent', amount: 30000, valueDate: '2026-11-08', paymentAccountId: ACCOUNT, acknowledgeHolderWarning: false },
    });
  });

  it('multipart 請求：金額與確認欄位是字串也通過', () => {
    expect(parseReceiptRequest(valid({ amount: ' 60000 ', purpose: 'security_deposit', acknowledgeHolderWarning: 'true' }))).toMatchObject({
      ok: true,
      value: { amount: 60000, purpose: 'security_deposit', acknowledgeHolderWarning: true },
    });
    expect(parseReceiptRequest(valid({ acknowledgeHolderWarning: '' }))).toMatchObject({ ok: true, value: { acknowledgeHolderWarning: false } });
  });

  it.each([
    ['不是物件', null],
    ['陣列', []],
    ['冪等鍵太短', valid({ idempotencyKey: 'abc' })],
    ['冪等鍵含空白', valid({ idempotencyKey: 'form key 12345' })],
    ['冪等鍵缺', valid({ idempotencyKey: undefined })],
    ['用途不合法', valid({ purpose: 'deposit' })],
    ['金額 0', valid({ amount: 0 })],
    ['金額有小數', valid({ amount: 100.5 })],
    ['金額字串有小數', valid({ amount: '100.5' })],
    ['金額為負', valid({ amount: '-5' })],
    ['金額超過安全整數', valid({ amount: '99999999999999999' })],
    ['入帳日不存在', valid({ valueDate: '2026-02-30' })],
    ['入帳日格式錯誤', valid({ valueDate: '2026/11/08' })],
    ['收款帳戶不是 ULID', valid({ paymentAccountId: 'x' })],
    ['確認欄位是別的字串', valid({ acknowledgeHolderWarning: 'yes' })],
  ])('拒絕：%s', (_label, raw) => {
    expect(parseReceiptRequest(raw)).toMatchObject({ ok: false, error: expect.any(String) });
  });
});

describe('sniffEvidenceType', () => {
  it('認得 PDF、JPEG、PNG 的檔頭', () => {
    expect(sniffEvidenceType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toBe('application/pdf');
    expect(sniffEvidenceType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffEvidenceType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe('image/png');
  });

  it('其他檔案、空檔與只有部分檔頭的檔案回 null', () => {
    expect(sniffEvidenceType(new TextEncoder().encode('<html></html>'))).toBeNull();
    expect(sniffEvidenceType(new Uint8Array([]))).toBeNull();
    expect(sniffEvidenceType(new Uint8Array([0x25, 0x50, 0x44]))).toBeNull();
  });
});

describe('safeEvidenceName', () => {
  it.each([
    ['匯款單.pdf', '匯款單.pdf'],
    ['C:\\Users\\a\\匯款單.pdf', '匯款單.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['a\u0000b\nc.png', 'abc.png'],
    ['   ', 'fallback.pdf'],
    ['/', 'fallback.pdf'],
  ])('%j → %j', (input, expected) => {
    expect(safeEvidenceName(input, 'fallback.pdf')).toBe(expected);
  });

  it('超過 200 字時截斷', () => {
    expect([...safeEvidenceName('字'.repeat(300), 'x')]).toHaveLength(200);
  });
});
