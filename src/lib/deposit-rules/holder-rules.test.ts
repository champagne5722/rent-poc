import { describe, expect, it } from 'vitest';
import {
  DEPOSIT_HOLDER_RULES,
  HOLDER_KINDS,
  evaluateHolderRule,
  type BusinessType,
  type HolderKind,
  type HolderRuleAction,
  type HolderRuleContext,
  type StatutoryCaseKind,
} from './holder-rules';

// 規則看案件種類，租賃案件再看業務類型（ADR-0030 決議 2、3，MIL-198）。
// 資料上的組合：包租案件是自管租賃（業務類型 self_managed），轉租案件的業務類型欄位是舊值 master_lease。
interface CaseCombination {
  name: string;
  caseKind: StatutoryCaseKind;
  businessType: BusinessType | null;
}

const LEASE_SELF: CaseCombination = { name: '租賃案件（自管）', caseKind: 'lease', businessType: 'self_managed' };
const LEASE_MANAGED: CaseCombination = { name: '租賃案件（代管）', caseKind: 'lease', businessType: 'managed' };
const MASTER_LEASE: CaseCombination = { name: '包租案件', caseKind: 'master_lease', businessType: 'self_managed' };
const SUBLEASE: CaseCombination = { name: '轉租案件', caseKind: 'sublease', businessType: 'master_lease' };
const CASE_COMBINATIONS = [LEASE_SELF, LEASE_MANAGED, MASTER_LEASE, SUBLEASE];

// ADR-0014 決議 13 的規則表。
describe('evaluateHolderRule：ADR-0014 決議 13 的 5 列', () => {
  it.each([
    ['租賃代管、社宅、manager、含押金', LEASE_MANAGED, true, 'manager', true, 'block', 'DHR-01', false],
    ['租賃代管、社宅、manager、不含押金（不限）', LEASE_MANAGED, true, 'manager', false, 'block', 'DHR-01', false],
    ['租賃代管、一般、manager、含押金', LEASE_MANAGED, false, 'manager', true, 'warn', 'DHR-02', true],
    ['租賃代管、一般、manager、不含押金', LEASE_MANAGED, false, 'manager', false, 'warn_fix_mandate', 'DHR-03', true],
    ['轉租、一般、lessor', SUBLEASE, false, 'lessor', false, 'allow', 'DHR-04', false],
    ['租賃自管、一般、lessor（其他組合）', LEASE_SELF, false, 'lessor', false, 'allow', 'DHR-05', false],
    ['包租、一般、lessor（沿用自管，走其他組合）', MASTER_LEASE, false, 'lessor', false, 'allow', 'DHR-05', false],
  ] as const)(
    '%s → %s',
    (_name, combination, socialHousing, holderKind, mandateIncludesDeposit, action, ruleId, notifyMandator) => {
      const result = evaluateHolderRule(DEPOSIT_HOLDER_RULES, {
        caseKind: combination.caseKind,
        businessType: combination.businessType,
        socialHousing,
        holderKind,
        mandateIncludesDeposit,
      });
      expect(result).toMatchObject({ action, ruleId, ruleVersion: 1, notifyMandator });
    },
  );
});

// 窮舉：4 種案件組合 × 社宅是否 × 4 種 holder_kind × 委託範圍含押金是否 = 64 個組合。
// ADR 的第 5 列「其他組合」是 allow，所以只有租賃代管且持有人是 manager 的 4 個組合不是 allow。
const NON_ALLOW: Record<string, HolderRuleAction> = {
  '租賃案件（代管）|true|manager|true': 'block',
  '租賃案件（代管）|true|manager|false': 'block',
  '租賃案件（代管）|false|manager|true': 'warn',
  '租賃案件（代管）|false|manager|false': 'warn_fix_mandate',
};

const ALL_COMBINATIONS = CASE_COMBINATIONS.flatMap((combination) =>
  [true, false].flatMap((socialHousing) =>
    HOLDER_KINDS.flatMap((holderKind) =>
      [true, false].map(
        (mandateIncludesDeposit) =>
          [combination, socialHousing, holderKind, mandateIncludesDeposit] as [
            CaseCombination,
            boolean,
            HolderKind,
            boolean,
          ],
      ),
    ),
  ),
);

const contextOf = (
  combination: CaseCombination,
  socialHousing: boolean,
  holderKind: HolderKind,
  mandateIncludesDeposit: boolean,
): HolderRuleContext => ({
  caseKind: combination.caseKind,
  businessType: combination.businessType,
  socialHousing,
  holderKind,
  mandateIncludesDeposit,
});

describe('evaluateHolderRule：全部組合', () => {
  it('案件組合四種、holder_kind 四種，組合共 64 個', () => {
    expect([...HOLDER_KINDS]).toEqual(['lessor', 'owner', 'manager', 'other']);
    expect(ALL_COMBINATIONS).toHaveLength(64);
  });

  it.each(ALL_COMBINATIONS)('%o、社宅 %s、%s、含押金 %s', (combination, socialHousing, holderKind, mandate) => {
    const expected = NON_ALLOW[`${combination.name}|${socialHousing}|${holderKind}|${mandate}`] ?? 'allow';
    const result = evaluateHolderRule(DEPOSIT_HOLDER_RULES, contextOf(combination, socialHousing, holderKind, mandate));
    expect(result.action).toBe(expected);
    // 命中的規則：租賃代管 manager 的 4 個組合各有自己的列，轉租 lessor 非社宅是 DHR-04，其餘是 DHR-05。
    const expectedRuleId =
      combination === LEASE_MANAGED && holderKind === 'manager'
        ? socialHousing
          ? 'DHR-01'
          : mandate
            ? 'DHR-02'
            : 'DHR-03'
        : combination === SUBLEASE && holderKind === 'lessor' && !socialHousing
          ? 'DHR-04'
          : 'DHR-05';
    expect(result.ruleId).toBe(expectedRuleId);
  });
});

