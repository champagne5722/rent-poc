// confirmReceipt()：入帳確認的唯一入口（ADR-0014 決議 4、15，ADR-0050 決議 3，MIL-125）。
//
// 所有來源（人工、對帳檔、推送）都轉成 ReceiptCandidate 再呼叫這裡。Phase 1 只有 manual 在用（MIL-129 接對帳檔）。
//
// 介面的規則：
// - tx 是呼叫端的組織交易。入帳確認、分錄、配置、持有人確認紀錄、通知、稽核事件同一個交易提交或回滾，函式不開交易。
// - 權限由呼叫端先 authorize()（動作 ledger.record_payment）。函式不判斷誰能登錄，只做資料檢查。
// - 業務失敗回傳 { ok: false, failure }，什麼都不寫。資料庫的約束或觸發器擋下時仍會丟錯，那代表程式有誤。
// - 冪等：同一個 (source, externalId) 只入帳一次。重送時內容相同回傳原本那筆（duplicate: true），內容不同回 idempotency_conflict。
// - 通知的 email 要等交易提交後，才用 result.notices 呼叫 dispatchNotificationEmail。
//
// 序列化：先鎖案件的押金台帳列（FOR UPDATE），同一案件的入帳確認一次一筆。
// 兩個同時送出的相同請求，後到的等前一筆提交，看到去重鍵已存在而回傳原本那筆。
// 配置在鎖內計算，所以不會有兩筆入帳同時配給同一個期別而超配。

import { appendAudit } from '../audit';
import { linkedMandateCaseId, notifyMandators } from '../case-ledger/mandator';
import { listPeriods } from '../case-ledger/reads';
import { evaluateHolderRule, type BusinessType, type HolderKind } from '../deposit-rules';
import { DEPOSIT_HOLDER_MESSAGE_TEXT } from '../labels/case-ledger-labels';
import { assertPaymentAccountsInOrg, getPaymentAccount, loadHolderRules, HOLDER_KIND_LABELS } from '../payment-accounts';
import { isUlid, newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { NotifyReceipt } from '../notifications';
import { allocateReceipt, type AllocationDraft, type ReceivablePeriod } from '../receivables';
import { isValidEffectiveDate } from './header';
import { postJournal } from './post';
import { RECEIPT_PURPOSES, RECEIPT_SOURCES } from './receipt-types';
import type {
  ConfirmReceiptFailure,
  ConfirmReceiptResult,
  HolderRuleNotice,
  ReceiptAllocationView,
  ReceiptCandidate,
  ReceiptConfirmation,
} from './receipt-types';
import { findConfirmationByKey, listAllocations, listConfirmationAllocations } from './receipt-reads';

export const MAX_EXTERNAL_ID_LENGTH = 200;
export const MAX_EVIDENCE_NAME_LENGTH = 200;

const fail = (failure: ConfirmReceiptFailure): ConfirmReceiptResult => ({ ok: false, failure });
const invalid = (message: string): ConfirmReceiptResult => fail({ code: 'invalid_input', message });

/** 檢查候選的欄位。只看形狀，不查資料庫。 */
function validateCandidate(c: ReceiptCandidate): string | null {
  if (!(RECEIPT_SOURCES as readonly string[]).includes(c.source)) return '入帳來源不合法';
  if (typeof c.externalId !== 'string' || c.externalId.trim() === '' || c.externalId.length > MAX_EXTERNAL_ID_LENGTH) {
    return `去重鍵必須是 1 到 ${MAX_EXTERNAL_ID_LENGTH} 字`;
  }
  if (!isUlid(c.caseId)) return '案件 ID 不合法';
  if (!(RECEIPT_PURPOSES as readonly string[]).includes(c.purpose)) return '入帳用途不合法';
  if (!Number.isSafeInteger(c.amount) || c.amount <= 0) return '入帳金額必須是大於 0 的整數元';
  if (!isValidEffectiveDate(c.valueDate)) return '入帳日必須是存在的日期（YYYY-MM-DD）';
  if (!isUlid(c.paymentAccountId)) return '收款帳戶不合法';
  if (c.recordedByPartyId !== null && !isUlid(c.recordedByPartyId)) return '登錄者不合法';
  const e = c.evidence;
  if (e) {
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) return '證明檔雜湊不合法';
    if (e.fileName.trim() === '' || e.fileName.length > MAX_EVIDENCE_NAME_LENGTH) return `證明檔名稱必須是 1 到 ${MAX_EVIDENCE_NAME_LENGTH} 字`;
    if (e.contentType.trim() === '') return '證明檔類型不得為空';
    if (!e.objectKey.includes('/ledger/receipt-evidence/')) return '證明檔位置不合法';
  }
  return null;
}

