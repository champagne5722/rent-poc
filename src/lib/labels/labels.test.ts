import { describe, expect, it } from 'vitest';
import { partyLabels, statutoryTitle, type BusinessType, type LicenseKind } from './index';

// 標籤對照表（MIL-122、GLOSSARY「角色與合約地位」、PRD 0.2）。
// 預期值一律寫成字面值，來源是 GLOSSARY 與 PRD 的對照表。

describe('partyLabels：甲乙方稱謂依合約類型決定', () => {
  it.each([
    ['lease', '出租人', '承租人', '甲方（出租人）', '乙方（承租人）'],
    ['management', '委託人', '受託人', '甲方（委託人）', '乙方（受託人）'],
  ] as const)('%s 合約：甲方是%s，乙方是%s', (contractType, partyA, partyB, partyAFull, partyBFull) => {
    expect(partyLabels(contractType)).toEqual({ partyA, partyB, partyAFull, partyBFull });
  });
});

describe('statutoryTitle：執業主體的法定稱謂（PRD 0.2）', () => {
  const MANAGEMENT = '租賃住宅代管業者';
  const MASTER_LEASE = '租賃住宅包租業者';
  const BROKERAGE = '不動產經紀業者';

  // 只有一種業別時，案件的業務類型不影響稱謂。
  const single: [LicenseKind, BusinessType | undefined, string][] = [
    ['management', undefined, MANAGEMENT],
    ['management', 'self_managed', MANAGEMENT],
    ['management', 'managed', MANAGEMENT],
    ['management', 'master_lease', MANAGEMENT],
    ['master_lease', undefined, MASTER_LEASE],
    ['master_lease', 'self_managed', MASTER_LEASE],
    ['master_lease', 'managed', MASTER_LEASE],
    ['master_lease', 'master_lease', MASTER_LEASE],
    ['brokerage', undefined, BROKERAGE],
    ['brokerage', 'self_managed', BROKERAGE],
    ['brokerage', 'managed', BROKERAGE],
    ['brokerage', 'master_lease', BROKERAGE],
  ];
  it.each(single)('業別 %s、業務類型 %s → %s', (kind, businessType, expected) => {
    expect(statutoryTitle(kind, businessType)).toBe(expected);
    expect(statutoryTitle([kind], businessType)).toBe(expected);
  });

  // 兼營時依案件的業務類型決定（P0-01 AC5、MIL-116）。
  const combined: [LicenseKind[], BusinessType, string][] = [
    [['management', 'master_lease'], 'master_lease', MASTER_LEASE],
    [['management', 'master_lease'], 'managed', MANAGEMENT],
    [['master_lease', 'management'], 'master_lease', MASTER_LEASE],
    [['management', 'master_lease', 'brokerage'], 'master_lease', MASTER_LEASE],
    [['management', 'master_lease', 'brokerage'], 'managed', MANAGEMENT],
    [['management', 'brokerage'], 'managed', MANAGEMENT],
    [['master_lease', 'brokerage'], 'master_lease', MASTER_LEASE],
  ];
  it.each(combined)('兼營 %j、業務類型 %s → %s', (kinds, businessType, expected) => {
    expect(statutoryTitle(kinds, businessType)).toBe(expected);
  });

  it('包租業者轉租的租賃合約，甲方顯示租賃住宅包租業者（P0-01 AC2）', () => {
    expect(statutoryTitle('master_lease', 'master_lease')).toBe(MASTER_LEASE);
  });

  // 兼營卻無法由業務類型決定時，不猜稱謂。
  const ambiguous: [LicenseKind[], BusinessType | undefined][] = [
    [['management', 'master_lease'], undefined],
    [['management', 'master_lease'], 'self_managed'],
    [['management', 'brokerage'], 'master_lease'],
    [['management', 'brokerage'], undefined],
  ];
  it.each(ambiguous)('兼營 %j、業務類型 %s 無法決定時拋錯', (kinds, businessType) => {
    expect(() => statutoryTitle(kinds, businessType)).toThrow(RangeError);
  });

  it('沒有業別時拋錯', () => {
    expect(() => statutoryTitle([])).toThrow(RangeError);
  });

  it('重複的業別視為一種', () => {
    expect(statutoryTitle(['brokerage', 'brokerage'])).toBe(BROKERAGE);
  });
});
