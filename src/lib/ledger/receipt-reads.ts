// 入帳確認、配置、預收與押金累計的讀取（MIL-125）。只讀，不寫。
// 查詢靠 RLS 篩選：主辦組織讀得到全部，案件成員只讀得到 migration 0075 開放的關係（lessor）。
// 金額欄位是 bigint，驅動可能回字串，一律轉 text 再轉 number 並檢查安全整數。

import { listPeriods, toMoney } from '../case-ledger/reads';
import type { OrgTx } from '../pg/with-tx';
import { periodStatus, type Allocation, type PeriodStatus } from '../receivables';
import type { PeriodRecord } from '../case-ledger/types';
import type { ReceiptConfirmation, ReceiptPurpose, ReceiptSource } from './receipt-types';

interface ConfirmationRow {
  id: string;
  case_id: string;
  purpose: ReceiptPurpose;
  amount: string;
  value_date: string;
  payment_account_id: string;
  source: ReceiptSource;
  journal_id: string;
  recorded_by_party_id: string | null;
  recorded_at: Date;
  has_evidence: boolean;
  evidence_reuse_of: string | null;
}

const CONFIRMATION_COLUMNS = `c.id, c.case_id, c.purpose, c.amount::text AS amount, to_char(c.value_date, 'YYYY-MM-DD') AS value_date,
  c.payment_account_id, c.source, c.journal_id, c.recorded_by_party_id, c.recorded_at,
  (c.evidence_key IS NOT NULL) AS has_evidence, c.evidence_reuse_of`;

export function toConfirmation(row: ConfirmationRow): ReceiptConfirmation {
  return {
    id: row.id,
    caseId: row.case_id,
    purpose: row.purpose,
    amount: toMoney(row.amount),
    valueDate: row.value_date,
    paymentAccountId: row.payment_account_id,
    source: row.source,
    journalId: row.journal_id,
    recordedByPartyId: row.recorded_by_party_id,
    recordedAt: row.recorded_at.toISOString(),
    hasEvidence: row.has_evidence,
    evidenceReuseOf: row.evidence_reuse_of,
  };
}

/** 依去重鍵找入帳確認。沒有時回 null。 */
export async function findConfirmationByKey(tx: OrgTx, source: ReceiptSource, externalId: string): Promise<ReceiptConfirmation | null> {
  const { rows } = await tx.query<ConfirmationRow>(
    `SELECT ${CONFIRMATION_COLUMNS} FROM org.receipt_confirmations c WHERE c.source = $1 AND c.external_id = $2`,
    [source, externalId],
  );
  return rows[0] ? toConfirmation(rows[0]) : null;
}

/** 案件的有效配置（含失效的），給 receivables 的純函式。 */
export async function listAllocations(tx: OrgTx, caseId: string): Promise<Allocation[]> {
  const { rows } = await tx.query<{ id: string; period_id: string; amount: string; source: 'receipt' | 'prepaid'; source_id: string; active: boolean }>(
    `SELECT id, period_id, amount::text AS amount, source, source_id, active
       FROM org.receipt_allocations WHERE case_id = $1 ORDER BY id`,
    [caseId],
  );
  return rows.map((row) => ({
    id: row.id,
    periodId: row.period_id,
    amount: toMoney(row.amount),
    source: row.source,
    sourceId: row.source_id,
    active: row.active,
    kind: 'rent',
  }));
}

/** 一筆入帳確認配到各期別的有效金額，依期別鍵由舊到新。 */
export async function listConfirmationAllocations(tx: OrgTx, caseId: string, confirmationId: string) {
  const { rows } = await tx.query<{ period_id: string; period_key: string; amount: string }>(
    `SELECT a.period_id, p.period_key, a.amount::text AS amount
       FROM org.receipt_allocations a JOIN org.receivable_periods p ON p.org_id = a.org_id AND p.id = a.period_id
      WHERE a.case_id = $1 AND a.source = 'receipt' AND a.source_id = $2 AND a.active
      ORDER BY p.period_key`,
    [caseId, confirmationId],
  );
  return rows.map((row) => ({ periodId: row.period_id, periodKey: row.period_key, amount: toMoney(row.amount) }));
}

