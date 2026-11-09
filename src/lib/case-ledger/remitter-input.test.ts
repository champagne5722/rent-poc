import { describe, expect, it } from 'vitest';
import { parseRemitterInput } from './remitter-input';

// 匯款識別的輸入檢查與正規化（ADR-0050 決議 6）。純函式，表格測試。期望值是手寫的字面值。
describe('parseRemitterInput', () => {
  it.each([
    ['戶名：前後空白去除', { kind: 'payer_name', value: '  王大明 ' }, '王大明'],
    ['戶名：連續空白合成一個', { kind: 'payer_name', value: '王   大明' }, '王 大明'],
    ['戶名：全形空白與全形英數轉半形（NFKC）', { kind: 'payer_name', value: 'ＷＡＮＧ　DAMING' }, 'WANG DAMING'],
    ['戶名：Tab 與換行也視為空白', { kind: 'payer_name', value: '王\t大\n明' }, '王 大 明'],
    ['戶名：恰好 60 字', { kind: 'payer_name', value: '王'.repeat(60) }, '王'.repeat(60)],
    ['末五碼：五位數字', { kind: 'account_last5', value: '12345' }, '12345'],
    ['末五碼：前後空白去除', { kind: 'account_last5', value: ' 01234 ' }, '01234'],
    ['末五碼：全形數字轉半形', { kind: 'account_last5', value: '１２３４５' }, '12345'],
  ] as const)('%s', (_name, input, expected) => {
    expect(parseRemitterInput(input)).toEqual({ ok: true, value: { kind: input.kind, value: expected } });
  });

  it.each([
    ['戶名空白', { kind: 'payer_name', value: '   ' }],
    ['戶名超過 60 字', { kind: 'payer_name', value: '王'.repeat(61) }],
    ['末五碼只有四位', { kind: 'account_last5', value: '1234' }],
    ['末五碼六位', { kind: 'account_last5', value: '123456' }],
    ['末五碼含英文字母', { kind: 'account_last5', value: '1234a' }],
    ['末五碼含連字號', { kind: 'account_last5', value: '12-45' }],
    ['種類不認得', { kind: 'phone', value: '0912345678' }],
    ['種類缺少', { value: '12345' }],
    ['值不是字串', { kind: 'payer_name', value: 12345 }],
    ['整個輸入不是物件', 'payer_name'],
    ['整個輸入是 null', null],
  ] as const)('%s：回傳錯誤訊息', (_name, input) => {
    const result = parseRemitterInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual(expect.any(String));
  });
});