describe('evaluateHolderRule：缺列與沒有命中', () => {
  const ctx = contextOf(LEASE_SELF, false, 'lessor', false);

  it('規則陣列為空時回傳 warn，rule_id 與版本為 null', () => {
    expect(evaluateHolderRule([], ctx)).toEqual({
      action: 'warn',
      ruleId: null,
      ruleVersion: null,
      notifyMandator: true,
      messageKey: 'deposit_holder.warn.rule_unmatched',
    });
  });

  it('缺少第 5 列（其他組合）時，沒有命中的情境回傳 warn', () => {
    const withoutFallback = DEPOSIT_HOLDER_RULES.filter((rule) => rule.ruleId !== 'DHR-05');
    expect(withoutFallback).toHaveLength(4);
    expect(evaluateHolderRule(withoutFallback, ctx).action).toBe('warn');
  });

  it('缺少具體列時由萬用列接手。表的完整性由下方的常數測試與 migration 保證', () => {
    const rules = DEPOSIT_HOLDER_RULES.filter((rule) => rule.ruleId !== 'DHR-02' && rule.ruleId !== 'DHR-03');
    const result = evaluateHolderRule(rules, contextOf(LEASE_MANAGED, false, 'manager', true));
    expect(result.ruleId).toBe('DHR-05');
  });

  it('結果與陣列順序無關：萬用列排在最前面也不會蓋過具體的列', () => {
    const reversed = [...DEPOSIT_HOLDER_RULES].reverse();
    expect(reversed[0].ruleId).toBe('DHR-05');
    for (const [combination, socialHousing, holderKind, mandate] of ALL_COMBINATIONS) {
      const context = contextOf(combination, socialHousing, holderKind, mandate);
      expect(evaluateHolderRule(reversed, context)).toEqual(evaluateHolderRule(DEPOSIT_HOLDER_RULES, context));
    }
  });

  it.each([
    ['社宅旗標是 null', { socialHousing: null }],
    ['社宅旗標是 undefined', { socialHousing: undefined }],
    ['委託範圍含押金是 undefined', { mandateIncludesDeposit: undefined }],
    ['案件種類是未知字串', { caseKind: 'rental' }],
    ['租賃案件的業務類型是未知字串', { businessType: 'unknown' }],
    ['租賃案件沒有業務類型', { businessType: null }],
    ['holder_kind 是未知字串', { holderKind: 'trustee' }],
  ])('輸入在執行期不合法時回傳 warn，不放行：%s', (_name, patch) => {
    const bad = {
      caseKind: 'lease',
      businessType: 'managed',
      socialHousing: true,
      holderKind: 'manager',
      mandateIncludesDeposit: true,
      ...patch,
    } as unknown as Parameters<typeof evaluateHolderRule>[1];
    expect(evaluateHolderRule(DEPOSIT_HOLDER_RULES, bad)).toMatchObject({
      action: 'warn',
      ruleId: null,
      messageKey: 'deposit_holder.warn.rule_unmatched',
    });
  });

  it('包租與轉租案件不看業務類型欄位：欄位值不同，結果相同', () => {
    for (const businessType of ['self_managed', 'managed', null] as const) {
      expect(
        evaluateHolderRule(DEPOSIT_HOLDER_RULES, { ...contextOf(MASTER_LEASE, false, 'lessor', false), businessType }),
      ).toMatchObject({ action: 'allow', ruleId: 'DHR-05' });
    }
  });
});

describe('DEPOSIT_HOLDER_RULES 常數', () => {
  it('共 5 列，rule_id 不重複，版本都是 1', () => {
    expect(DEPOSIT_HOLDER_RULES).toHaveLength(5);
    expect(new Set(DEPOSIT_HOLDER_RULES.map((rule) => rule.ruleId)).size).toBe(5);
    expect(DEPOSIT_HOLDER_RULES.every((rule) => rule.version === 1)).toBe(true);
  });

  it('萬用列（其他組合）排在最後，條件欄位全為 null', () => {
    const last = DEPOSIT_HOLDER_RULES[DEPOSIT_HOLDER_RULES.length - 1];
    expect(last).toMatchObject({
      caseKind: null,
      businessType: null,
      socialHousing: null,
      holderKind: null,
      mandateIncludesDeposit: null,
      action: 'allow',
      notifyMandator: false,
    });
  });

  it('只有 warn 與 warn_fix_mandate 通知委託人', () => {
    const notifying = DEPOSIT_HOLDER_RULES.filter((rule) => rule.notifyMandator).map((rule) => rule.action);
    expect(notifying.sort()).toEqual(['warn', 'warn_fix_mandate']);
  });
});
