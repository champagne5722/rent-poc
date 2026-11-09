import { appendAudit } from '../audit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { cancelPeriodsAfter, splitPeriods, type PeriodDraft } from '../receivables';
import { listPeriods } from './reads';
import type { LeaseTerms } from './types';

export type { LeaseTerms } from './types';

// 合約全員完成時，建立押金台帳與全部應收期別（ADR-0050 決議 4、5，ADR-0015 決議 11，MIL-123）。
//
// 介面的規則：
// - tx 是呼叫端的組織交易。台帳、期別與稽核事件和完成事件同一個交易提交或回滾，函式不開交易。
// - 呼叫端先確認這是租賃案件、合約全員完成。權限由呼叫端負責，完成事件來自簽署模組，沒有使用者可以 authorize。
// - 同一個案件只建一次。台帳已存在時什麼都不寫，回傳 already_open，所以重送完成事件是安全的。
// - 合約欄位不足以切期別（沒有付款日、沒有月租、日期不合法）時，押金台帳照建，期別跳過並回報原因，不丟錯。
//   完成事件是法律事實，不能因為帳務欄位缺漏而回滾（ADR-0016 決議 11）。跳過的案件由人工補期別，屬後續處理。
// - 約定金額取合約欄位的押金。沒填或不合法時記 0。

export type OpenCaseLedgerResult =
  | {
      opened: true;
      ledgerId: string;
      periodCount: number;
      /** 期別沒有建立的原因。期別正常建立時是 null。 */
      periodsSkipped: string | null;
    }
  | { opened: false; reason: 'already_open' };

function expectedAmountOf(deposit: number | null): number {
  return deposit !== null && Number.isSafeInteger(deposit) && deposit >= 0 ? deposit : 0;
}

/** 切期別。欄位不足或不合法時回傳原因，不丟錯。 */
function draftPeriods(terms: LeaseTerms): { drafts: PeriodDraft[]; skipped: null } | { drafts: []; skipped: string } {
  const { payDay, rent } = terms;
  if (payDay === null || rent === null) {
    return { drafts: [], skipped: `合約缺少${payDay === null ? '每月付款日' : '月租'}，無法切分應收期別` };
  }
  try {
    return { drafts: splitPeriods({ startDate: terms.startDate, endDate: terms.endDate, paymentDay: payDay, monthlyRent: rent }), skipped: null };
  } catch (error) {
    if (error instanceof RangeError) return { drafts: [], skipped: `合約欄位不合法，無法切分應收期別：${error.message}` };
    throw error;
  }
}

export async function openCaseLedger(tx: OrgTx, caseId: string, terms: LeaseTerms): Promise<OpenCaseLedgerResult> {
  const ledgerId = newUlid();
  // ON CONFLICT 讓重送完成事件冪等：(org_id, case_id) 唯一鍵擋下第二份台帳。案件不存在時外鍵丟錯
  const inserted = await tx.query(
    `INSERT INTO org.deposit_ledgers (id, org_id, case_id, expected_amount)
     VALUES ($1, current_setting('app.org_id', true), $2, $3)
     ON CONFLICT (org_id, case_id) DO NOTHING RETURNING id`,
    [ledgerId, caseId, expectedAmountOf(terms.deposit)],
  );
  if (inserted.rows.length === 0) return { opened: false, reason: 'already_open' };

  const { drafts, skipped } = draftPeriods(terms);
  for (const draft of drafts) {
    await tx.query(
      `INSERT INTO org.receivable_periods (id, org_id, case_id, period_key, period_start, period_end, due_date, amount)
       VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6, $7)`,
      [newUlid(), caseId, draft.periodKey, draft.periodStart, draft.periodEnd, draft.dueDate, draft.amount],
    );
  }
  // payload 只放 ID 與數量，不放金額與租期：canonical 寫入後刪不掉（ADR-0019 決議 5）
  await appendAudit(tx, {
    action: 'case_ledger.open',
    object: { type: 'case', id: caseId },
    payload: { deposit_ledger_id: ledgerId, period_count: drafts.length, periods_skipped: skipped !== null },
  });
  return { opened: true, ledgerId, periodCount: drafts.length, periodsSkipped: skipped };
}

/**
 * 合約提前終止：終止日之後才開始的期別改 cancelled，回傳被取消的期別鍵。
 * 終止日所在的期別不調整金額，也不取消（ADR-0050 決議 5）。已取消的期別不重複處理。
 * 終止日格式不對時丟 RangeError。權限與終止的業務判斷由呼叫端負責。
 */
export async function cancelPeriodsAfterTermination(tx: OrgTx, caseId: string, terminationDate: string): Promise<string[]> {
  const periods = await listPeriods(tx, caseId);
  const after = cancelPeriodsAfter(periods, terminationDate);
  const toCancel = after.filter((p, i) => p.state === 'cancelled' && periods[i].state === 'active');
  for (const period of toCancel) {
    await tx.query(`UPDATE org.receivable_periods SET state = 'cancelled' WHERE id = $1 AND state = 'active'`, [period.id]);
  }
  if (toCancel.length > 0) {
    await appendAudit(tx, {
      action: 'case_ledger.cancel_periods',
      object: { type: 'case', id: caseId },
      payload: { cancelled_count: toCancel.length },
    });
  }
  return toCancel.map((p) => p.periodKey);
}
