import { describe, expect, it } from 'vitest';
import { DEPOSIT_HOLDER_RULES, HOLDER_KINDS, evaluateHolderRule, type BusinessType, type HolderKind } from './holder-rules';
import type { StatutoryCaseKind } from '../cases';

// MIL-198：押金帳戶規則從「看業務類型」改成「看案件種類」。規則的內容不變，只換判斷的依據。
// 這份測試保留改名前的 5 列規則與比對方式（凍結副本），逐一比對四種案件在所有組合下的結果。
//
//   租賃案件自管 -> 舊業務類型 self_managed
//   租賃案件代管 -> 舊業務類型 managed
//   包租案件     -> 舊業務類型 self_managed（資料上是自管租賃，沿用自管的規則，待法務確認）
//   轉租案件     -> 舊業務類型 master_lease（舊值，指轉租）

type LegacyBusinessType = 'self_managed' | 'managed' | 'master_lease';

interface LegacyRule {
  ruleId: string;
  businessType: LegacyBusinessType | null;
  socialHousing: boolean | null;
  holderKind: HolderKind | null;
  mandateIncludesDeposit: boolean | null;
  action: string;
  notifyMandator: boolean;
}

const LEGACY_RULES: LegacyRule[] = [
  { ruleId: 'DHR-01', businessType: 'managed', socialHousing: true, holderKind: 'manager', mandateIncludesDeposit: null, action: 'block', notifyMandator: false },
  { ruleId: 'DHR-02', businessType: 'managed', socialHousing: false, holderKind: 'manager', mandateIncludesDeposit: true, action: 'warn', notifyMandator: true },
  { ruleId: 'DHR-03', businessType: 'managed', socialHousing: false, holderKind: 'manager', mandateIncludesDeposit: false, action: 'warn_fix_mandate', notifyMandator: true },
  { ruleId: 'DHR-04', businessType: 'master_lease', socialHousing: false, holderKind: 'lessor', mandateIncludesDeposit: null, action: 'allow', notifyMandator: false },
  { ruleId: 'DHR-05', businessType: null, socialHousing: null, holderKind: null, mandateIncludesDeposit: null, action: 'allow', notifyMandator: false },
];

interface LegacyContext {
  businessType: LegacyBusinessType;
  socialHousing: boolean;
  holderKind: HolderKind;
  mandateIncludesDeposit: boolean;
}

/** 改名前的比對：取條件最多的命中列。 */
function legacyEvaluate(ctx: LegacyContext): LegacyRule {
  const count = (r: LegacyRule) =>
    [r.businessType, r.socialHousing, r.holderKind, r.mandateIncludesDeposit].filter((v) => v !== null).length;
  let hit: LegacyRule | undefined;
  for (const rule of LEGACY_RULES) {
    const matched =
      (rule.businessType === null || rule.businessType === ctx.businessType) &&
      (rule.socialHousing === null || rule.socialHousing === ctx.socialHousing) &&
      (rule.holderKind === null || rule.holderKind === ctx.holderKind) &&
      (rule.mandateIncludesDeposit === null || rule.mandateIncludesDeposit === ctx.mandateIncludesDeposit);
    if (matched && (!hit || count(rule) > count(hit))) hit = rule;
  }
  if (!hit) throw new Error('改名前的規則表沒有命中');
  return hit;
}

const CASES: Array<{
  name: string;
  caseKind: StatutoryCaseKind;
  businessType: BusinessType | null;
  legacy: LegacyBusinessType;
}> = [
  { name: '租賃案件（自管）', caseKind: 'lease', businessType: 'self_managed', legacy: 'self_managed' },
  { name: '租賃案件（代管）', caseKind: 'lease', businessType: 'managed', legacy: 'managed' },
  { name: '包租案件', caseKind: 'master_lease', businessType: 'self_managed', legacy: 'self_managed' },
  { name: '轉租案件', caseKind: 'sublease', businessType: 'master_lease', legacy: 'master_lease' },
];

describe('押金帳戶規則改名前後：每種案件乘每個組合，結果相同', () => {
  for (const c of CASES) {
    const combos = [true, false].flatMap((socialHousing) =>
      HOLDER_KINDS.flatMap((holderKind) =>
        [true, false].map((mandateIncludesDeposit) => [socialHousing, holderKind, mandateIncludesDeposit] as const),
      ),
    );

    it.each(combos)(`${c.name}、社宅 %s、%s、含押金 %s`, (socialHousing, holderKind, mandateIncludesDeposit) => {
      const before = legacyEvaluate({ businessType: c.legacy, socialHousing, holderKind, mandateIncludesDeposit });
      const after = evaluateHolderRule(DEPOSIT_HOLDER_RULES, {
        caseKind: c.caseKind,
        businessType: c.businessType,
        socialHousing,
        holderKind,
        mandateIncludesDeposit,
      });
      expect(after).toMatchObject({
        action: before.action,
        ruleId: before.ruleId,
        ruleVersion: 1,
        notifyMandator: before.notifyMandator,
      });
    });
  }
});
