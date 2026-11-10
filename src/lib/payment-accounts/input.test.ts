import { describe, expect, it } from 'vitest';
import { HOLDER_KIND_LABELS, parsePaymentAccountInput } from './input';

const bank = (over: Record<string, unknown> = {}) => ({
  name: '王先生的台新帳戶',
  holderKind: 'lessor',
  holderName: '王大明',
  method: 'bank',
  bankCode: '812',
  accountLast4: '0123',
  ...over,
});

describe('parsePaymentAccountInput', () => {
  it('銀行帳戶：回傳去除前後空白的值', () => {
    expect(parsePaymentAccountInput(bank({ name: '  王先生的台新帳戶 ', holderName: ' 王大明 ' }))).toEqual({
      ok: true,
      value: { name: '王先生的台新帳戶', holderKind: 'lessor', holderName: '王大明', method: 'bank', bankCode: '812', accountLast4: '0123' },
    });
  });

  it('現金收取：不需要銀行欄位，回傳的銀行欄位是 null', () => {
    const result = parsePaymentAccountInput({ name: '現金', holderKind: 'other', holderName: '李小華', method: 'cash' });
    expect(result).toEqual({
      ok: true,
      value: { name: '現金', holderKind: 'other', holderName: '李小華', method: 'cash', bankCode: null, accountLast4: null },
    });
  });

  it('持有人的 party：請求有帶就回傳（去除前後空白），沒帶或空字串時回傳值沒有這個欄位', () => {
    const party = '01M71Q7FFF25FFVTXJZPNMM7F9';
    expect(parsePaymentAccountInput(bank({ holderPartyId: ` ${party} ` }))).toMatchObject({ ok: true, value: { holderPartyId: party } });
    for (const empty of [undefined, null, '', '  ']) {
      const result = parsePaymentAccountInput(bank({ holderPartyId: empty }));
      expect(result.ok && 'holderPartyId' in result.value, String(empty)).toBe(false);
    }
  });

  it('持有人的 party 不是字串：400 層級的格式錯誤，不放行到資料庫', () => {
    for (const bad of [123, {}, [], true]) {
      expect(parsePaymentAccountInput(bank({ holderPartyId: bad }))).toEqual({ ok: false, error: '持有人格式有誤' });
    }
  });

  it('接受 7 碼銀行加分行代碼', () => {
    expect(parsePaymentAccountInput(bank({ bankCode: '8120456 ' }))).toMatchObject({ ok: true, value: { bankCode: '8120456' } });
  });

  it.each([
    ['非物件', 'x'],
    ['陣列', []],
    ['沒有名稱', bank({ name: '  ' })],
    ['名稱過長', bank({ name: 'a'.repeat(61) })],
    ['未知持有人種類', bank({ holderKind: 'trust' })],
    ['持有人名稱空白', bank({ holderName: '' })],
    ['未知收款方式', bank({ method: 'escrow' })],
    ['銀行代碼 2 碼', bank({ bankCode: '81' })],
    ['銀行代碼含字母', bank({ bankCode: '81a' })],
    ['末四碼 3 碼', bank({ accountLast4: '012' })],
    ['完整帳號', bank({ accountLast4: '12345678901234' })],
    ['缺末四碼', bank({ accountLast4: undefined })],
    ['現金收取帶銀行代碼', { name: 'x', holderKind: 'other', holderName: 'y', method: 'cash', bankCode: '812' }],
    ['現金收取帶末四碼', { name: 'x', holderKind: 'other', holderName: 'y', method: 'cash', accountLast4: '0123' }],
  ])('拒絕：%s', (_label, body) => {
    expect(parsePaymentAccountInput(body)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it('other 沒填持有人姓名時，提示的是「持有人姓名」', () => {
    expect(parsePaymentAccountInput(bank({ holderKind: 'other', holderName: '' }))).toEqual({ ok: false, error: '請填持有人姓名' });
  });

  it('持有人種類的介面名稱不出現「信託」', () => {
    expect(Object.values(HOLDER_KIND_LABELS).join('')).not.toContain('信託');
  });
});
