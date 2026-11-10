import { describe, expect, it } from 'vitest';
import { caseRuleVariantOf, type BusinessType, type CaseRuleVariant, type StatutoryCaseKind } from '../cases';
import { ACTIONS } from './actions';
import { LEGACY_CASE_MATRIX } from './legacy-business-type-matrix.fixture';

// MIL-198：權限矩陣從「以業務類型為鍵」改成「以案件種類為鍵」。規則的內容不變，只換判斷的依據。
// 這份測試拿改名前的凍結副本，逐格比對改名後的矩陣。任何一格的結果變了就是錯。
//
// 案件在資料上的組合與改名前的鍵：
//   租賃案件自管 -> 業務類型 self_managed
//   租賃案件代管 -> 業務類型 managed
//   包租案件     -> 業務類型 self_managed（資料上是自管租賃，沿用自管的規則，待法務確認）
//   轉租案件     -> 業務類型 master_lease（舊值，指轉租）
//   委託管理案件 -> management

type LegacyKey = 'self_managed' | 'managed' | 'master_lease' | 'management';

interface Combination {
  name: string;
  caseKind: StatutoryCaseKind;
  businessType: BusinessType | null;
  legacyKey: LegacyKey;
  variant: CaseRuleVariant;
}

const COMBINATIONS: Combination[] = [
  { name: '租賃案件（自管）', caseKind: 'lease', businessType: 'self_managed', legacyKey: 'self_managed', variant: 'lease_self_managed' },
  { name: '租賃案件（代管）', caseKind: 'lease', businessType: 'managed', legacyKey: 'managed', variant: 'lease_managed' },
  { name: '包租案件', caseKind: 'master_lease', businessType: 'self_managed', legacyKey: 'self_managed', variant: 'master_lease' },
  { name: '轉租案件', caseKind: 'sublease', businessType: 'master_lease', legacyKey: 'master_lease', variant: 'sublease' },
  { name: '委託管理案件', caseKind: 'management', businessType: null, legacyKey: 'management', variant: 'management' },
];

const caseActions = Object.entries(ACTIONS).flatMap(([id, rule]) => (rule.scope === 'case' ? [[id, rule] as const] : []));

describe('權限矩陣改名前後：案件種類推出的規則分類', () => {
  it.each(COMBINATIONS)('$name 推出 $variant', ({ caseKind, businessType, variant }) => {
    expect(caseRuleVariantOf({ caseKind, businessType })).toBe(variant);
  });

  it('改名前的案件層動作與現在的案件層動作一一對應', () => {
    expect(caseActions.map(([id]) => id).sort()).toEqual(Object.keys(LEGACY_CASE_MATRIX).sort());
  });
});

describe('權限矩陣改名前後：每個案件層動作乘每種案件，結果相同', () => {
  const rows = caseActions.flatMap(([id, rule]) => COMBINATIONS.map((c) => [id, c.name, rule, c] as const));

  it.each(rows)('%s × %s', (id, _name, rule, c) => {
    const legacy = LEGACY_CASE_MATRIX[id];
    expect(rule.effect).toBe(legacy.effect);
    expect([...rule.states]).toEqual(legacy.states);
    expect(rule.onBehalfScope).toBe(legacy.onBehalfScope);
    expect((rule as { uncased?: string }).uncased ?? null).toBe(legacy.uncased);

    const hostRoles = rule.hostRoles as Partial<Record<CaseRuleVariant, readonly string[]>>;
    const relations = rule.relations as Partial<Record<CaseRuleVariant, readonly string[]>>;
    expect(hostRoles[c.variant]?.slice()).toEqual(legacy.hostRoles[c.legacyKey]);
    expect(relations[c.variant]?.slice()).toEqual(legacy.relations[c.legacyKey]);
  });

  it('新矩陣沒有多出改名前沒有的格子：每個鍵都對得到一種案件', () => {
    const variants = new Set<string>(COMBINATIONS.map((c) => c.variant));
    for (const [, rule] of caseActions) {
      for (const key of [...Object.keys(rule.hostRoles), ...Object.keys(rule.relations)]) {
        expect(variants.has(key), key).toBe(true);
      }
    }
  });

  it('包租案件與租賃自管案件的每一格都相同（沿用自管的規則，待法務確認）', () => {
    for (const [, rule] of caseActions) {
      const hostRoles = rule.hostRoles as Partial<Record<CaseRuleVariant, readonly string[]>>;
      const relations = rule.relations as Partial<Record<CaseRuleVariant, readonly string[]>>;
      expect(hostRoles.master_lease).toEqual(hostRoles.lease_self_managed);
      expect(relations.master_lease).toEqual(relations.lease_self_managed);
    }
  });
});
