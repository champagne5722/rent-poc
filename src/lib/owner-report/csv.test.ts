import { describe, expect, it } from 'vitest';
import { buildOwnerReport } from './build';
import { CSV_SECTIONS, OWNER_REPORT_CSV_COLUMNS, reportToCsv, reportToCsvRows } from './csv';
import {
  ACC_CASH,
  ACC_MGR,
  allocation,
  deductionJournal,
  emptyInput,
  options,
  period,
  receiptJournal,
  receiptRecord,
  returnJournal,
  reverse,
  unit,
} from './fixtures';
import type { OwnerReport, OwnerReportInput } from './types';

/** 最小的 RFC 4180 解析器，測試用。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const UA1 = unit({ unitId: 'U_A1', caseId: 'C_A1', address: '台北市大安區和平東路一段 1 號 3 樓，後棟' });
const UA2 = unit({ unitId: 'U_A2', caseId: 'C_A2', isSocialHousing: true, agreedHandoverDays: 7 });

function world(): OwnerReportInput {
  const sepReceipt = receiptJournal({ journalId: 'J_SEP', caseId: 'C_A1', postedAt: '2026-09-28T10:00:00+08:00', deposit: 40000, accountId: ACC_MGR });
  const octReceipt = receiptJournal({ journalId: 'J_OCT', caseId: 'C_A1', postedAt: '2026-10-06T10:00:00+08:00', rent: 15000, prepaidRent: 2000 });
  const sepRent = receiptJournal({ journalId: 'J_SEPR', caseId: 'C_A1', postedAt: '2026-09-28T11:00:00+08:00', rent: 20000 });
  const cashReceipt = receiptJournal({ journalId: 'J_CASH', caseId: 'C_A2', postedAt: '2026-10-07T10:00:00+08:00', rent: 9000, accountId: ACC_CASH });
  const deduction = deductionJournal({ journalId: 'J_DED', caseId: 'C_A1', postedAt: '2026-10-15T10:00:00+08:00', amount: 3000 });
  return {
    ...emptyInput(),
    units: [UA1, UA2],
    periods: [
      period({ id: 'P_A1_09', caseId: 'C_A1', periodKey: '2026-09', dueDate: '2026-09-05' }),
      period({ id: 'P_A1_10', caseId: 'C_A1', periodKey: '2026-10', dueDate: '2026-10-05' }),
      period({ id: 'P_A2_10', caseId: 'C_A2', periodKey: '2026-10', dueDate: '2026-10-05', amount: 9000 }),
    ],
    allocations: [
      allocation({ id: 'AL1', periodId: 'P_A1_10', amount: 15000, postedAt: '2026-10-06T10:00:00+08:00' }),
      allocation({ id: 'AL2', periodId: 'P_A2_10', amount: 9000, postedAt: '2026-10-07T10:00:00+08:00' }),
    ],
    journals: [
      sepReceipt,
      sepRent,
      octReceipt,
      cashReceipt,
      deduction,
      returnJournal({ journalId: 'J_RET', caseId: 'C_A1', postedAt: '2026-10-20T10:00:00+08:00', amount: 1000 }),
      reverse(sepRent, { journalId: 'J_SEPR_R', postedAt: '2026-10-21T10:00:00+08:00', reason: '重複登錄，="x"' }),
    ],
    receipts: [
      receiptRecord({ journalId: 'J_SEP', caseId: 'C_A1', source: 'statement_file' }),
      receiptRecord({ journalId: 'J_SEPR', caseId: 'C_A1', source: 'statement_file' }),
      receiptRecord({ journalId: 'J_OCT', caseId: 'C_A1', note: '備註含逗號,與"引號"' }),
      receiptRecord({ journalId: 'J_CASH', caseId: 'C_A2' }),
    ],
    depositLedgers: [{ caseId: 'C_A1', expectedAmount: 40000, paymentAccountId: ACC_MGR }],
    deductions: [{ deductionId: 'D1', caseId: 'C_A1', journalId: 'J_DED', reason: '牆面修補\n含換行', disputed: true }],
    holderAcknowledgments: [
      { caseId: 'C_A1', confirmedBy: '陳經理', confirmedAt: '2026-09-28T09:00:00+08:00', ruleId: 'DHR-02', ruleVersion: 1 },
    ],
    handovers: [
      { handoverId: 'H1', caseId: 'C_A2', fundKind: 'rent', receivedAt: '2026-10-07', amount: 9000, handedOverAt: '2026-10-15', handedOverAmount: 8500 },
      { handoverId: 'H2', caseId: 'C_A1', fundKind: 'deposit', receivedAt: '2026-10-30', amount: 40000, handedOverAt: null, handedOverAmount: null },
    ],
    repairs: [
      { repairId: 'R1', caseId: 'C_A1', description: '=熱水器漏水', status: 'completed', reportedAt: '2026-10-02', closedAt: '2026-10-09', cost: 3500, payer: '屋主', handler: '好管家' },
      { repairId: 'R2', caseId: 'C_A2', description: '紗窗破損', status: 'reported', reportedAt: '2026-10-28', closedAt: null, cost: null, payer: null, handler: null },
    ],
  };
}

function csvOf(report: OwnerReport): string[][] {
  return parseCsv(reportToCsv(report));
}

describe('CSV 長格式', () => {
  const report = buildOwnerReport(world(), '2026-10', options({ varianceNotes: { H1: '扣代管服務費 500' } }));
  const text = reportToCsv(report);
  const rows = parseCsv(text);

  it('第一個位元組序列是 UTF-8 BOM（EF BB BF）', () => {
    const bytes = new TextEncoder().encode(text);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('標題列是九個欄位，行尾 CRLF，結尾有換行', () => {
    expect(rows[0]).toEqual(['﻿區段', ...OWNER_REPORT_CSV_COLUMNS.slice(1)]);
    expect(OWNER_REPORT_CSV_COLUMNS).toEqual(['區段', '租賃單位 ID', '門牌', '項目', '日期', '金額', '來源', '標示', '說明']);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '').includes('\n')).toBe(true); // 儲存格內的換行被引號包住，不是行尾
  });

  it('每一行都是九欄，欄位內的逗號、引號與換行都能還原', () => {
    expect(rows.every((r) => r.length === 9)).toBe(true);
    expect(rows.some((r) => r[8] === '登錄日 2026-10-06，收款帳戶 012-***1234，備註含逗號,與"引號"')).toBe(true);
    expect(rows.some((r) => r[2] === '台北市大安區和平東路一段 1 號 3 樓，後棟')).toBe(true);
    expect(rows.some((r) => r[8].includes('牆面修補\n含換行'))).toBe(true);
  });

  it('資料列數 = 各區段的列展開後的行數，每個區段都有行', () => {
    expect(rows.length - 1).toBe(reportToCsvRows(report).length);
    const sections = new Set(rows.slice(1).map((r) => r[0]));
    expect([...sections]).toEqual(Object.values(CSV_SECTIONS));
  });

  it('欄位型區段每個單位每個欄位一行，紀錄型區段每筆一行', () => {
    const count = (section: string) => rows.filter((r) => r[0] === section).length;
    expect(count(CSV_SECTIONS.summary)).toBe(5);
    expect(count(CSV_SECTIONS.rent)).toBe(4 * report.rent.length);
    expect(count(CSV_SECTIONS.deposit)).toBe(7 * report.deposit.length + report.deposit.reduce((s, d) => s + d.deductions.length, 0));
    expect(count(CSV_SECTIONS.handovers)).toBe(3 * report.handovers.length);
    expect(count(CSV_SECTIONS.attention)).toBe(report.attention.length);
    expect(count(CSV_SECTIONS.repairs)).toBe(report.repairs.length);
    expect(count(CSV_SECTIONS.ledgerDetail)).toBe(report.ledgerDetail.length);
    expect(count(CSV_SECTIONS.sources)).toBe(4);
    expect(count(CSV_SECTIONS.notes)).toBe(4);
  });

  it('金額欄是整數，沖銷列是負數，沒有金額的列留空', () => {
    const amounts = rows.slice(1).map((r) => r[5]);
    expect(amounts.every((a) => a === '' || /^-?\d+$/.test(a))).toBe(true);
    const reversal = rows.find((r) => r[0] === CSV_SECTIONS.ledgerDetail && r[3] === '沖銷');
    expect(reversal?.[5]).toBe('-20000');
    expect(rows.find((r) => r[0] === CSV_SECTIONS.header && r[3] === '屋主')?.[5]).toBe('');
  });

  it('來源欄用 manual、statement_file、現金收取', () => {
    const detail = rows.filter((r) => r[0] === CSV_SECTIONS.ledgerDetail);
    expect(detail.map((r) => r[6])).toEqual(['manual', 'manual', '現金收取', 'statement_file']);
    expect(rows.filter((r) => r[0] === CSV_SECTIONS.sources).map((r) => r[6])).toEqual(['manual', 'statement_file', '現金收取', '']);
  });

  it('標示欄：逾期、逾 5 日、逾約定日數、已被沖銷', () => {
    const flags = new Set(rows.slice(1).map((r) => r[7]).filter((f) => f !== ''));
    expect(flags.has('逾期')).toBe(true);
    expect(flags.has('逾 5 日')).toBe(true);
    expect(flags.has('押金未交付')).toBe(true);
    expect(report.handovers.find((h) => h.handoverId === 'H1')?.flag).toBe('逾 5 日');
  });

  it('差額與差額說明進 CSV', () => {
    const diff = rows.find((r) => r[0] === CSV_SECTIONS.handovers && r[3] === '差額' && r[1] === 'U_A2');
    expect(diff?.[5]).toBe('500');
    expect(diff?.[8]).toBe('扣代管服務費 500');
  });

  it('來源比例列帶百分比，合計列等於全部入帳金額', () => {
    const sources = rows.filter((r) => r[0] === CSV_SECTIONS.sources);
    expect(sources.map((r) => r[8])).toEqual(['65.38%', '0.00%', '34.62%', '100.00%']);
    expect(sources[3][5]).toBe('26000');
    expect(sources.slice(0, 3).reduce((s, r) => s + Number(r[5]), 0)).toBe(Number(sources[3][5]));
  });

  it('註記四條都在 CSV 裡', () => {
    const notes = rows.filter((r) => r[0] === CSV_SECTIONS.notes).map((r) => r[8]);
    expect(notes).toEqual(report.notes.map((n) => n.text));
    expect(notes[0]).toBe('金額以銀行紀錄為準。');
  });
});

describe('CSV 安全', () => {
  it('文字欄位以 = + - @ 開頭時加單引號，避免試算表當成公式', () => {
    const rows = csvOf(buildOwnerReport(world(), '2026-10', options()));
    const repair = rows.find((r) => r[0] === CSV_SECTIONS.repairs && r[1] === 'U_A1');
    expect(repair?.[8].startsWith("熱水器")).toBe(false);
    expect(repair?.[8].startsWith("'=熱水器漏水")).toBe(true);
    const reversal = rows.find((r) => r[0] === CSV_SECTIONS.ledgerDetail && r[3] === '沖銷');
    expect(reversal?.[8]).toContain('重複登錄');
  });

  it('負的金額不加單引號', () => {
    const text = reportToCsv(buildOwnerReport(world(), '2026-10', options()));
    expect(text).toContain(',-20000,');
    expect(text).not.toContain("'-20000");
  });

  it('金額不是安全整數時丟 RangeError', () => {
    const report = buildOwnerReport(world(), '2026-10', options());
    report.summary.rentDue = 1.5;
    expect(() => reportToCsv(report)).toThrow(RangeError);
  });
});

describe('空報表', () => {
  it('沒有任何單位也能產出：只有抬頭、摘要、來源比例與註記', () => {
    const report = buildOwnerReport(emptyInput(), '2026-10', options());
    const rows = parseCsv(reportToCsv(report));
    expect([...new Set(rows.slice(1).map((r) => r[0]))]).toEqual([
      CSV_SECTIONS.header,
      CSV_SECTIONS.summary,
      CSV_SECTIONS.sources,
      CSV_SECTIONS.notes,
    ]);
    expect(rows.every((r) => r.length === 9)).toBe(true);
  });
});
