import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeStatement } from './encoding';
import { externalIdFor } from './external-id';
import { parseStatementCsv } from './parse';
import type { StatementRow } from './types';

const row = (overrides: Partial<StatementRow> = {}): StatementRow => ({
  lineNo: 2,
  transactionDate: '2026-03-10',
  depositAmount: 1000,
  summary: '轉入',
  counterpartyName: '陳大華',
  counterpartyAccount: '9876543210',
  transactionSerial: null,
  sameDaySeq: 1,
  ...overrides,
});

describe('externalIdFor：有交易序號', () => {
  it('直接用交易序號（ADR-0014 決議 7）', () => {
    expect(externalIdFor(row({ transactionSerial: 'TX0001' }), 'acct-01')).toBe('TX0001');
  });
  it('序號相同時，其他欄位不影響結果', () => {
    const a = externalIdFor(row({ transactionSerial: 'TX0001', depositAmount: 1 }), 'acct-01');
    const b = externalIdFor(row({ transactionSerial: 'TX0001', summary: '別的' }), 'acct-02');
    expect(a).toBe(b);
  });
});

describe('externalIdFor：沒有交易序號', () => {
  it('SHA-256 十六進位，內容是收款帳戶、入帳日、金額、摘要、當日同值序號（獨立算出的值）', () => {
    expect(externalIdFor(row(), 'acct-01')).toBe('244023afcedaf97d2382ce6f8c1b44998e32c889d6ba7a01aa86029f278ab9d8');
  });
  it('同一列兩次得到同一 ID', () => {
    expect(externalIdFor(row(), 'acct-01')).toBe(externalIdFor(row(), 'acct-01'));
  });
  it('同日同值兩列（當日同值序號不同）得到不同 ID', () => {
    expect(externalIdFor(row({ sameDaySeq: 1 }), 'acct-01')).not.toBe(externalIdFor(row({ sameDaySeq: 2 }), 'acct-01'));
  });
  it('對方戶名、行號不影響 ID（重疊區間的檔案要得到同一把鍵）', () => {
    const a = externalIdFor(row({ lineNo: 2, counterpartyName: 'A' }), 'acct-01');
    const b = externalIdFor(row({ lineNo: 40, counterpartyName: 'B' }), 'acct-01');
    expect(a).toBe(b);
  });
  it.each([
    ['收款帳戶', row(), 'acct-02'],
    ['入帳日', row({ transactionDate: '2026-03-11' }), 'acct-01'],
    ['金額', row({ depositAmount: 1001 }), 'acct-01'],
    ['摘要', row({ summary: '轉帳' }), 'acct-01'],
  ])('%s不同就得到不同 ID', (_name, other, accountId) => {
    expect(externalIdFor(other, accountId)).not.toBe(externalIdFor(row(), 'acct-01'));
  });
  it('欄位之間不會因為內容含分隔字元而撞鍵', () => {
    const a = externalIdFor(row({ summary: '1,"a' }), 'acct-01');
    const b = externalIdFor(row({ summary: '1', depositAmount: 1000 }), 'acct-01,');
    expect(a).not.toBe(b);
  });
  it('序號前後空白視為沒有序號', () => {
    expect(externalIdFor(row({ transactionSerial: '  ' }), 'acct-01')).toBe(externalIdFor(row(), 'acct-01'));
  });
});

describe('externalIdFor：輸入不合法', () => {
  it.each([
    ['收款帳戶為空', row(), ''],
    ['金額不是整數', row({ depositAmount: 10.5 }), 'acct-01'],
    ['金額不是安全整數', row({ depositAmount: 2 ** 53 }), 'acct-01'],
    ['金額為零', row({ depositAmount: 0 }), 'acct-01'],
    ['當日同值序號小於 1', row({ sameDaySeq: 0 }), 'acct-01'],
    ['入帳日格式錯誤', row({ transactionDate: '2026/03/10' }), 'acct-01'],
  ])('%s丟 RangeError', (_name, r, accountId) => {
    expect(() => externalIdFor(r, accountId)).toThrow(RangeError);
  });
});

describe('externalIdFor：搭配解析結果', () => {
  it('fixture 中同日同值的兩列得到不同 ID，有序號的列用序號', () => {
    const text = decodeStatement(new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'basic-utf8.csv')))).text;
    const { rows } = parseStatementCsv(text, {
      transactionDate: '交易日期',
      amount: { deposit: '存入', withdrawal: '支出' },
      summary: '摘要',
      transactionSerial: '交易序號',
    });
    const ids = rows.map((r) => externalIdFor(r, 'acct-01'));
    expect(ids[0]).toBe('TX0001');
    expect(ids[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(ids[2]).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(ids).size).toBe(3);
  });
});
