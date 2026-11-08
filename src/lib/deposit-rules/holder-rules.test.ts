import { describe, expect, it } from 'vitest';
import {
  BUSINESS_TYPES,
  DEPOSIT_HOLDER_RULES,
  HOLDER_KINDS,
  evaluateHolderRule,
  type BusinessType,
  type HolderKind,
  type HolderRuleAction,
} from './holder-rules';

// ADR-0014 決議 13 的規則表。
describe('evaluateHolderRule：ADR-0014 決議 13 的 5 列', () => {
  it.each([
    ['代管、社宅、manager、含押金', 'managed', true, 'manager', true, 'block', 'DHR-01', false],
    ['代管、社宅、manager、不含押金（不限）', 'managed', true, 'manager', false, 'block', 'DHR-01', false],
    ['代管、一般、manager、含押金', 'managed', false, 'manager', true, 'warn', 'DHR-02', true],
    ['代管、一般、manager、不含押金', 'managed', false, 'manager', false, 'warn_fix_mandate', 'DHR-03', true],
    ['包租、一般、lessor', 'master_lease', false, 'lessor', false, 'allow', 'DHR-04', false],
    ['自管、一般、lessor（其他組合）', 'self_managed', false, 'lessor', false, 'allow', 'DHR-05', false],
  ] as const)(
    '%s → %s',
    (_name, businessType, socialHousing, holderKind, mandateIncludesDeposit, action, ruleId, notifyMandator) => {
      const result = evaluateHolderRule(DEPOSIT_HOLDER_RULES, {
        businessType,
        socialHousing,
        holderKind,
        mandateIncludesDeposit,
      });
      expect(result).toMatchObject({ action, ruleId, ruleVersion: 1, notifyMandator });
    },
  );
});

// 窮舉：3 種業務類型 × 社宅是否 × 4 種 holder_kind × 委託範圍含押金是否 = 48 個組合。
// ADR 的第 5 列「其他組合」是 allow，所以只有代管且持有人是 manager 的 4 個組合不是 allow。
const NON_ALLOW: Record<string, HolderRuleAction> = {
  'managed|true|manager|true': 'block',
  'managed|true|manager|false': 'block',
  'managed|false|manager|true': 'warn',
  'managed|false|manager|false': 'warn_fix_mandate',
};

const ALL_COMBINATIONS = BUSINESS_TYPES.flatMap((businessType) =>
  [true, false].flatMap((socialHousing) =>
    HOLDER_KINDS.flatMap((holderKind) =>
      [true, false].map(
        (mandateIncludesDeposit) =>
          [businessType, socialHousing, holderKind, mandateIncludesDeposit] as [
            BusinessType,
            boolean,
            HolderKind,
            boolean,
          ],
      ),
    ),
  ),
);

describe('evaluateHolderRule：全部組合', () => {
  it('業務類型三種、holder_kind 四種，組合共 48 個', () => {
    expect([...BUSINESS_TYPES]).toEqual(['self_managed', 'managed', 'master_lease']);
    expect([...HOLDER_KINDS]).toEqual(['lessor', 'owner', 'manager', 'other']);
    expect(ALL_COMBINATIONS).toHaveLength(48);
  });

  it.each(ALL_COMBINATIONS)('%s、社宅 %s、%s、含押金 %s', (businessType, socialHousing, holderKind, mandate) => {
    const expected = NON_ALLOW[`${businessType}|${socialHousing}|${holderKind}|${mandate}`] ?? 'allow';
    const result = evaluateHolderRule(DEPOSIT_HOLDER_RULES, {
      businessType,
      socialHousing,
      holderKind,
      mandateIncludesDeposit: mandate,
    });
    expect(result.action).toBe(expected);
    // 命中的規則：代管 manager 的 4 個組合各有自己的列，包租 lessor 非社宅是 DHR-04，其餘是 DHR-05。
    const expectedRuleId =
      businessType === 'managed' && holderKind === 'manager'
        ? socialHousing
          ? 'DHR-01'
          : mandate
            ? 'DHR-02'
            : 'DHR-03'
        : businessType === 'master_lease' && holderKind === 'lessor' && !socialHousing
          ? 'DHR-04'
          : 'DHR-05';
    expect(result.ruleId).toBe(expectedRuleId);
  });
});

describe('evaluateHolderRule：缺列與沒有命中', () => {
  const ctx = {
    businessType: 'self_managed',
    socialHousing: false,
    holderKind: 'lessor',
    mandateIncludesDeposit: false,
  } as const;

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
    const result = evaluateHolderRule(rules, {
      businessType: 'managed',
      socialHousing: false,
      holderKind: 'manager',
      mandateIncludesDeposit: true,
    });
    expect(result.ruleId).toBe('DHR-05');
  });

  it('結果與陣列順序無關：萬用列排在最前面也不會蓋過具體的列', () => {
    const reversed = [...DEPOSIT_HOLDER_RULES].reverse();
    expect(reversed[0].ruleId).toBe('DHR-05');
    for (const [businessType, socialHousing, holderKind, mandate] of ALL_COMBINATIONS) {
      const ctx = { businessType, socialHousing, holderKind, mandateIncludesDeposit: mandate };
      expect(evaluateHolderRule(reversed, ctx)).toEqual(evaluateHolderRule(DEPOSIT_HOLDER_RULES, ctx));
    }
  });

  it.each([
    ['社宅旗標是 null', { socialHousing: null }],
    ['社宅旗標是 undefined', { socialHousing: undefined }],
    ['委託範圍含押金是 undefined', { mandateIncludesDeposit: undefined }],
    ['業務類型是未知字串', { businessType: 'sublease' }],
    ['holder_kind 是未知字串', { holderKind: 'trustee' }],
  ])('輸入在執行期不合法時回傳 warn，不放行：%s', (_name, patch) => {
    const bad = {
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