interface CaseFacts {
  business_type: BusinessType | null;
  social_housing: boolean;
  title: string;
}

function sameContent(existing: ReceiptConfirmation, c: ReceiptCandidate): boolean {
  return (
    existing.caseId === c.caseId &&
    existing.purpose === c.purpose &&
    existing.amount === c.amount &&
    existing.valueDate === c.valueDate &&
    existing.paymentAccountId === c.paymentAccountId
  );
}

/** 重送時回傳原本那筆：配置與預收取自資料庫，不重算。 */
async function replayDuplicate(tx: OrgTx, existing: ReceiptConfirmation): Promise<ConfirmReceiptResult> {
  const allocations = existing.purpose === 'rent' ? await listConfirmationAllocations(tx, existing.caseId, existing.id) : [];
  const allocated = allocations.reduce((sum, a) => sum + a.amount, 0);
  const ack = await tx.query<{ id: string }>(`SELECT id FROM org.deposit_holder_acknowledgments WHERE receipt_confirmation_id = $1`, [existing.id]);
  return {
    ok: true,
    duplicate: true,
    confirmation: existing,
    allocations,
    prepaid: existing.purpose === 'rent' ? existing.amount - allocated : 0,
    holderAcknowledgmentId: ack.rows[0]?.id ?? null,
    notices: [],
  };
}

