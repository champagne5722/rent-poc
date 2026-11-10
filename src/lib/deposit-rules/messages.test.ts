import { describe, expect, it } from 'vitest';
import { DEPOSIT_HOLDER_RULES, evaluateHolderRule } from './holder-rules';
import { DEPOSIT_HOLDER_MESSAGE_KEYS } from './messages';

describe('押金帳戶規則的訊息鍵', () => {
  it('四個鍵的值固定（介面層的字串表以這些鍵查文字）', () => {
    expect(DEPOSIT_HOLDER_MESSAGE_KEYS).toEqual({
      blockSocialHousingManager: 'deposit_holder.block.social_housing_manager',
      warnManagerHoldsDeposit: 'deposit_holder.warn.manager_holds_deposit',
      warnFixMandate: 'deposit_holder.warn.fix_mandate',
      warnRuleUnmatched: 'deposit_holder.warn.rule_unmatched',
    });
  });

  it.each(Object.entries(DEPOSIT_HOLDER_MESSAGE_KEYS))('%s 的鍵不含「合法」「違法」', (_name, key) => {
    expect(key).not.toContain('合法');
    expect(key).not.toContain('違法');
  });

  it('每個鍵都是 deposit_holder. 開頭的小寫英文與底線', () => {
    for (const key of Object.values(DEPOSIT_HOLDER_MESSAGE_KEYS)) {
      expect(key).toMatch(/^deposit_holder\.(block|warn)\.[a-z_]+$/);
    }
  });

  it.each([
    ['managed', true, 'manager', true, 'deposit_holder.block.social_housing_manager'],
    ['managed', false, 'manager', true, 'deposit_holder.warn.manager_holds_deposit'],
    ['managed', false, 'manager', false, 'deposit_holder.warn.fix_mandate'],
    ['self_managed', false, 'lessor', false, null],
  ] as const)('評估結果帶對應的訊息鍵：租賃案件 %s、社宅 %s、%s、含押金 %s → %s', (businessType, socialHousing, holderKind, mandate, key) => {
    const result = evaluateHolderRule(DEPOSIT_HOLDER_RULES, {
      caseKind: 'lease',
      businessType,
      socialHousing,
      holderKind,
      mandateIncludesDeposit: mandate,
    });
    expect(result.messageKey).toBe(key);
  });
});
