import { evaluateHolderRule, type HolderKind, type HolderRuleAction } from '../deposit-rules';
import { loadHolderRules } from '../payment-accounts';
import type { BusinessType } from '../cases';
import type { OrgTx } from '../pg/with-tx';
import { getDepositBalance, toMoney } from './reads';

// 押金持有人與押金帳戶規則的衝突（ADR-0050 決議 10，MIL-123）。
// 社宅旗標改為「是」之後，既有的押金分錄不變，畫面列出「押金現在放在哪個持有人的帳戶，規則怎麼看」。
// 只讀鏡像帳與規則表，不寫任何資料。規則文字待法務確認（MIL-62），這裡只回訊息鍵。
//
// 持有人的判定：每筆分錄若同時動到 `liability.deposit.{case}` 與一個收款帳戶 `asset.bank.{id}`，
// 押金負債的增減就記在那個帳戶上。收款記正，返還與沖銷記負。扣抵不經收款帳戶，不計入。
// 所以「收取金額」是 收取 − 返還 − 沖銷，是押金曾經進入該帳戶的淨額，不是押金的現餘額。
// 案件的押金現餘額為 0 時，押金已不在任何人手上，不列衝突。

export interface HolderConflict {
  paymentAccountId: string;
  accountName: string;
  holderKind: HolderKind;
  /** 這個帳戶收取押金的淨額（收取減返還與沖銷），整數元。 */
  collectedAmount: number;
  action: Exclude<HolderRuleAction, 'allow'>;
  ruleId: string | null;
  ruleVersion: number | null;
  /** 警告或阻擋的訊息鍵。文字由介面層提供。 */
  messageKey: string | null;
}

interface CaseFacts {
  business_type: BusinessType | null;
  social_housing: boolean;
}

interface AccountRow {
  payment_account_id: string;
  name: string;
  holder_kind: HolderKind;
  collected: string;
}

/**
 * 列出案件現在押金所在的收款帳戶中，規則不是 allow 的那些。
 * 委託範圍是否含押金，目前沒有資料來源（MIL-116、MIL-119 接線後才有），一律當 false：
 * 一般代管案件由代管業者持有時得 warn_fix_mandate，社宅代管案件不受影響（block 與此條件無關）。
 */
export async function listHolderConflicts(tx: OrgTx, caseId: string): Promise<HolderConflict[]> {
  const facts = await tx.query<CaseFacts>(`SELECT business_type, social_housing FROM org.cases WHERE id = $1 AND kind = 'lease'`, [caseId]);
  const caseFacts = facts.rows[0];
  if (!caseFacts || caseFacts.business_type === null) return [];
  if ((await getDepositBalance(tx, caseId)) <= 0) return [];

  const { rows } = await tx.query<AccountRow>(
    `SELECT a.id AS payment_account_id, a.name, a.holder_kind, per_account.collected::text AS collected
       FROM (
         SELECT substr(bank.account, length('asset.bank.') + 1) AS payment_account_id,
                sum(dep.credit - dep.debit) AS collected
           FROM org.ledger_entries dep
           JOIN org.ledger_entries bank
             ON bank.org_id = dep.org_id AND bank.journal_id = dep.journal_id AND bank.account LIKE 'asset.bank.%'
          WHERE dep.case_id = $1 AND dep.account = 'liability.deposit.' || $1
          GROUP BY 1
       ) per_account
       JOIN org.payment_accounts a ON a.id = per_account.payment_account_id
      WHERE per_account.collected > 0
      ORDER BY a.id`,
    [caseId],
  );

  const rules = await loadHolderRules(tx);
  const conflicts: HolderConflict[] = [];
  for (const row of rows) {
    const evaluation = evaluateHolderRule(rules, {
      businessType: caseFacts.business_type,
      socialHousing: caseFacts.social_housing,
      holderKind: row.holder_kind,
      mandateIncludesDeposit: false,
    });
    if (evaluation.action === 'allow') continue;
    conflicts.push({
      paymentAccountId: row.payment_account_id,
      accountName: row.name,
      holderKind: row.holder_kind,
      collectedAmount: toMoney(row.collected),
      action: evaluation.action,
      ruleId: evaluation.ruleId,
      ruleVersion: evaluation.ruleVersion,
      messageKey: evaluation.messageKey,
    });
  }
  return conflicts;
}
