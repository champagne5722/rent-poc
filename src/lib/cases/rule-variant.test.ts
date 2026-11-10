import { describe, expect, it } from 'vitest';
import { caseRuleVariantOf, isManagerOperated, type CaseRuleVariant } from './rule-variant';

// 資料上的組合（ADR-0030 決議 2）：包租案件是自管租賃，轉租案件的業務類型欄位是舊值 master_lease。
describe('caseRuleVariantOf', () => {
  it.each([
    ['租賃案件（自管）', 'lease', 'self_managed', 'lease_self_managed'],
    ['租賃案件（代管）', 'lease', 'managed', 'lease_managed'],
    ['包租案件', 'master_lease', 'self_managed', 'master_lease'],
    ['轉租案件', 'sublease', 'master_lease', 'sublease'],
    ['委託管理案件', 'management', null, 'management'],
  ] as const)('%s', (_name, caseKind, businessType, expected) => {
    expect(caseRuleVariantOf({ caseKind, businessType })).toBe(expected);
  });

  it('包租、轉租與委託管理案件不看業務類型欄位', () => {
    for (const businessType of ['self_managed', 'managed', 'master_lease', null] as const) {
      expect(caseRuleVariantOf({ caseKind: 'master_lease', businessType })).toBe('master_lease');
      expect(caseRuleVariantOf({ caseKind: 'sublease', businessType })).toBe('sublease');
      expect(caseRuleVariantOf({ caseKind: 'management', businessType })).toBe('management');
    }
  });

  it.each([null, 'master_lease'] as const)('租賃案件的業務類型是 %s 時丟 RangeError，不猜也不放行', (businessType) => {
    expect(() => caseRuleVariantOf({ caseKind: 'lease', businessType })).toThrow(RangeError);
  });

  it('不認得的案件種類丟 RangeError', () => {
    expect(() => caseRuleVariantOf({ caseKind: 'foo' as never, businessType: null })).toThrow(RangeError);
  });
});

describe('isManagerOperated', () => {
  it.each([
    ['lease_self_managed', false],
    ['lease_managed', true],
    ['master_lease', false],
    ['sublease', true],
    ['management', false],
  ] as [CaseRuleVariant, boolean][])('%s → %s', (variant, expected) => {
    expect(isManagerOperated(variant)).toBe(expected);
  });
});
