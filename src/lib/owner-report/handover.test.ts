import { describe, expect, it } from 'vitest';
import { buildOwnerReport } from './build';
import { allocation, emptyInput, options, period, unit } from './fixtures';
import type { OwnerReportInput, ReportHandover } from './types';

const UA1 = unit({ unitId: 'U_A1', caseId: 'C_A1', agreedHandoverDays: 3 });
const UA2_SOCIAL = unit({ unitId: 'U_A2', caseId: 'C_A2', isSocialHousing: true, agreedHandoverDays: 7 });
const UA3_LONG = unit({ unitId: 'U_A3', caseId: 'C_A3', agreedHandoverDays: 14 });

function handover(over: Partial<ReportHandover> & Pick<ReportHandover, 'handoverId' | 'caseId'>): ReportHandover {
  return {
    fundKind: 'rent',
    receivedAt: '2026-10-01',
    amount: 20000,
    handedOverAt: null,
    handedOverAmount: null,
    ...over,
  };
}

function input(handovers: ReportHandover[], units = [UA1, UA2_SOCIAL, UA3_LONG]): OwnerReportInput {
  return { ...emptyInput(), units, handovers };
}

describe('代收交付標示', () => {
  it('社宅代管案件代收租金超過 5 日標示「逾 5 日」，優先於約定日數', () => {
    const report = buildOwnerReport(
      input([handover({ handoverId: 'H1', caseId: 'C_A2', handedOverAt: '2026-10-07', handedOverAmount: 20000 })]),
      '2026-10',
      options(),
    );
    expect(report.handovers[0]).toMatchObject({ elapsedDays: 6, agreedDays: 7, flag: '逾 5 日' });
    expect(report.attention).toMatchObject([{ kind: 'handover_delay', flag: '逾 5 日', handoverId: 'H1' }]);
  });

  it('社宅代管案件剛好 5 日不標示', () => {
    const report = buildOwnerReport(
      input([handover({ handoverId: 'H1', caseId: 'C_A2', handedOverAt: '2026-10-06', handedOverAmount: 20000 })]),
      '2026-10',
      options(),
    );
    expect(report.handovers[0].flag).toBeNull();
    expect(report.attention).toEqual([]);
  });

  it('一般代管案件超過約定日數標示「逾約定 N 日」', () => {
    const report = buildOwnerReport(
      input([handover({ handoverId: 'H1', caseId: 'C_A1', handedOverAt: '2026-10-05', handedOverAmount: 20000 })]),
      '2026-10',
      options(),
    );
    expect(report.handovers[0]).toMatchObject({ elapsedDays: 4, flag: '逾約定 3 日' });
    expect(report.attention[0]).toMatchObject({ kind: 'handover_delay', flag: '逾約定 3 日' });
  });

  it('尚未交付的租金算到月底，逾期照樣標示', () => {
    const report = buildOwnerReport(input([handover({ handoverId: 'H1', caseId: 'C_A1' })]), '2026-10', options());
    expect(report.handovers[0]).toMatchObject({ handedOverAt: null, elapsedDays: 30, flag: '逾約定 3 日', difference: null });
    expect(report.attention[0].note).toContain('尚未交付');
  });

  it('社宅的 5 日規定只管租金，代收押金只看約定日數', () => {
    const report = buildOwnerReport(
      input([handover({ handoverId: 'H1', caseId: 'C_A2', fundKind: 'deposit', handedOverAt: '2026-10-07', handedOverAmount: 20000 })]),
      '2026-10',
      options(),
    );
    expect(report.handovers[0].flag).toBeNull();
  });

  it('沒有約定日數、也不是社宅時不標示', () => {
    const noDays = unit({ unitId: 'U_A4', caseId: 'C_A4', agreedHandoverDays: null });
    const report = buildOwnerReport(
      input([handover({ handoverId: 'H1', caseId: 'C_A4' })], [noDays]),
      '2026-10',
      options(),
    );
    expect(report.handovers[0].flag).toBeNull();
    expect(report.attention).toEqual([]);
  });
});

describe('代收押金未交付', () => {
  const deposit = handover({ handoverId: 'H_DEP', caseId: 'C_A3', fundKind: 'deposit', receivedAt: '2026-10-25', amount: 40000 });

  it('交付前列在需要留意', () => {
    const report = buildOwnerReport(input([deposit]), '2026-10', options());
    expect(report.attention).toEqual([
      {
        kind: 'deposit_not_handed_over',
        unitId: 'U_A3',
        address: 'U_A3 路 1 號',
        amount: 40000,
        date: '2026-10-25',
        flag: '押金未交付',
        note: '代收押金，代收日 2026-10-25，尚未交付，已 6 日',
        handoverId: 'H_DEP',
      },
    ]);
  });

  it('交付後離開需要留意，代收代付與交付區段仍列著這筆', () => {
    const delivered = { ...deposit, handedOverAt: '2026-10-27', handedOverAmount: 40000 };
    const report = buildOwnerReport(input([delivered]), '2026-10', options());
    expect(report.attention).toEqual([]);
    expect(report.handovers).toMatchObject([{ handoverId: 'H_DEP', handedOverAt: '2026-10-27', difference: 0 }]);
  });

  it('交付日晚於月底，月底當時仍算未交付，下個月報表才離開', () => {
    const later = { ...deposit, handedOverAt: '2026-11-02', handedOverAmount: 40000 };
    const oct = buildOwnerReport(input([later]), '2026-10', options());
    expect(oct.attention.map((a) => a.kind)).toEqual(['deposit_not_handed_over']);
    expect(oct.handovers[0]).toMatchObject({ handedOverAt: null, handedOverAmount: null });
    const nov = buildOwnerReport(input([later]), '2026-11', options());
    expect(nov.attention).toEqual([]);
    expect(nov.handovers.map((h) => h.handoverId)).toEqual(['H_DEP']);
  });

  it('未交付又超過約定日數時只出一項，標示用逾約定', () => {
    const short = handover({ handoverId: 'H_DEP2', caseId: 'C_A1', fundKind: 'deposit', receivedAt: '2026-10-10', amount: 30000 });
    const report = buildOwnerReport(input([short]), '2026-10', options());
    expect(report.attention).toHaveLength(1);
    expect(report.attention[0]).toMatchObject({ kind: 'deposit_not_handed_over', flag: '逾約定 3 日' });
  });

  it('交付前的押金跨月一直列著', () => {
    const older = { ...deposit, receivedAt: '2026-08-10' };
    const report = buildOwnerReport(input([older]), '2026-10', options());
    expect(report.attention.map((a) => a.kind)).toEqual(['deposit_not_handed_over']);
    expect(report.handovers).toHaveLength(1);
  });
});

