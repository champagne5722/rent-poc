import { describe, expect, it } from 'vitest';
import {
  LEGACY_TERMS,
  TERMS,
  partyLabels,
  practitionerTitle,
  statutoryTitle,
  type BusinessType,
  type CertificateKind,
  type LicenseKind,
} from './index';

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

describe('practitionerTitle：執業人員的法定稱謂（GLOSSARY「法定稱謂」）', () => {
  it.each([
    ['rental_housing_manager', '租賃住宅管理人員'],
    ['real_estate_broker', '不動產經紀人'],
    ['real_estate_sales_agent', '不動產經紀營業員'],
  ] as [CertificateKind, string][])('證書種類 %s → %s', (kind, expected) => {
    expect(practitionerTitle(kind)).toBe(expected);
  });
});

describe('TERMS 與 LEGACY_TERMS', () => {
  it('TERMS 的甲乙方與四種合約地位用字', () => {
    expect(TERMS).toEqual({
      partyA: '甲方',
      partyB: '乙方',
      lessor: '出租人',
      lessee: '承租人',
      mandator: '委託人',
      mandatary: '受託人',
    });
  });

  it('LEGACY_TERMS 列出各處禁用的舊用詞（MIL-122 AC7）', () => {
    expect([...LEGACY_TERMS.everywhere]).toEqual(['房東', '租客', '房客', '出租方', '承租方', '業主']);
    expect([...LEGACY_TERMS.contractPdfAndLessee]).toEqual(['經理人']);
  });

  it('「業主」是「執業主體」的子字串，所以執業主體列為豁免詞', () => {
    expect([...LEGACY_TERMS.exemptPhrases]).toEqual(['執業主體']);
  });

  it('對照表輸出的字都不含舊用詞', () => {
    const banned = [...LEGACY_TERMS.everywhere, ...LEGACY_TERMS.contractPdfAndLessee];
    const outputs = [
      ...Object.values(TERMS),
      ...(['lease', 'management'] as const).flatMap((t) => Object.values(partyLabels(t))),
      ...(['management', 'master_lease', 'brokerage'] as const).map((k) => statutoryTitle(k)),
      ...(['rental_housing_manager', 'real_estate_broker', 'real_estate_sales_agent'] as const).map(
        practitionerTitle,
      ),
    ];
    for (const out of outputs) for (const term of banned) expect(out).not.toContain(term);
  });
});
