// 押金帳戶規則的警告訊息鍵（ADR-0014 決議 13、MIL-42 Q3 補充規則 2）。
// 這個模組只放鍵。文字內容待法務確認，由介面層的字串表提供，文字不得寫「合法」或「違法」。

export const DEPOSIT_HOLDER_MESSAGE_KEYS = {
  /** 社宅代管案件不得由代管業者持有押金。 */
  blockSocialHousingManager: 'deposit_holder.block.social_housing_manager',
  /** 一般代管案件由代管業者持有押金，只列公告義務。 */
  warnManagerHoldsDeposit: 'deposit_holder.warn.manager_holds_deposit',
  /** 委託範圍未勾選押金，提示先修委託管理合約，仍不阻擋。 */
  warnFixMandate: 'deposit_holder.warn.fix_mandate',
  /** 規則表缺列或沒有命中。 */
  warnRuleUnmatched: 'deposit_holder.warn.rule_unmatched',
} as const;

export type DepositHolderMessageKey =
  (typeof DEPOSIT_HOLDER_MESSAGE_KEYS)[keyof typeof DEPOSIT_HOLDER_MESSAGE_KEYS];
