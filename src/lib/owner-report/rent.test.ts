import { describe, expect, it } from 'vitest';
import { buildOwnerReport } from './build';
import {
  OWNER_B,
  allocation,
  emptyInput,
  options,
  period,
  receiptJournal,
  receiptRecord,
  reverse,
  unit,
} from './fixtures';
import type { OwnerReportInput } from './types';

const UA1 = unit({ unitId: 'U_A1', caseId: 'C_A1' });
const UB1 = unit({ unitId: 'U_B1', caseId: 'C_B1', ownerId: OWNER_B });

function rentFixture(): OwnerReportInput {
  return {
    ...emptyInput(),
    units: [UA1],
    periods: [
      period({ id: 'P_A1_09', caseId: 'C_A1', periodKey: '2026-09', dueDate: '2026-09-05' }),
      period({ id: 'P_A1_10', caseId: 'C_A1', periodKey: '2026-10', dueDate: '2026-10-05' }),
    ],
  };
}

describe('屋主範圍', () => {
  it('屋主 A 的報表不含屋主 B 的單位、期別、分錄與入帳', () => {
    const withB: OwnerReportInput = {
      ...rentFixture(),
      units: [UA1, UB1],
      periods: [
        ...rentFixture().periods,
        period({ id: 'P_B1_10', caseId: 'C_B1', periodKey: '2026-10', amount: 99000 }),
      ],
      journals: [
        receiptJournal({ journalId: 'J_A1', caseId: 'C_A1', postedAt: '2026-10-06T10:00:00+08:00', rent: 20000 }),
        receiptJournal({ journalId: 'J_B1', caseId: 'C_B1', postedAt: '2026-10-06T10:00:00+08:00', rent: 99000, deposit: 198000 }),
      ],
      receipts: [
        receiptRecord({ journalId: 'J_A1', caseId: 'C_A1' }),
        receiptRecord({ journalId: 'J_B1', caseId: 'C_B1' }),
      ],
      allocations: [
        allocation({ id: 'AL_A', periodId: 'P_A1_10', postedAt: '2026-10-06T10:00:00+08:00' }),
        allocation({ id: 'AL_B', periodId: 'P_B1_10', amount: 99000, postedAt: '2026-10-06T10:00:00+08:00' }),
      ],
    };
    const onlyA: OwnerReportInput = {
      ...withB,
      units: [UA1],
      periods: withB.periods.filter((p) => p.caseId === 'C_A1'),
      journals: withB.journals.filter((j) => j.caseId === 'C_A1'),
      receipts: withB.receipts.filter((r) => r.caseId === 'C_A1'),
      allocations: withB.allocations.filter((a) => a.periodId === 'P_A1_10'),
    };

    const mixed = buildOwnerReport(withB, '2026-10', options());
    expect(mixed).toEqual(buildOwnerReport(onlyA, '2026-10', options()));
    expect(mixed.rent.map((r) => r.unitId)).toEqual(['U_A1']);
    expect(mixed.summary.rentDue).toBe(20000);
    expect(mixed.ledgerDetail.map((r) => r.journalId)).toEqual(['J_A1']);
    expect(JSON.stringify(mixed)).not.toContain('U_B1');
  });

  it('同一位屋主在別的產出組織的單位不進這份報表', () => {
    const other = unit({ unitId: 'U_A9', caseId: 'C_A9', orgId: 'ORG_2' });
    const report = buildOwnerReport({ ...rentFixture(), units: [UA1, other] }, '2026-10', options());
    expect(report.rent.map((r) => r.unitId)).toEqual(['U_A1']);
  });

  it('同組織的分錄若掛在別的組織下也不計入', () => {
    const foreign = receiptJournal({ journalId: 'J_X', caseId: 'C_A1', postedAt: '2026-10-06T10:00:00+08:00', rent: 5, orgId: 'ORG_2' });
    const report = buildOwnerReport({ ...rentFixture(), journals: [foreign] }, '2026-10', options());
    expect(report.ledgerDetail).toEqual([]);
  });
});

