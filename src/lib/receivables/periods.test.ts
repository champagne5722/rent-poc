import { describe, expect, it } from 'vitest';
import { cancelPeriodsAfter, splitPeriods } from './periods';
import type { PeriodContract, ReceivablePeriod } from './types';

function contract(over: Partial<PeriodContract>): PeriodContract {
  return { startDate: '2026-01-01', endDate: '2026-12-31', paymentDay: 5, monthlyRent: 20000, ...over };
}

// 摘要：[期別鍵, 期別起, 期別迄, 到期日, 金額]
function summary(c: PeriodContract) {
  return splitPeriods(c).map((p) => [p.periodKey, p.periodStart, p.periodEnd, p.dueDate, p.amount]);
}

describe('splitPeriods（一個月一期，到期日是該月付款日）', () => {
  it('整年整月：12 期，每期整月月租，到期日是每月 5 號', () => {
    const periods = splitPeriods(contract({}));
    expect(periods).toHaveLength(12);
    expect(periods.map((p) => p.dueDate)).toEqual([
      '2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05',
      '2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05', '2026-11-05', '2026-12-05',
    ]);
    expect(periods.every((p) => p.amount === 20000 && p.kind === 'rent')).toBe(true);
  });

  describe('付款日 31 號遇到沒有那天的月份，取月底', () => {
    it.each([
      ['小月 30 天', '2026-04-01', '2026-04-30', '2026-04-30'],
      ['平年 2 月', '2026-02-01', '2026-02-28', '2026-02-28'],
      ['閏年 2 月', '2028-02-01', '2028-02-29', '2028-02-29'],
      ['2100 年不是閏年', '2100-02-01', '2100-02-28', '2100-02-28'],
      ['2000 年是閏年', '2000-02-01', '2000-02-29', '2000-02-29'],
      ['大月 31 天', '2026-01-01', '2026-01-31', '2026-01-31'],
    ])('%s', (_name, start, end, due) => {
      const [p] = splitPeriods(contract({ startDate: start, endDate: end, paymentDay: 31 }));
      expect(p.dueDate).toBe(due);
      expect(p.amount).toBe(20000);
    });

    it('付款日 30 號遇到平年 2 月取 28 日，閏年取 29 日', () => {
      const due = (start: string, end: string) =>
        splitPeriods(contract({ startDate: start, endDate: end, paymentDay: 30 }))[0].dueDate;
      expect(due('2027-02-01', '2027-02-28')).toBe('2027-02-28');
      expect(due('2028-02-01', '2028-02-29')).toBe('2028-02-29');
    });
  });

  it('跨年：2026-11-01 到 2027-02-28，付款日 10 號', () => {
    expect(summary(contract({ startDate: '2026-11-01', endDate: '2027-02-28', paymentDay: 10 }))).toEqual([
      ['2026-11', '2026-11-01', '2026-11-30', '2026-11-10', 20000],
      ['2026-12', '2026-12-01', '2026-12-31', '2026-12-10', 20000],
      ['2027-01', '2027-01-01', '2027-01-31', '2027-01-10', 20000],
      ['2027-02', '2027-02-01', '2027-02-28', '2027-02-10', 20000],
    ]);
  });

  it('首期不足一個月：1 月 16 日起，16 天除以 31 天', () => {
    expect(
      summary(contract({ startDate: '2026-01-16', endDate: '2026-03-31', paymentDay: 20, monthlyRent: 31000 })),
    ).toEqual([
      ['2026-01', '2026-01-16', '2026-01-31', '2026-01-20', 16000],
      ['2026-02', '2026-02-01', '2026-02-28', '2026-02-20', 31000],
      ['2026-03', '2026-03-01', '2026-03-31', '2026-03-20', 31000],
    ]);
  });

  it('末期不足一個月：2 月 14 日止，14 天除以 28 天', () => {
    expect(
      summary(contract({ startDate: '2026-01-01', endDate: '2026-02-14', paymentDay: 5, monthlyRent: 28000 })),
    ).toEqual([
      ['2026-01', '2026-01-01', '2026-01-31', '2026-01-05', 28000],
      ['2026-02', '2026-02-01', '2026-02-14', '2026-02-05', 14000],
    ]);
  });

  it('首末期都不足：常見的 15 日起租到次年 14 日', () => {
    const periods = splitPeriods(
      contract({ startDate: '2026-01-15', endDate: '2027-01-14', paymentDay: 15, monthlyRent: 31000 }),
    );
    expect(periods).toHaveLength(13);
    expect(periods[0]).toMatchObject({ periodKey: '2026-01', periodStart: '2026-01-15', amount: 17000 });
    expect(periods[12]).toMatchObject({ periodKey: '2027-01', periodEnd: '2027-01-14', amount: 14000 });
    // 首尾兩期合計正好一個月租金
    expect(periods[0].amount + periods[12].amount).toBe(31000);
  });

  describe('起訖同月', () => {
    it('租期只有月內一段：11 天除以 31 天', () => {
      expect(
        summary(contract({ startDate: '2026-03-10', endDate: '2026-03-20', paymentDay: 5, monthlyRent: 31000 })),
      ).toEqual([['2026-03', '2026-03-10', '2026-03-20', '2026-03-10', 11000]]);
    });
    it('起訖正好是整個月：金額就是月租', () => {
      expect(
        summary(contract({ startDate: '2026-02-01', endDate: '2026-02-28', paymentDay: 31 })),
      ).toEqual([['2026-02', '2026-02-01', '2026-02-28', '2026-02-28', 20000]]);
    });
    it('起訖同一天：一天的比例', () => {
      const [p] = splitPeriods(contract({ startDate: '2026-04-10', endDate: '2026-04-10', monthlyRent: 30000 }));
      expect(p.amount).toBe(1000);
    });
  });

  describe('首期到期日取付款日與期別起日較晚者', () => {
    it('付款日早於起租日：首期到期日是起租日，後續期別不受影響', () => {
      const periods = splitPeriods(contract({ startDate: '2026-11-20', endDate: '2027-01-31', paymentDay: 5 }));
      expect(periods.map((p) => p.dueDate)).toEqual(['2026-11-20', '2026-12-05', '2027-01-05']);
    });
    it('付款日晚於起租日：維持付款日', () => {
      const [p] = splitPeriods(contract({ startDate: '2026-11-03', endDate: '2026-11-30', paymentDay: 5 }));
      expect(p.dueDate).toBe('2026-11-05');
    });
    it('付款日恰好是起租日：同一天', () => {
      const [p] = splitPeriods(contract({ startDate: '2026-11-05', endDate: '2026-11-30', paymentDay: 5 }));
      expect(p.dueDate).toBe('2026-11-05');
    });
  });

  describe('四捨五入到元（半數進位）', () => {
    it.each([
      ['3333.33 → 3333', 10000, '2026-04-21', '2026-04-30', 3333],
      ['6666.67 → 6667', 10000, '2026-04-11', '2026-04-30', 6667],
      ['剛好 0.5 → 1', 1, '2026-04-16', '2026-04-30', 1],
      ['剛好 1.5 → 2', 3, '2026-04-16', '2026-04-30', 2],
      ['剛好 0.5 以下 → 0', 1, '2026-04-17', '2026-04-30', 0],
    ])('%s', (_name, rent, start, end, expected) => {
      const [p] = splitPeriods(contract({ startDate: start, endDate: end, monthlyRent: rent }));
      expect(p.amount).toBe(expected);
    });
  });

  it('金額一律是安全整數', () => {
    for (const p of splitPeriods(contract({ startDate: '2026-01-07', endDate: '2027-03-19', monthlyRent: 17777 }))) {
      expect(Number.isSafeInteger(p.amount)).toBe(true);
    }
  });

  describe('不合法的輸入丟 RangeError', () => {
    it.each([
      ['迄日早於起日', { startDate: '2026-03-02', endDate: '2026-03-01' }],
      ['付款日 0', { paymentDay: 0 }],
      ['付款日 32', { paymentDay: 32 }],
      ['付款日不是整數', { paymentDay: 5.5 }],
      ['月租有小數', { monthlyRent: 100.5 }],
      ['月租為負', { monthlyRent: -1 }],
      ['不存在的日期', { startDate: '2026-02-30' }],
      ['日期格式錯', { endDate: '2026/12/31' }],
    ])('%s', (_name, over) => {
      expect(() => splitPeriods(contract(over))).toThrow(RangeError);
    });
  });
});