export async function confirmReceipt(tx: OrgTx, candidate: ReceiptCandidate): Promise<ConfirmReceiptResult> {
  const problem = validateCandidate(candidate);
  if (problem) return invalid(problem);

  const found = await tx.query<CaseFacts>(
    `SELECT business_type, social_housing, title FROM org.cases WHERE id = $1 AND kind = 'lease'`,
    [candidate.caseId],
  );
  const facts = found.rows[0];
  if (!facts) return fail({ code: 'case_not_found' });

  // 序列化同一案件的入帳。押金台帳在合約全員完成時建立，沒有就是還不能入帳（ADR-0050 決議 4）
  const ledger = await tx.query<{ status: 'open' | 'settled' }>(`SELECT status FROM org.deposit_ledgers WHERE case_id = $1 FOR UPDATE`, [candidate.caseId]);
  if (!ledger.rows[0]) return fail({ code: 'ledger_not_open' });

  const existing = await findConfirmationByKey(tx, candidate.source, candidate.externalId);
  if (existing) return sameContent(existing, candidate) ? replayDuplicate(tx, existing) : fail({ code: 'idempotency_conflict' });

  if (candidate.purpose === 'security_deposit' && ledger.rows[0].status === 'settled') return fail({ code: 'deposit_settled' });

  // 收款帳戶：屬於本組織、啟用中。同時對帳戶列加共享鎖，持有人鎖定不會被競態繞過
  const usable = await assertPaymentAccountsInOrg(tx, [candidate.paymentAccountId]);
  if (!usable.ok) return fail({ code: 'account_not_usable' });
  const account = await getPaymentAccount(tx, candidate.paymentAccountId);
  if (!account) return fail({ code: 'account_not_usable' });

  // 押金帳戶規則（ADR-0014 決議 13）。只有押金入帳要檢查，租金不看持有人
  let notice: HolderRuleNotice | null = null;
  let notifyMandator = false;
  if (candidate.purpose === 'security_deposit' && facts.business_type !== null) {
    const evaluation = evaluateHolderRule(await loadHolderRules(tx), {
      businessType: facts.business_type,
      socialHousing: facts.social_housing,
      holderKind: account.holderKind,
      // 委託範圍是否含押金：案件上還沒有這項資料（MIL-116、MIL-119 接線後才有），先當 false，與 listHolderConflicts 一致
      mandateIncludesDeposit: false,
    });
    if (evaluation.action !== 'allow') {
      notice = {
        action: evaluation.action,
        ruleId: evaluation.ruleId,
        ruleVersion: evaluation.ruleVersion,
        messageKey: evaluation.messageKey,
        holderKind: account.holderKind,
      };
      notifyMandator = evaluation.notifyMandator;
      if (evaluation.action === 'block') return fail({ code: 'holder_blocked', notice });
      if (candidate.acknowledgeHolderWarning !== true) return fail({ code: 'holder_ack_required', notice });
    }
  }

  // 租金：預設配給最舊的未足額期別，超額記預收。押金不進應收期別（ADR-0050 決議 3）
  const confirmationId = newUlid();
  let drafts: AllocationDraft[] = [];
  let prepaid = 0;
  let periodKeys = new Map<string, string>();
  if (candidate.purpose === 'rent') {
    const periods: ReceivablePeriod[] = await listPeriods(tx, candidate.caseId);
    periodKeys = new Map(periods.map((p) => [p.id, p.periodKey]));
    const allocated = allocateReceipt(periods, candidate.amount, {
      receiptId: confirmationId,
      allocations: await listAllocations(tx, candidate.caseId),
    });
    if (!allocated.ok) return invalid(`無法配置到應收期別：${allocated.reason}`);
    drafts = allocated.allocations;
    prepaid = allocated.prepaid;
  }

  const rentAllocated = candidate.amount - prepaid;
  const posted = await postJournal(tx, {
    eventType: 'receipt_confirmed',
    eventId: confirmationId,
    caseId: candidate.caseId,
    effectiveDate: candidate.valueDate,
    payload:
      candidate.purpose === 'security_deposit'
        ? { paymentAccountId: candidate.paymentAccountId, deposit: candidate.amount }
        : { paymentAccountId: candidate.paymentAccountId, rent: rentAllocated, prepaidRent: prepaid },
  });
  if (!posted.ok) return fail({ code: 'ledger_rejected', errors: posted.errors });

  // 同一份證明檔再用：記錄最早用它的入帳確認，不阻擋（ADR-0014 決議 7）
  const evidence = candidate.evidence ?? null;
  let evidenceReuseOf: string | null = null;
  if (evidence) {
    const reused = await tx.query<{ id: string }>(
      `SELECT id FROM org.receipt_confirmations WHERE evidence_sha256 = $1 ORDER BY id LIMIT 1`,
      [evidence.sha256],
    );
    evidenceReuseOf = reused.rows[0]?.id ?? null;
  }

  const inserted = await tx.query<{ recorded_at: Date }>(
    `INSERT INTO org.receipt_confirmations
       (id, org_id, case_id, purpose, amount, value_date, payment_account_id, source, external_id, journal_id,
        recorded_by_party_id, evidence_key, evidence_sha256, evidence_name, evidence_content_type, evidence_reuse_of)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING recorded_at`,
    [
      confirmationId,
      candidate.caseId,
      candidate.purpose,
      candidate.amount,
      candidate.valueDate,
      candidate.paymentAccountId,
      candidate.source,
      candidate.externalId,
      posted.value.journalId,
      candidate.recordedByPartyId,
      evidence?.objectKey ?? null,
      evidence?.sha256 ?? null,
      evidence?.fileName ?? null,
      evidence?.contentType ?? null,
      evidenceReuseOf,
    ],
  );

  const allocations: ReceiptAllocationView[] = [];
  for (const draft of drafts) {
    await tx.query(
      `INSERT INTO org.receipt_allocations (id, org_id, case_id, period_id, source, source_id, amount)
       VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6)`,
      [newUlid(), candidate.caseId, draft.periodId, draft.source, draft.sourceId, draft.amount],
    );
    allocations.push({ periodId: draft.periodId, periodKey: periodKeys.get(draft.periodId) ?? '', amount: draft.amount });
  }

  let holderAcknowledgmentId: string | null = null;
  let notices: NotifyReceipt[] = [];
  if (notice) {
    holderAcknowledgmentId = newUlid();
    await tx.query(
      `INSERT INTO org.deposit_holder_acknowledgments
         (id, org_id, case_id, receipt_confirmation_id, payment_account_id, rule_id, rule_version, action, message_key, acknowledged_by_party_id)
       VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        holderAcknowledgmentId,
        candidate.caseId,
        confirmationId,
        candidate.paymentAccountId,
        notice.ruleId,
        notice.ruleVersion,
        notice.action,
        notice.messageKey ?? 'deposit_holder.warn.rule_unmatched',
        candidate.recordedByPartyId,
      ],
    );
    await appendAudit(tx, {
      action: 'deposit.confirm',
      object: { type: 'case', id: candidate.caseId },
      payload: {
        acknowledgment_id: holderAcknowledgmentId,
        confirmation_id: confirmationId,
        rule_id: notice.ruleId,
        rule_version: notice.ruleVersion,
        rule_action: notice.action,
        on_behalf: candidate.onBehalf,
      },
    });
    if (notifyMandator) {
      const text = notice.messageKey ? (DEPOSIT_HOLDER_MESSAGE_TEXT[notice.messageKey] ?? '') : '';
      notices = (
        await notifyMandators(tx, await linkedMandateCaseId(tx, candidate.caseId), {
          kind: 'deposit.holder_acknowledged',
          title: '押金入帳時，登錄者已確認押金帳戶規則的警告',
          body: [
            `案件：${facts.title || candidate.caseId}`,
            `收款帳戶：${account.name}（持有人：${HOLDER_KIND_LABELS[account.holderKind as HolderKind]}）`,
            text,
            '平台只記錄款項，不經手款項。',
          ]
            .filter((line) => line !== '')
            .join('\n'),
          linkPath: `/cases/${candidate.caseId}`,
        })
      ).receipts;
    }
  }

  // payload 只放 ID 與旗標，不放金額與檔名：canonical 寫入後刪不掉（ADR-0019 決議 5）。金額在分錄裡
  await appendAudit(tx, {
    action: 'ledger.entry',
    object: { type: 'case', id: candidate.caseId },
    payload: {
      event: 'receipt_confirmed',
      confirmation_id: confirmationId,
      journal_id: posted.value.journalId,
      purpose: candidate.purpose,
      source: candidate.source,
      on_behalf: candidate.onBehalf,
      allocated_period_count: allocations.length,
      has_prepaid: prepaid > 0,
      evidence_reused: evidenceReuseOf !== null,
    },
  });

  return {
    ok: true,
    duplicate: false,
    confirmation: {
      id: confirmationId,
      caseId: candidate.caseId,
      purpose: candidate.purpose,
      amount: candidate.amount,
      valueDate: candidate.valueDate,
      paymentAccountId: candidate.paymentAccountId,
      source: candidate.source,
      journalId: posted.value.journalId,
      recordedByPartyId: candidate.recordedByPartyId,
      recordedAt: inserted.rows[0].recorded_at.toISOString(),
      hasEvidence: evidence !== null,
      evidenceReuseOf,
    },
    allocations,
    prepaid,
    holderAcknowledgmentId,
    notices,
  };
}