describe('租金：應收、已入帳、逾期、預收', () => {
  it('已入帳是配置到本月期別的金額，月底前寫入才算', () => {
    const input = {
      ...rentFixture(),
      allocations: [
        allocation({ id: 'AL_1', periodId: 'P_A1_10', amount: 5000, postedAt: '2026-10-06T10:00:00+08:00' }),
        // 11 月才寫入的配置，10 月報表看不到
        allocation({ id: 'AL_2', periodId: 'P_A1_10', amount: 15000, postedAt: '2026-11-01T10:00:00+08:00' }),
      ],
    };
    const row = buildOwnerReport(input, '2026-10', options()).rent[0];
    expect(row.rentDue).toBe(20000);
    expect(row.received).toBe(5000);
  });

  it('補繳上月的錢不算本月已入帳，上月期別補足後不再逾期', () => {
    const input = {
      ...rentFixture(),
      allocations: [
        // 10 月 20 日收到的 20000，配給 9 月期別
        allocation({ id: 'AL_1', periodId: 'P_A1_09', amount: 20000, postedAt: '2026-10-20T10:00:00+08:00' }),
      ],
    };
    const report = buildOwnerReport(input, '2026-10', options());
    expect(report.rent[0].received).toBe(0);
    expect(report.summary.received).toBe(0);
    // 9 月補足，只剩 10 月期別逾期（10-05 加 3 日寬限，月底已逾期）
    expect(report.rent[0].overdue).toBe(20000);
    expect(report.rent[0].overduePeriods.map((p) => p.periodKey)).toEqual(['2026-10']);
  });

  it('逾期是月底累計未足額：上月欠租不會因換月消失', () => {
    const input = {
      ...rentFixture(),
      allocations: [allocation({ id: 'AL_1', periodId: 'P_A1_10', amount: 5000, postedAt: '2026-10-06T10:00:00+08:00' })],
    };
    const report = buildOwnerReport(input, '2026-10', options());
    expect(report.rent[0].overduePeriods).toEqual([
      { periodKey: '2026-09', dueDate: '2026-09-05', outstanding: 20000 },
      { periodKey: '2026-10', dueDate: '2026-10-05', outstanding: 15000 },
    ]);
    expect(report.rent[0].overdue).toBe(35000);
    expect(report.summary.overdue).toBe(35000);
    // 同一份輸入看 9 月：只有 9 月期別逾期
    expect(buildOwnerReport(input, '2026-09', options()).rent[0].overdue).toBe(20000);
  });

  it('寬限最後一天不算逾期，次日才算', () => {
    const input = rentFixture();
    // 10 月期別 10-05 到期，寬限 3 日。看 10 月底必逾期，所以改用 graceDays 拉到剛好卡月底
    const edge = buildOwnerReport(input, '2026-10', options({ graceDays: 26 }));
    expect(edge.rent[0].overduePeriods.map((p) => p.periodKey)).toEqual(['2026-09']);
    const past = buildOwnerReport(input, '2026-10', options({ graceDays: 25 }));
    expect(past.rent[0].overduePeriods.map((p) => p.periodKey)).toEqual(['2026-09', '2026-10']);
  });

  it('已取消的期別不計應收也不逾期', () => {
    const input = rentFixture();
    input.periods = input.periods.map((p) => (p.id === 'P_A1_10' ? { ...p, state: 'cancelled' as const } : p));
    const row = buildOwnerReport(input, '2026-10', options()).rent[0];
    expect(row.rentDue).toBe(0);
    expect(row.overduePeriods.map((p) => p.periodKey)).toEqual(['2026-09']);
  });

  it('失效時間晚於月底的配置，月底當時仍算有效', () => {
    const input = {
      ...rentFixture(),
      allocations: [
        allocation({
          id: 'AL_1',
          periodId: 'P_A1_10',
          amount: 20000,
          active: false,
          postedAt: '2026-10-06T10:00:00+08:00',
          deactivatedAt: '2026-11-03T10:00:00+08:00',
        }),
      ],
    };
    expect(buildOwnerReport(input, '2026-10', options()).rent[0].received).toBe(20000);
    expect(buildOwnerReport(input, '2026-11', options()).rent[0].received).toBe(0);
  });

  it('預收餘額由分錄加總，被沖銷的預收不計', () => {
    const prepaid = receiptJournal({ journalId: 'J_P', caseId: 'C_A1', postedAt: '2026-10-08T10:00:00+08:00', rent: 20000, prepaidRent: 7000 });
    const prepaid2 = receiptJournal({ journalId: 'J_P2', caseId: 'C_A1', postedAt: '2026-10-09T10:00:00+08:00', prepaidRent: 3000 });
    const input = {
      ...rentFixture(),
      journals: [prepaid, prepaid2, reverse(prepaid2, { journalId: 'J_P2_R', postedAt: '2026-10-10T10:00:00+08:00' })],
      receipts: [
        receiptRecord({ journalId: 'J_P', caseId: 'C_A1' }),
        receiptRecord({ journalId: 'J_P2', caseId: 'C_A1' }),
      ],
    };
    const report = buildOwnerReport(input, '2026-10', options());
    expect(report.rent[0].prepaidBalance).toBe(7000);
    expect(report.summary.prepaidBalance).toBe(7000);
  });
});

describe('輸入檢查', () => {
  it('月份格式不對丟 RangeError', () => {
    expect(() => buildOwnerReport(rentFixture(), '2026-13', options())).toThrow(RangeError);
    expect(() => buildOwnerReport(rentFixture(), '2026-1', options())).toThrow(RangeError);
  });
  it('寬限天數不是 0 以上整數丟 RangeError', () => {
    expect(() => buildOwnerReport(rentFixture(), '2026-10', options({ graceDays: -1 }))).toThrow(RangeError);
    expect(() => buildOwnerReport(rentFixture(), '2026-10', options({ graceDays: 1.5 }))).toThrow(RangeError);
  });
  it('期別金額不是安全整數丟 RangeError', () => {
    const input = rentFixture();
    input.periods = [{ ...input.periods[0], amount: 20000.5 }];
    expect(() => buildOwnerReport(input, '2026-10', options())).toThrow(RangeError);
  });
  it('不改動輸入', () => {
    const input = rentFixture();
    const copy = JSON.parse(JSON.stringify(input));
    buildOwnerReport(input, '2026-10', options());
    expect(input).toEqual(copy);
  });
});
