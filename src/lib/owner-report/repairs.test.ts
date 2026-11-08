import { describe, expect, it } from 'vitest';
import { buildOwnerReport } from './build';
import { emptyInput, options, unit } from './fixtures';
import { OWNER_REPORT_NOTES } from './labels';
import type { ReportRepair } from './types';

const UA1 = unit({ unitId: 'U_A1', caseId: 'C_A1' });

function repair(over: Partial<ReportRepair> & Pick<ReportRepair, 'repairId'>): ReportRepair {
  return {
    caseId: 'C_A1',
    description: '熱水器漏水',
    status: 'reported',
    reportedAt: '2026-10-05',
    closedAt: null,
    cost: null,
    payer: null,
    handler: null,
    ...over,
  };
}

function report(repairs: ReportRepair[], month = '2026-10') {
  return buildOwnerReport({ ...emptyInput(), units: [UA1], repairs }, month, options());
}

describe('修繕區段', () => {
  it('月底仍未完成的紀錄要列，沒有費用也列', () => {
    const rows = report([repair({ repairId: 'R1' }), repair({ repairId: 'R2', status: 'in_progress', reportedAt: '2026-09-10' })]).repairs;
    expect(rows.map((r) => [r.repairId, r.status, r.cost])).toEqual([
      ['R2', 'in_progress', null],
      ['R1', 'reported', null],
    ]);
  });

  it('本月完成的列出費用、付款方與處理者；上月完成的不列', () => {
    const rows = report([
      repair({ repairId: 'R1', status: 'completed', closedAt: '2026-10-20', cost: 3500, payer: '屋主', handler: '好管家' }),
      repair({ repairId: 'R2', status: 'completed', closedAt: '2026-09-20', reportedAt: '2026-09-01', cost: 800 }),
      repair({ repairId: 'R3', status: 'cancelled', closedAt: '2026-10-08' }),
    ]).repairs;
    expect(rows).toEqual([
      expect.objectContaining({ repairId: 'R1', status: 'completed', cost: 3500, payer: '屋主', handler: '好管家', closedAt: '2026-10-20' }),
      expect.objectContaining({ repairId: 'R3', status: 'cancelled' }),
    ]);
  });

  it('月底後才報修的不列；月底後才完成的，月底當時算處理中', () => {
    const input = [
      repair({ repairId: 'R_NEXT', reportedAt: '2026-11-02' }),
      repair({ repairId: 'R1', status: 'completed', closedAt: '2026-11-03', cost: 900 }),
    ];
    const oct = report(input).repairs;
    expect(oct.map((r) => [r.repairId, r.status, r.closedAt])).toEqual([['R1', 'in_progress', null]]);
    expect(report(input, '2026-11').repairs.map((r) => [r.repairId, r.status])).toEqual([
      ['R1', 'completed'],
      ['R_NEXT', 'reported'],
    ]);
  });

  it('別的屋主案件的修繕不列', () => {
    expect(report([repair({ repairId: 'R1', caseId: 'C_B1' })]).repairs).toEqual([]);
  });

  it('費用不是安全整數丟 RangeError', () => {
    expect(() => report([repair({ repairId: 'R1', cost: 10.5 })])).toThrow(RangeError);
  });
});

describe('抬頭與註記', () => {
  const r = report([]);

  it('抬頭帶屋主、期間、產出者、報表編號、產生時間與不可變聲明', () => {
    expect(r.header).toEqual({
      ownerId: 'OWNER_A',
      ownerName: '王大明',
      month: '2026-10',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      orgId: 'ORG_1',
      producerName: '好管家代管股份有限公司',
      producerLegalTitle: '租賃住宅管理業',
      reportId: 'RPT_2026_10_A',
      generatedAt: '2026-11-02T09:00:00+08:00',
      immutableStatement: '本報表產出後不可變。之後的更正會出現在下一份報表的沖銷列。',
    });
  });

  it('註記四條固定文字', () => {
    expect(r.notes.map((n) => n.text)).toEqual([
      '金額以銀行紀錄為準。',
      '現金收取沒有銀行紀錄。',
      '修繕費用只記錄，不進鏡像帳，系統不代收也不代付。',
      '本報表不得用於報稅。',
    ]);
  });

  it('改動回傳的註記不影響下一份報表', () => {
    r.notes[0].text = 'x';
    expect(report([]).notes[0].text).toBe('金額以銀行紀錄為準。');
    expect(OWNER_REPORT_NOTES[0].text).toBe('金額以銀行紀錄為準。');
  });

  it('同樣的輸入與參數產生完全相同的報表', () => {
    expect(report([repair({ repairId: 'R1' })])).toEqual(report([repair({ repairId: 'R1' })]));
  });
});
