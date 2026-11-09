import type { OrgTx } from '../pg/with-tx';
import type { DepositLedger, DepositLedgerStatus, PeriodRecord } from './types';

// 押金台帳、押金餘額與應收期別的讀取（MIL-123）。查詢靠 RLS 篩選：主辦組織讀得到全部，
// 案件成員只讀得到 migration 0055、0056 開放的關係（見 src/lib/pg/rls-cases/ledger.ts）。
// 金額欄位是 bigint，驅動可能回字串，一律轉 text 再轉 number 並檢查安全整數。

export function toMoney(value: string | number | bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`金額超出安全整數範圍：${String(value)}`);
  return n;
}

interface LedgerRow {
  id: string;
  case_id: string;
  expected_amount: string;
  status: DepositLedgerStatus;
  created_at: Date;
}

/** 案件的押金台帳。案件還沒全員完成、或看不到這個案件時回 null。 */
export async function getDepositLedger(tx: OrgTx, caseId: string): Promise<DepositLedger | null> {
  const { rows } = await tx.query<LedgerRow>(
    `SELECT id, case_id, expected_amount::text AS expected_amount, status, created_at
       FROM org.deposit_ledgers WHERE case_id = $1`,
    [caseId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    expectedAmount: toMoney(row.expected_amount),
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * 案件的押金餘額：`liability.deposit.{case}` 的貸方減借方，由 view org.deposit_balances 加總（ADR-0015 決議 6）。
 * 還沒有任何押金分錄時是 0。view 是 security_invoker，所以呼叫者讀不到的分錄不計入。
 */
export async function getDepositBalance(tx: OrgTx, caseId: string): Promise<number> {
  const { rows } = await tx.query<{ balance: string }>(
    `SELECT balance::text AS balance FROM org.deposit_balances WHERE case_id = $1`,
    [caseId],
  );
  return rows[0] ? toMoney(rows[0].balance) : 0;
}

interface PeriodRow {
  id: string;
  case_id: string;
  period_key: string;
  period_start: string;
  period_end: string;
  due_date: string;
  amount: string;
  state: PeriodRecord['state'];
  overdue_at: Date | null;
}

/** 案件的全部應收期別，依期別鍵由舊到新。 */
export async function listPeriods(tx: OrgTx, caseId: string): Promise<PeriodRecord[]> {
  const { rows } = await tx.query<PeriodRow>(
    `SELECT id, case_id, period_key, to_char(period_start, 'YYYY-MM-DD') AS period_start,
            to_char(period_end, 'YYYY-MM-DD') AS period_end, to_char(due_date, 'YYYY-MM-DD') AS due_date,
            amount::text AS amount, state, overdue_at
       FROM org.receivable_periods WHERE case_id = $1 ORDER BY period_key`,
    [caseId],
  );
  return rows.map((row) => ({
    id: row.id,
    caseId: row.case_id,
    periodKey: row.period_key,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    dueDate: row.due_date,
    amount: toMoney(row.amount),
    kind: 'rent',
    state: row.state,
    overdueAt: row.overdue_at ? row.overdue_at.toISOString() : null,
  }));
}