/** 預收租金餘額：`liability.prepaid_rent.{case}` 的貸方減借方。還沒有預收時是 0。 */
export async function getPrepaidBalance(tx: OrgTx, caseId: string): Promise<number> {
  const { rows } = await tx.query<{ balance: string | null }>(
    `SELECT sum(credit - debit)::text AS balance FROM org.ledger_entries WHERE case_id = $1 AND account = 'liability.prepaid_rent.' || $1`,
    [caseId],
  );
  return rows[0]?.balance ? toMoney(rows[0].balance) : 0;
}

/**
 * 押金累計已收：這個案件的押金入帳確認金額合計，扣掉已被沖銷的。
 * 不含扣抵與返還，那是押金餘額（case-ledger 的 getDepositBalance）的事。
 */
export async function getDepositCollected(tx: OrgTx, caseId: string): Promise<number> {
  const { rows } = await tx.query<{ total: string | null }>(
    `SELECT sum(c.amount)::text AS total
       FROM org.receipt_confirmations c
      WHERE c.case_id = $1 AND c.purpose = 'security_deposit'
        AND NOT EXISTS (SELECT 1 FROM org.ledger_journals r WHERE r.org_id = c.org_id AND r.reverses_journal_id = c.journal_id)`,
    [caseId],
  );
  return rows[0]?.total ? toMoney(rows[0].total) : 0;
}

export interface ReceiptListItem extends ReceiptConfirmation {
  accountName: string;
  /** 現金收取。畫面的來源標示：現金收取或使用者登錄。 */
  isCash: boolean;
  /** 登錄者的顯示名稱。讀不到時是 null。 */
  recordedByName: string | null;
  /** 這筆分錄已被沖銷（MIL-126）。 */
  reversed: boolean;
  /** 押金入帳時使用者確認過押金帳戶規則的警告。 */
  holderAcknowledged: boolean;
}

/** 案件的入帳確認，新的在前。 */
export async function listReceipts(tx: OrgTx, caseId: string): Promise<ReceiptListItem[]> {
  const { rows } = await tx.query<
    ConfirmationRow & { account_name: string; account_kind: 'general' | 'cash'; recorded_by_name: string | null; reversed: boolean; holder_acknowledged: boolean }
  >(
    `SELECT ${CONFIRMATION_COLUMNS},
            a.name AS account_name, a.account_kind, p.display_name AS recorded_by_name,
            EXISTS (SELECT 1 FROM org.ledger_journals r WHERE r.org_id = c.org_id AND r.reverses_journal_id = c.journal_id) AS reversed,
            EXISTS (SELECT 1 FROM org.deposit_holder_acknowledgments h WHERE h.org_id = c.org_id AND h.receipt_confirmation_id = c.id) AS holder_acknowledged
       FROM org.receipt_confirmations c
       JOIN org.payment_accounts a ON a.org_id = c.org_id AND a.id = c.payment_account_id
       LEFT JOIN control.parties p ON p.id = c.recorded_by_party_id
      WHERE c.case_id = $1
      ORDER BY c.id DESC`,
    [caseId],
  );
  return rows.map((row) => ({
    ...toConfirmation(row),
    accountName: row.account_name,
    isCash: row.account_kind === 'cash',
    recordedByName: row.recorded_by_name,
    reversed: row.reversed,
    holderAcknowledged: row.holder_acknowledged,
  }));
}

export interface PeriodView extends PeriodRecord {
  /** 取消、未入帳、部分入帳、已入帳。逾期是畫面疊加的顯示狀態，見 `overdue`。 */
  status: PeriodStatus;
  allocated: number;
  /** 尚未足額的差額。已取消與已足額為 0。 */
  outstanding: number;
  /** 每日排程已判定逾期，而且期別仍未足額。足額後顯示已入帳（ADR-0015 決議 11）。 */
  overdue: boolean;
}

/** 應收期別加上由有效配置算出的狀態與差額。 */
export async function listPeriodViews(tx: OrgTx, caseId: string): Promise<PeriodView[]> {
  const [periods, allocations] = await Promise.all([listPeriods(tx, caseId), listAllocations(tx, caseId)]);
  return periods.map((period) => {
    const status = periodStatus(period, allocations);
    const allocated = allocations.filter((a) => a.active && a.periodId === period.id).reduce((sum, a) => sum + a.amount, 0);
    const outstanding = status === 'cancelled' ? 0 : Math.max(0, period.amount - allocated);
    return { ...period, status, allocated, outstanding, overdue: period.overdueAt !== null && (status === 'unpaid' || status === 'partial') };
  });
}
