import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeStatement } from './encoding';
import { parseStatementAmount, parseStatementCsv, parseStatementDate } from './parse';
import type { ColumnMapping } from './types';

const fixtureText = (name: string) => decodeStatement(new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)))).text;

const twoColumnMapping: ColumnMapping = {
  transactionDate: '交易日期',
  amount: { deposit: '存入', withdrawal: '支出' },
  summary: '摘要',
  counterpartyName: '對方戶名',
  counterpartyAccount: '對方帳號',
  transactionSerial: '交易序號',
};

const rocSignedMapping: ColumnMapping = {
  transactionDate: '帳務日',
  amount: { signed: '金額' },
  summary: '備註',
  counterpartyName: '付款人',
  counterpartyAccount: '付款帳號',
};

describe('parseStatementDate（西元與民國年）', () => {
  it.each([
    ['2026-03-05', '2026-03-05'],
    ['2026/3/5', '2026-03-05'],
    ['2026.03.05', '2026-03-05'],
    ['20260305', '2026-03-05'],
    ['2026年3月5日', '2026-03-05'],
    ['2026/03/05 14:30:10', '2026-03-05'],
    ['2026-03-05T14:30:00', '2026-03-05'],
    ['  2026-03-05  ', '2026-03-05'],
    ['115/03/05', '2026-03-05'],
    ['115-3-5', '2026-03-05'],
    ['115.03.05', '2026-03-05'],
    ['1150305', '2026-03-05'],
    ['115年3月5日', '2026-03-05'],
    ['民國115年3月5日', '2026-03-05'],
    ['099/01/05', '2010-01-05'],
    ['99/01/05', '2010-01-05'],
    ['2028/02/29', '2028-02-29'],
    ['117/02/29', '2028-02-29'],
  ])('%s 解成 %s', (input, expected) => {
    expect(parseStatementDate(input)).toBe(expected);
  });

  it.each([
    '',
    'abc',
    '2026-02-30',
    '2027/02/29',
    '115/13/01',
    '000/01/01',
    '2026/03',
    '115305',
    '2026-3-5-1',
    '2026-03-05x',
  ])('拒絕 %j', (input) => {
    expect(parseStatementDate(input)).toBeNull();
  });
});

