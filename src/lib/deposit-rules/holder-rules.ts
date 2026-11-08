// 押金帳戶規則（ADR-0014 決議 13）。
// 純函式與常數，沒有 I/O。`control.deposit_holder_rules` 的 migration 直接讀 DEPOSIT_HOLDER_RULES。

import { BUSINESS_TYPES, type BusinessType } from '../cases/transitions';
import { DEPOSIT_HOLDER_MESSAGE_KEYS, type DepositHolderMessageKey } from './messages';

// 業務類型沿用案件模組的定義，值是 self_managed、managed、master_lease。
export { BUSINESS_TYPES };
export type { BusinessType };

/** 收款帳戶持有人的種類（ADR-0014 決議 9）。 */
export const HOLDER_KINDS = ['lessor', 'owner', 'manager', 'other'] as const;
export type HolderKind = (typeof HOLDER_KINDS)[number];

export const HOLDER_RULE_ACTIONS = ['allow', 'warn', 'warn_fix_mandate', 'block'] as const;
export type HolderRuleAction = (typeof HOLDER_RULE_ACTIONS)[number];

/**
 * 一列規則。條件欄位為 null 表示不限。
 * 欄位與 `control.deposit_holder_rules` 一一對應（rule_id、version 等）。
 */
export interface DepositHolderRule {
  ruleId: string;
  version: number;
  businessType: BusinessType | null;
  socialHousing: boolean | null;
  holderKind: HolderKind | null;
  mandateIncludesDeposit: boolean | null;
  action: HolderRuleAction;
  notifyMandator: boolean;
}

/** ADR-0014 決議 13 的 5 列。比對時取最具體的命中列，與陣列順序無關。 */
export const DEPOSIT_HOLDER_RULES: readonly DepositHolderRule[] = [
  {
    ruleId: 'DHR-01',
    version: 1,
    businessType: 'managed',
    socialHousing: true,
    holderKind: 'manager',
    mandateIncludesDeposit: null,
    action: 'block',
    notifyMandator: false,
  },
  {
    ruleId: 'DHR-02',
    version: 1,
    businessType: 'managed',
    socialHousing: false,
    holderKind: 'manager',
    mandateIncludesDeposit: true,
    action: 'warn',
    notifyMandator: true,
  },
  {
    ruleId: 'DHR-03',
    version: 1,
    businessType: 'managed',
    socialHousing: false,
    holderKind: 'manager',
    mandateIncludesDeposit: false,
    action: 'warn_fix_mandate',
    notifyMandator: true,
  },
  {
    ruleId: 'DHR-04',
    version: 1,
    businessType: 'master_lease',
    socialHousing: false,
    holderKind: 'lessor',
    mandateIncludesDeposit: null,
    action: 'allow',
    notifyMandator: false,
  },
  {
    ruleId: 'DHR-05',
    version: 1,
    businessType: null,
    socialHousing: null,
    holderKind: null,
    mandateIncludesDeposit: null,
    action: 'allow',
    notifyMandator: false,
  },
];

export interface HolderRuleContext {
  businessType: BusinessType;
  /** 是否為社宅代管案件。 */
  socialHousing: boolean;
  holderKind: HolderKind;
  /** 委託範圍是否含押金。非代管案件沒有委託範圍，傳 false。 */
  mandateIncludesDeposit: boolean;
}

export interface HolderRuleEvaluation {
  action: HolderRuleAction;
  /** 命中的規則 ID。規則缺列或沒有命中時為 null。 */
  ruleId: string | null;
  ruleVersion: number | null;
  notifyMandator: boolean;
  /** 警告或阻擋時的訊息鍵。allow 時為 null。 */
  messageKey: DepositHolderMessageKey | null;
}

const MESSAGE_KEY_BY_ACTION: Record<HolderRuleAction, DepositHolderMessageKey | null> = {
  allow: null,
  warn: DEPOSIT_HOLDER_MESSAGE_KEYS.warnManagerHoldsDeposit,
  warn_fix_mandate: DEPOSIT_HOLDER_MESSAGE_KEYS.warnFixMandate,
  block: DEPOSIT_HOLDER_MESSAGE_KEYS.blockSocialHousingManager,
};

/** 規則缺列或沒有命中時視為 warn，避免設定錯誤時擋住登錄（ADR-0014 決議 13）。 */
const UNMATCHED: HolderRuleEvaluation = {
  action: 'warn',
  ruleId: null,
  ruleVersion: null,
  notifyMandator: true,
  messageKey: DEPOSIT_HOLDER_MESSAGE_KEYS.warnRuleUnmatched,
};

function matches(rule: DepositHolderRule, ctx: HolderRuleContext): boolean {
  return (
    (rule.businessType === null || rule.businessType === ctx.businessType) &&
    (rule.socialHousing === null || rule.socialHousing === ctx.socialHousing) &&
    (rule.holderKind === null || rule.holderKind === ctx.holderKind) &&
    (rule.mandateIncludesDeposit === null || rule.mandateIncludesDeposit === ctx.mandateIncludesDeposit)
  );
}

/** 規則列有幾個條件欄位不是「不限」。數字越大越具體。 */
function specificity(rule: DepositHolderRule): number {
  return [rule.businessType, rule.socialHousing, rule.holderKind, rule.mandateIncludesDeposit].filter(
    (condition) => condition !== null,
  ).length;
}

/** 輸入在執行期不合法（例如從資料庫讀出 null 或未知字串）時，不放行。 */
function isValidContext(ctx: HolderRuleContext): boolean {
  return (
    (BUSINESS_TYPES as readonly string[]).includes(ctx.businessType) &&
    (HOLDER_KINDS as readonly string[]).includes(ctx.holderKind) &&
    typeof ctx.socialHousing === 'boolean' &&
    typeof ctx.mandateIncludesDeposit === 'boolean'
  );
}

/**
 * 找最具體的命中列，同樣具體時取陣列中靠前的。結果與陣列順序無關，
 * 所以「其他組合」的萬用列排在哪裡都不會蓋過具體的列。
 * 輸入不合法、陣列為空或沒有命中時回傳 warn。
 */
export function evaluateHolderRule(
  rules: readonly DepositHolderRule[],
  ctx: HolderRuleContext,
): HolderRuleEvaluation {
  if (!isValidContext(ctx)) return { ...UNMATCHED };
  let rule: DepositHolderRule | undefined;
  for (const candidate of rules) {
    if (matches(candidate, ctx) && (!rule || specificity(candidate) > specificity(rule))) rule = candidate;
  }
  if (!rule) return { ...UNMATCHED };
  return {
    action: rule.action,
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    notifyMandator: rule.notifyMandator,
    messageKey: MESSAGE_KEY_BY_ACTION[rule.action],
  };
}
