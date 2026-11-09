import type { BusinessType } from '../deposit-rules';
import type { OrgTx } from '../pg/with-tx';
import { getHolderRule } from './holder-rules-store';

// 「列出受影響案件」的查詢函式（MIL-118，ADR-0014 決議 13：修法時既有案件不自動變更，用確認紀錄列出受影響案件）。
// Phase 1 不做畫面，只提供函式。
//
// 現況的替身：案件表在 C 線（MIL-115）、持有人確認紀錄表在 MIL-125，這張票的分支都還沒有。
// 所以以「已完成的合約」代替案件，以「組織有符合持有人種類、啟用中的收款帳戶」代替「案件的押金進了這種持有人」。
// 規則的社宅與委託範圍條件，合約上沒有對應欄位，先忽略，因此結果可能比真正受影響的案件多。
// MIL-125 有持有人確認紀錄後，改成依確認紀錄的 (rule_id, version) 列出。

export interface AffectedCase {
  /** 現階段是合約 ID，案件落地後改成案件 ID。 */
  contractId: string;
  contractType: 'lease' | 'management';
}

export type AffectedCasesResult = { ok: true; cases: AffectedCase[] } | { ok: false; error: 'rule_not_found' };

/** 業務類型對應的合約類型：代管對委託管理合約，自管與包租對租賃合約。 */
function contractTypesFor(businessType: BusinessType | null): ('lease' | 'management')[] {
  if (businessType === null) return ['lease', 'management'];
  return businessType === 'managed' ? ['management'] : ['lease'];
}

export async function listAffectedCases(tx: OrgTx, ruleId: string, version: number): Promise<AffectedCasesResult> {
  const rule = await getHolderRule(tx, ruleId, version);
  if (!rule) return { ok: false, error: 'rule_not_found' };

  const { rows } = await tx.query<{ id: string; contract_type: 'lease' | 'management' }>(
    `SELECT c.id, c.contract_type
       FROM org.contracts c
      WHERE c.status = 'completed'
        AND c.contract_type = ANY($1::text[])
        AND EXISTS (
          SELECT 1 FROM org.payment_accounts a
           WHERE a.deactivated_at IS NULL AND ($2::text IS NULL OR a.holder_kind = $2)
        )
      ORDER BY c.id DESC`,
    [contractTypesFor(rule.businessType), rule.holderKind],
  );
  return { ok: true, cases: rows.map((r) => ({ contractId: r.id, contractType: r.contract_type })) };
}