describe('區段納入的列', () => {
  it('上月已交付、本月沒有動作的不列；下個月才代收的不列', () => {
    const report = buildOwnerReport(
      input([
        handover({ handoverId: 'H_OLD', caseId: 'C_A3', receivedAt: '2026-09-01', handedOverAt: '2026-09-03', handedOverAmount: 20000 }),
        handover({ handoverId: 'H_NEW', caseId: 'C_A3', receivedAt: '2026-11-01' }),
        handover({ handoverId: 'H_IN', caseId: 'C_A3', receivedAt: '2026-10-01', handedOverAt: '2026-10-02', handedOverAmount: 20000 }),
        handover({ handoverId: 'H_CARRY', caseId: 'C_A3', receivedAt: '2026-09-28', handedOverAt: '2026-10-03', handedOverAmount: 20000 }),
      ]),
      '2026-10',
      options(),
    );
    expect(report.handovers.map((h) => h.handoverId)).toEqual(['H_CARRY', 'H_IN']);
  });

  it('交付日早於代收日丟 RangeError', () => {
    expect(() =>
      buildOwnerReport(
        input([handover({ handoverId: 'H1', caseId: 'C_A1', handedOverAt: '2026-09-30', handedOverAmount: 20000 })]),
        '2026-10',
        options(),
      ),
    ).toThrow(RangeError);
  });

  it('有交付日卻沒有交付金額丟 RangeError', () => {
    expect(() =>
      buildOwnerReport(input([handover({ handoverId: 'H1', caseId: 'C_A1', handedOverAt: '2026-10-02' })]), '2026-10', options()),
    ).toThrow(RangeError);
  });

  it('別的屋主案件的代收不列', () => {
    const report = buildOwnerReport(input([handover({ handoverId: 'H_B', caseId: 'C_B1' })]), '2026-10', options());
    expect(report.handovers).toEqual([]);
  });
});

describe('差額與差額說明', () => {
  const short = handover({ handoverId: 'H1', caseId: 'C_A3', handedOverAt: '2026-10-03', handedOverAmount: 18500 });

  it('差額 = 代收金額 - 交付金額，沒說明的列入待填清單', () => {
    const report = buildOwnerReport(input([short]), '2026-10', options());
    expect(report.handovers[0]).toMatchObject({ difference: 1500, differenceNote: null });
    expect(report.pendingVarianceNotes).toEqual(['H1']);
  });

  it('產出時填的差額說明存進報表，待填清單清空', () => {
    const report = buildOwnerReport(input([short]), '2026-10', options({ varianceNotes: { H1: '  扣管理費 1500  ' } }));
    expect(report.handovers[0].differenceNote).toBe('扣管理費 1500');
    expect(report.pendingVarianceNotes).toEqual([]);
  });

  it('差額為 0 不需要說明，空白說明視為沒填', () => {
    const exact = { ...short, handedOverAmount: 20000 };
    expect(buildOwnerReport(input([exact]), '2026-10', options()).pendingVarianceNotes).toEqual([]);
    const blank = buildOwnerReport(input([short]), '2026-10', options({ varianceNotes: { H1: '   ' } }));
    expect(blank.pendingVarianceNotes).toEqual(['H1']);
  });
});

describe('需要留意：逾期與排序', () => {
  it('逾期、押金未交付、代收交付逾期依序排列', () => {
    const base = input(
      [
        handover({ handoverId: 'H_LATE', caseId: 'C_A1' }),
        handover({ handoverId: 'H_DEP', caseId: 'C_A3', fundKind: 'deposit', receivedAt: '2026-10-10' }),
      ],
      [UA1, UA3_LONG],
    );
    base.periods = [period({ id: 'P1', caseId: 'C_A1', periodKey: '2026-10', dueDate: '2026-10-05' })];
    const report = buildOwnerReport(base, '2026-10', options());
    expect(report.attention.map((a) => [a.kind, a.unitId])).toEqual([
      ['overdue', 'U_A1'],
      ['deposit_not_handed_over', 'U_A3'],
      ['handover_delay', 'U_A1'],
    ]);
    expect(report.attention[0]).toMatchObject({ amount: 20000, date: '2026-10-05', flag: '逾期' });
  });

  it('足額後逾期離開需要留意', () => {
    const base = input([], [UA1]);
    base.periods = [period({ id: 'P1', caseId: 'C_A1', periodKey: '2026-10', dueDate: '2026-10-05' })];
    base.allocations = [allocation({ id: 'AL1', periodId: 'P1', postedAt: '2026-10-20T10:00:00+08:00' })];
    expect(buildOwnerReport(base, '2026-10', options()).attention).toEqual([]);
  });
});