describe('parseStatementAmount', () => {
  it.each([
    ['1000', 1000],
    ['1,000', 1000],
    ['+1,000', 1000],
    ['-1,000', -1000],
    ['(1,000)', -1000],
    ['1,000.00', 1000],
    ['NT$1,000', 1000],
    ['$ 1,000', 1000],
    ['  25,000 ', 25000],
  ])('%s 解成 %d', (input, expected) => {
    expect(parseStatementAmount(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['', 'amount_missing'],
    ['  ', 'amount_missing'],
    ['0', 'amount_missing'],
    ['abc', 'invalid_amount'],
    ['1.2.3', 'invalid_amount'],
    ['1,000.50', 'amount_not_integer'],
    ['9007199254740993', 'amount_unsafe'],
  ])('%j 回傳 %s', (input, code) => {
    expect(parseStatementAmount(input)).toEqual({ ok: false, code });
  });
});

describe('parseStatementCsv：fixture', () => {
  it('UTF-8、西元年、存入支出兩欄、出帳列略過', () => {
    const result = parseStatementCsv(fixtureText('basic-utf8.csv'), twoColumnMapping);
    expect(result.errors).toEqual([]);
    expect(result.skippedCount).toBe(1);
    expect(result.blankCount).toBe(0);
    expect(result.rows).toEqual([
      {
        lineNo: 2,
        transactionDate: '2026-03-05',
        depositAmount: 25000,
        summary: '轉入',
        counterpartyName: '王小明',
        counterpartyAccount: '0123456789012',
        transactionSerial: 'TX0001',
        sameDaySeq: 1,
      },
      {
        lineNo: 4,
        transactionDate: '2026-03-10',
        depositAmount: 1000,
        summary: '轉入',
        counterpartyName: '陳,大華',
        counterpartyAccount: '9876543210',
        transactionSerial: null,
        sameDaySeq: 1,
      },
      {
        lineNo: 5,
        transactionDate: '2026-03-10',
        depositAmount: 1000,
        summary: '轉入',
        counterpartyName: '陳,大華',
        counterpartyAccount: '9876543210',
        transactionSerial: null,
        sameDaySeq: 2,
      },
    ]);
  });

  it('Big5 解碼後的結果與 UTF-8 相同', () => {
    const utf8 = parseStatementCsv(fixtureText('basic-utf8.csv'), twoColumnMapping);
    const big5 = parseStatementCsv(fixtureText('basic-big5.csv'), twoColumnMapping);
    expect(big5).toEqual(utf8);
  });

  it('民國年、單一金額欄正負號', () => {
    const result = parseStatementCsv(fixtureText('roc-signed.csv'), rocSignedMapping);
    expect(result.errors).toEqual([]);
    expect(result.skippedCount).toBe(1);
    expect(result.rows.map((r) => [r.transactionDate, r.depositAmount, r.counterpartyName, r.counterpartyAccount])).toEqual([
      ['2026-03-05', 25000, '王小明', '***56789'],
      ['2026-03-10', 1000, '陳大華', '98765'],
    ]);
    expect(result.rows.every((r) => r.transactionSerial === null)).toBe(true);
  });

  it('略過表頭前的說明列、空列，並回報合計列的錯誤', () => {
    const result = parseStatementCsv(fixtureText('preamble-blank-footer.csv'), {
      transactionDate: '交易日',
      amount: { deposit: '存入', withdrawal: '支出' },
      summary: '摘要',
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ lineNo: 4, transactionDate: '2026-03-05', depositAmount: 2000, summary: '轉入' });
    expect(result.skippedCount).toBe(1);
    expect(result.blankCount).toBe(2);
    expect(result.errors).toEqual([{ lineNo: 8, code: 'invalid_date', detail: '合計' }]);
  });

  it('欄位缺漏：表頭少了對應的欄位', () => {
    const result = parseStatementCsv(fixtureText('missing-column.csv'), twoColumnMapping);
    expect(result.rows).toEqual([]);
    expect(result.skippedCount).toBe(0);
    expect(result.errors).toEqual([{ lineNo: null, code: 'header_not_found', detail: '存入、對方戶名、對方帳號、交易序號' }]);
  });
});

describe('parseStatementCsv：列層級', () => {
  const header = '日期,存入,支出,摘要\n';
  const mapping: ColumnMapping = { transactionDate: '日期', amount: { deposit: '存入', withdrawal: '支出' }, summary: '摘要' };

  it('完全沒有內容時回報找不到表頭', () => {
    const result = parseStatementCsv('', mapping);
    expect(result.errors).toEqual([{ lineNo: null, code: 'header_not_found', detail: '日期、存入、支出、摘要' }]);
  });

  it('存入與支出同時有值', () => {
    const result = parseStatementCsv(`${header}2026-03-05,100,50,x\n`, mapping);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([{ lineNo: 2, code: 'amount_conflict', detail: '100 / 50' }]);
  });

  it('存入與支出都沒有值', () => {
    const result = parseStatementCsv(`${header}2026-03-05,,,x\n`, mapping);
    expect(result.errors).toEqual([{ lineNo: 2, code: 'amount_missing', detail: '' }]);
  });

  it('欄位數不足的列：缺的儲存格視為空', () => {
    const result = parseStatementCsv(`${header}2026-03-05\n`, mapping);
    expect(result.errors).toEqual([{ lineNo: 2, code: 'amount_missing', detail: '' }]);
  });

  it('日期壞掉的列不影響其他列', () => {
    const result = parseStatementCsv(`${header}2026-13-45,100,,a\n2026-03-06,200,,b\n`, mapping);
    expect(result.errors).toEqual([{ lineNo: 2, code: 'invalid_date', detail: '2026-13-45' }]);
    expect(result.rows.map((r) => r.depositAmount)).toEqual([200]);
  });

  it('存入欄的負數是錯誤，不當成出帳', () => {
    const result = parseStatementCsv(`${header}2026-03-05,-100,,a\n`, mapping);
    expect(result.errors).toEqual([{ lineNo: 2, code: 'invalid_amount', detail: '-100' }]);
  });

  it('金額不是整數元', () => {
    const result = parseStatementCsv(`${header}2026-03-05,100.5,,a\n`, mapping);
    expect(result.errors).toEqual([{ lineNo: 2, code: 'amount_not_integer', detail: '100.5' }]);
  });

  it('只有存入欄的對應：沒有支出欄也能解析', () => {
    const result = parseStatementCsv('日期,存入\n2026-03-05,100\n', { transactionDate: '日期', amount: { deposit: '存入' } });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ summary: '', counterpartyName: '', counterpartyAccount: '', transactionSerial: null });
  });

  it('單一金額欄：零元是錯誤', () => {
    const result = parseStatementCsv('日期,金額\n2026-03-05,0\n', { transactionDate: '日期', amount: { signed: '金額' } });
    expect(result.errors).toEqual([{ lineNo: 2, code: 'amount_missing', detail: '0' }]);
  });

  it('引號內的換行與跳脫引號', () => {
    const text = `${header}2026-03-05,100,,"第一行\n""第二行"""\n2026-03-06,200,,b\n`;
    const result = parseStatementCsv(text, mapping);
    expect(result.rows.map((r) => [r.lineNo, r.summary])).toEqual([
      [2, '第一行\n"第二行"'],
      [4, 'b'],
    ]);
  });

  it('引號沒有關閉：回報錯誤並處理已讀到的列', () => {
    const result = parseStatementCsv(`${header}2026-03-05,100,,a\n2026-03-06,200,,"b\n`, mapping);
    expect(result.rows).toHaveLength(2);
    expect(result.errors).toEqual([{ lineNo: 3, code: 'unterminated_quote', detail: '' }]);
  });

  it('CRLF 換行與開頭的 BOM', () => {
    const result = parseStatementCsv(`﻿日期,存入,支出,摘要\r\n2026-03-05,100,,a\r\n`, mapping);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
  });

  it('Tab 分隔', () => {
    const result = parseStatementCsv('日期\t存入\n2026-03-05\t1,000\n', {
      transactionDate: '日期',
      amount: { deposit: '存入' },
      delimiter: '\t',
    });
    expect(result.rows.map((r) => r.depositAmount)).toEqual([1000]);
  });

  it('Excel 文字公式 ="123" 還原成 123', () => {
    const result = parseStatementCsv('日期,存入,帳號\n2026-03-05,100,="0012345678"\n', {
      transactionDate: '日期',
      amount: { deposit: '存入' },
      counterpartyAccount: '帳號',
    });
    expect(result.rows[0].counterpartyAccount).toBe('0012345678');
  });

  it('當日同值序號：同日、同金額、同摘要依出現順序編號，不同值重新計', () => {
    const text = `${header}2026-03-05,100,,a\n2026-03-05,100,,a\n2026-03-05,100,,b\n2026-03-05,100,,a\n2026-03-06,100,,a\n`;
    const result = parseStatementCsv(text, mapping);
    expect(result.rows.map((r) => r.sameDaySeq)).toEqual([1, 2, 1, 3, 1]);
  });

  it('表頭名稱前後空白與重複表頭：取第一個符合的欄', () => {
    const result = parseStatementCsv(' 日期 ,存入,存入\n2026-03-05,100,999\n', { transactionDate: '日期', amount: { deposit: '存入' } });
    expect(result.rows.map((r) => r.depositAmount)).toEqual([100]);
  });
});
