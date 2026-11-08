import { describe, expect, it } from 'vitest';
import { checkHandoverPreconditions, type HandoverPreconditionFacts } from './preconditions';

const TODAY = '2026-11-08';

const OK_MANDATARY: HandoverPreconditionFacts = {
  hasActiveSigningTask: false,
  target: { kind: 'mandatary', mandate: 'valid', practiceEntityStatus: 'verified' },
  effectiveDate: null,
  today: TODAY,
};

function codes(facts: HandoverPreconditionFacts) {
  return checkHandoverPreconditions(facts).map((reason) => reason.code);
}

describe('checkHandoverPreconditions', () => {
  it('四項條件都符合時沒有原因', () => {
    expect(checkHandoverPreconditions(OK_MANDATARY)).toEqual([]);
  });

  it('有進行中的簽署任務時擋下', () => {
    expect(codes({ ...OK_MANDATARY, hasActiveSigningTask: true })).toEqual(['active_signing_task']);
  });

  it('接收方沒有有效委託時擋下，上傳紙本契約書可以通過', () => {
    const target = { kind: 'mandatary', practiceEntityStatus: 'verified' } as const;
    expect(codes({ ...OK_MANDATARY, target: { ...target, mandate: 'none' } })).toEqual(['no_valid_mandate']);
    expect(codes({ ...OK_MANDATARY, target: { ...target, mandate: 'paper' } })).toEqual([]);
  });

  it.each(['pending', 'lapsed'] as const)('接收方執業主體是 %s 時擋下', (status) => {
    expect(
      codes({ ...OK_MANDATARY, target: { kind: 'mandatary', mandate: 'valid', practiceEntityStatus: status } }),
    ).toEqual(['receiver_not_verified']);
  });

  it('生效日早於今天時擋下，今天與之後可以通過', () => {
    expect(codes({ ...OK_MANDATARY, effectiveDate: '2026-11-07' })).toEqual(['effective_date_in_past']);
    expect(codes({ ...OK_MANDATARY, effectiveDate: TODAY })).toEqual([]);
    expect(codes({ ...OK_MANDATARY, effectiveDate: '2026-12-01' })).toEqual([]);
  });

  it('改自管時免查委託與執業主體，其他條件照查', () => {
    const selfManaged: HandoverPreconditionFacts = {
      hasActiveSigningTask: false,
      target: { kind: 'self_managed' },
      effectiveDate: TODAY,
      today: TODAY,
    };
    expect(checkHandoverPreconditions(selfManaged)).toEqual([]);
    expect(codes({ ...selfManaged, hasActiveSigningTask: true, effectiveDate: '2026-01-01' })).toEqual([
      'active_signing_task',
      'effective_date_in_past',
    ]);
  });

  it('還沒選接收方時只查與接收方無關的條件', () => {
    expect(codes({ ...OK_MANDATARY, target: null, hasActiveSigningTask: true })).toEqual(['active_signing_task']);
  });

  it('同時不符多項時回傳全部原因，每項附給屋主看的說明', () => {
    const reasons = checkHandoverPreconditions({
      hasActiveSigningTask: true,
      target: { kind: 'mandatary', mandate: 'none', practiceEntityStatus: 'lapsed' },
      effectiveDate: '2026-10-01',
      today: TODAY,
    });
    expect(reasons.map((reason) => reason.code)).toEqual([
      'active_signing_task',
      'no_valid_mandate',
      'receiver_not_verified',
      'effective_date_in_past',
    ]);
    for (const reason of reasons) expect(reason.message.length).toBeGreaterThan(0);
  });
});
