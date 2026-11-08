// 沖銷分錄建構（ADR-0015 決議 4）。純函式。
// 資料庫另有三道防線：唯一鍵擋重複沖銷、觸發器雙向比對借貸、觸發器擋沖銷沖銷分錄。
// 這裡讓應用層先擋下，並把「不得沖銷沖銷分錄」寫進型別。

import { reversal } from './events';
import { checkHeader } from './header';
import { ledgerError, type LedgerError, type LedgerResult, type OriginalJournal, type ReversalJournal } from './types';
import { validateJournal } from './validate';

export interface BuildReversalInput {
  /** 沖銷分錄自己的 ID。 */
  journalId: string;
  /** 沖銷分錄的業務事件 ID，必須是新的，不得沿用原分錄的。 */
  eventId: string;
  /** 沖銷原因，必填。 */
  reason: string;
  postedAt: string;
  effectiveDate: string;
}

/**
 * 輸入只收 `OriginalJournal`，沖銷分錄（`ReversalJournal`）編譯不過。
 * 型別被繞過時，執行時仍以 `reversesJournalId` 判斷並拒絕。
 */
export function buildReversal(journal: OriginalJournal, input: BuildReversalInput): LedgerResult<ReversalJournal> {
  const errors: LedgerError[] = [];

  if (journal.reversesJournalId !== null) {
    errors.push(ledgerError('cannot_reverse_reversal', '沖銷分錄不得再被沖銷，更正要發新的入帳確認'));
    return { ok: false, errors };
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason === '') {
    errors.push(ledgerError('reason_required', '沖銷必須填原因'));
  }

  errors.push(...checkHeader({ ...input, orgId: journal.orgId, caseId: journal.caseId }));

  const originalCheck = validateJournal(journal);
  if (!originalCheck.ok) {
    errors.push(ledgerError('original_invalid', '原分錄本身不合法，無法產生沖銷'));
  }
  if (errors.length > 0) return { ok: false, errors };

  const lines = reversal.template({ lines: journal.lines }, { caseId: journal.caseId });
  const reversalCheck = validateJournal({ lines });
  if (!reversalCheck.ok) return reversalCheck;

  return {
    ok: true,
    value: {
      journalId: input.journalId,
      orgId: journal.orgId,
      caseId: journal.caseId,
      eventType: reversal.type,
      eventId: input.eventId,
      postedAt: input.postedAt,
      effectiveDate: input.effectiveDate,
      reversesJournalId: journal.journalId,
      reason,
      lines,
    },
  };
}
