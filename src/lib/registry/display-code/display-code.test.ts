import { describe, expect, it } from 'vitest';
import { DisplayCodeFormatError, formatDisplayCode, parseDisplayCode } from './display-code';

const UNIT_ID = '01JC8X4Z9M2TQ5W7B3N67K3QZP';

describe('formatDisplayCode：產生顯示編碼', () => {
  it.each([
    { name: '正常輸入', county: 'F', town: '18', id: UNIT_ID, expected: 'F18-7K3QZP' },
    { name: '鄉鎮編碼 01', county: 'A', town: '01', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', expected: 'A01-9G5FAV' },
    { name: '縣市字母小寫', county: 'f', town: '18', id: UNIT_ID, expected: 'F18-7K3QZP' },
    { name: 'ULID 小寫', county: 'F', town: '18', id: UNIT_ID.toLowerCase(), expected: 'F18-7K3QZP' },
  ])('$name → $expected', ({ county, town, id, expected }) => {
    expect(formatDisplayCode({ countyLetter: county, townCode: town, rentalUnitId: id })).toBe(expected);
  });

  it.each([
    { name: '縣市字母兩碼', county: 'FF', town: '18', id: UNIT_ID, field: 'countyLetter' },
    { name: '縣市字母空字串', county: '', town: '18', id: UNIT_ID, field: 'countyLetter' },
    { name: '縣市字母是數字', county: '1', town: '18', id: UNIT_ID, field: 'countyLetter' },
    { name: '鄉鎮編碼一碼', county: 'F', town: '8', id: UNIT_ID, field: 'townCode' },
    { name: '鄉鎮編碼三碼', county: 'F', town: '018', id: UNIT_ID, field: 'townCode' },
    { name: '鄉鎮編碼含字母', county: 'F', town: '1A', id: UNIT_ID, field: 'townCode' },
    { name: 'ULID 25 碼', county: 'F', town: '18', id: UNIT_ID.slice(0, 25), field: 'rentalUnitId' },
    { name: 'ULID 27 碼', county: 'F', town: '18', id: `${UNIT_ID}X`, field: 'rentalUnitId' },
    { name: 'ULID 含 I', county: 'F', town: '18', id: '01JC8X4Z9M2TQ5W7B3N67K3QZI', field: 'rentalUnitId' },
    { name: 'ULID 含 U', county: 'F', town: '18', id: '01JC8X4Z9M2TQ5W7B3N67K3QZU', field: 'rentalUnitId' },
    { name: 'ULID 首碼超過 7', county: 'F', town: '18', id: '81JC8X4Z9M2TQ5W7B3N67K3QZP', field: 'rentalUnitId' },
    { name: 'ULID 是 UUID', county: 'F', town: '18', id: '3f2b8c1e-9d4a-4b7e-8a1c-2e5f6a7b8c9d', field: 'rentalUnitId' },
  ])('$name → 丟出 DisplayCodeFormatError（$field）', ({ county, town, id, field }) => {
    let caught: unknown;
    try {
      formatDisplayCode({ countyLetter: county, townCode: town, rentalUnitId: id });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DisplayCodeFormatError);
    expect((caught as DisplayCodeFormatError).field).toBe(field);
  });
});

describe('parseDisplayCode：解析顯示編碼', () => {
  it.each([
    { name: '正常輸入', input: 'F18-7K3QZP' },
    { name: '全部小寫', input: 'f18-7k3qzp' },
    { name: '大小寫混用', input: 'f18-7K3qZp' },
    { name: '全形連字號', input: 'F18－7K3QZP' },
    { name: '前後空白', input: '  F18-7K3QZP\n' },
  ])('$name → F / 18 / 7K3QZP', ({ input }) => {
    expect(parseDisplayCode(input)).toEqual({
      ok: true,
      countyLetter: 'F',
      townCode: '18',
      unitIdSuffix: '7K3QZP',
    });
  });

  it.each([
    { name: '空字串', input: '' },
    { name: '缺連字號', input: 'F187K3QZP' },
    { name: '末段 5 碼', input: 'F18-7K3QZ' },
    { name: '末段 7 碼', input: 'F18-7K3QZPA' },
    { name: '鄉鎮編碼一碼', input: 'F8-7K3QZP' },
    { name: '鄉鎮編碼含字母', input: 'F1A-7K3QZP' },
    { name: '縣市字母是數字', input: '118-7K3QZP' },
    { name: '末段含 O', input: 'F18-7K3QZO' },
    { name: '末段含 L', input: 'F18-7K3QZL' },
    { name: '末段含符號', input: 'F18-7K3QZ!' },
    { name: '兩個連字號', input: 'F18--7K3QZP' },
    { name: '中間有空白', input: 'F18 - 7K3QZP' },
  ])('$name → 格式錯誤', ({ input }) => {
    expect(parseDisplayCode(input)).toEqual({ ok: false, reason: 'invalid-format' });
  });

  it('產生的編碼解析回來與 ULID 末 6 碼一致', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const code = formatDisplayCode({ countyLetter: 'A', townCode: '01', rentalUnitId: id });
    expect(parseDisplayCode(code)).toEqual({
      ok: true,
      countyLetter: 'A',
      townCode: '01',
      unitIdSuffix: id.slice(-6),
    });
  });
});