function period(over: Partial<ReceivablePeriod> & Pick<ReceivablePeriod, 'id' | 'periodKey'>): ReceivablePeriod {
  const [y, m] = over.periodKey.split('-');
  return {
    periodStart: `${y}-${m}-01`,
    periodEnd: `${y}-${m}-28`,
    dueDate: `${y}-${m}-05`,
    amount: 20000,
    kind: 'rent',
    state: 'active',
    ...over,
  };
}

describe('cancelPeriodsAfter（終止日之後的期別改 cancelled）', () => {
  const periods = ['2026-01', '2026-02', '2026-03', '2026-04'].map((k, i) => period({ id: `p${i + 1}`, periodKey: k }));

  it('終止日在 2 月中：3、4 月改 cancelled，終止日所在的 2 月不調整', () => {
    const result = cancelPeriodsAfter(periods, '2026-02-15');
    expect(result.map((p) => p.state)).toEqual(['active', 'active', 'cancelled', 'cancelled']);
    expect(result[1]).toEqual(periods[1]);
  });

  it('終止日剛好是某月第一天：該月仍是終止日所在期別，不取消', () => {
    const result = cancelPeriodsAfter(periods, '2026-03-01');
    expect(result.map((p) => p.state)).toEqual(['active', 'active', 'active', 'cancelled']);
  });

  it('終止日剛好是某月最後一天：下個月才取消', () => {
    const result = cancelPeriodsAfter(periods, '2026-02-28');
    expect(result.map((p) => p.state)).toEqual(['active', 'active', 'cancelled', 'cancelled']);
  });

  it('終止日晚於所有期別：沒有變動', () => {
    expect(cancelPeriodsAfter(periods, '2026-12-31')).toEqual(periods);
  });

  it('終止日早於所有期別：全部取消', () => {
    expect(cancelPeriodsAfter(periods, '2025-12-31').every((p) => p.state === 'cancelled')).toBe(true);
  });

  it('不改動輸入、已取消的維持取消、可重複執行', () => {
    const snapshot = structuredClone(periods);
    const once = cancelPeriodsAfter(periods, '2026-02-15');
    expect(periods).toEqual(snapshot);
    expect(cancelPeriodsAfter(once, '2026-02-15')).toEqual(once);
  });

  it('終止日格式錯誤時丟 RangeError', () => {
    expect(() => cancelPeriodsAfter(periods, '2026-2-15')).toThrow(RangeError);
  });
});
