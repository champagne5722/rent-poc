import { describe, expect, it } from 'vitest';
import { caseKindLabel, leaseBusinessTypeLabel } from './case-display';

// 案件種類的畫面名稱（MIL-195，ADR-0030）。期望值取自 GLOSSARY：租賃案件、委託管理案件、包租案件、轉租案件。
describe('caseKindLabel：清單與詳情的案件種類', () => {
  it.each([
    ['lease', 'self_managed', '租賃案件（自管）'],
    ['lease', 'managed', '租賃案件（代管）'],
    ['management', null, '委託管理案件'],
    ['master_lease', 'self_managed', '包租案件'],
    // 舊值 master_lease 指轉租，畫面不得再顯示成「包租」
    ['sublease', 'master_lease', '轉租案件'],
  ] as const)('%s、%s → %s', (caseKind, businessType, expected) => {
    expect(caseKindLabel(caseKind, businessType)).toBe(expected);
  });

  it('租賃案件沒有業務類型時只顯示種類', () => {
    expect(caseKindLabel('lease', null)).toBe('租賃案件');
  });
});

describe('leaseBusinessTypeLabel：業務類型只在租賃案件顯示', () => {
  it('租賃案件顯示自管或代管', () => {
    expect(leaseBusinessTypeLabel('lease', 'self_managed')).toBe('自管');
    expect(leaseBusinessTypeLabel('lease', 'managed')).toBe('代管');
  });

  it.each([
    ['management', null],
    ['master_lease', 'self_managed'],
    ['sublease', 'master_lease'],
  ] as const)('%s 不顯示業務類型', (caseKind, businessType) => {
    expect(leaseBusinessTypeLabel(caseKind, businessType)).toBeNull();
  });
});
