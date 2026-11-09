import type { BusinessType } from '../deposit-rules';
import type { OrgTx } from '../pg/with-tx';
import { getHolderRule } from './holder-rules-store';

// 「列出受影響案件」的查詢函式（MIL-118，ADR-0014 決議 13：修法時既有案件不自動變更，列出受影響案件）。
// Phase 1 不做畫面，只提供函式。
//
// 案件落地後（MIL-123）依案件列出：已建立押金台帳的租賃案件（合約已全員完成），且符合規則的條件。
//   - 業務類型、社宅旗標：直接比對案件。條件為 null 表示不限。
//   - 持有人種類：該案件的押金曾經進入這種持有人的收款帳戶（收取淨額大於 0）。條件為 null 表示不限。
//   - 委託範圍是否含押金：案件上沒有這個資料（MIL-116、MIL-119 接線後才有），先忽略，所以結果可能比真正受影響的案件多。
// 只列本組織主辦的案件。MIL-125 有持有人確認紀錄後，改成依確認紀錄的 (rule_id, version) 列出。

export interface AffectedCase {
  caseId: string;
}

export type AffectedCasesResult = { ok: true; cases: AffectedCase[] } | { ok: false; error: 'rule_not_found' };

export async function listAffectedCases(tx: OrgTx, ruleId: string, version: number): Promise<AffectedCasesResult> {
  const rule = await getHolderRule(tx, ruleId, version);
  if (!rule) return { ok: false, error: 'rule_not_found' };

  const businessType: BusinessType | null = rule.businessType;
  const { rows } = await tx.query<{ id: string }>(
    `SELECT c.id
       FROM org.cases c
      WHERE c.kind = 'lease'
        AND c.org_id = current_setting('app.org_id', true)
        AND EXISTS (SELECT 1 FROM org.deposit_ledgers d WHERE d.org_id = c.org_id AND d.case_id = c.id)
        AND ($1::text IS NULL OR c.business_type = $1)
        AND ($2::boolean IS NULL OR c.social_housing = $2)
        AND ($3::text IS NULL OR EXISTS (
              SELECT 1
                FROM org.ledger_entries dep
                JOIN org.ledger_entries bank
                  ON bank.org_id = dep.org_id AND bank.journal_id = dep.journal_id AND bank.account LIKE 'asset.bank.%'
                JOIN org.payment_accounts a
                  ON a.org_id = bank.org_id AND a.id = substr(bank.account, length('asset.bank.') + 1)
               WHERE dep.org_id = c.org_id AND dep.case_id = c.id AND dep.account = 'liability.deposit.' || c.id
                 AND a.holder_kind = $3
               GROUP BY a.id
              HAVING sum(dep.credit - dep.debit) > 0))
      ORDER BY c.id DESC`,
    [businessType, rule.socialHousing, rule.holderKind],
  );
  return { ok: true, cases: rows.map((r) => ({ caseId: r.id })) };
}
