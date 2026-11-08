// 鏡像帳的寫入入口（ADR-0015 決議 13、ADR-0050 決議 3）。
//
// 只有 ledger 模組能呼叫 postJournal() 與 reverseJournal()。其他模組呼叫 ledger 的業務函式
// （confirmReceipt、recordDepositDeduction 等，E1-5 之後）。守門方式：
//   1. index.ts 不匯出這個檔案。
//   2. post.guard.test.ts 掃描原始碼，ledger 目錄以外的檔案不得出現 postJournal、reverseJournal 或匯入這個檔案。
//
// 這個檔案不認識任何事件類型。事件長什麼樣子由登錄表決定，其他線新增事件時只加事件定義與業務函式，
// 再把擴充後的登錄表（extendLedgerRegistry）當第三個參數傳進來。

import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { buildJournal } from './journal';
import { defaultLedgerRegistry } from './events';
import type { LedgerRegistry } from './registry';
import { buildReversal } from './reversal';
import { hasReversal, insertJournal, loadJournal, readContext } from './store';
import { ledgerError, type LedgerResult, type OriginalJournal, type ReversalJournal } from './types';

export interface PostJournalInput {
  /** 開放字串，必須已在登錄表中。 */
  eventType: string;
  /** 業務事件 ID。與事件類型、組織一起唯一，重送同一個事件時靠它冪等。 */
  eventId: string;
  caseId: string;
  /** 由事件定義的 parsePayload 檢查。 */
  payload: unknown;
  /** 銀行日，`YYYY-MM-DD`。 */
  effectiveDate: string;
  /** 登錄時間，ISO 8601 含時區。預設取資料庫的交易時間，只有測試與補登才需要指定。 */
  postedAt?: string;
}

/**
 * 依事件類型與 payload 建出分錄並寫入。org_id 取自 tx 的組織脈絡。
 * 失敗時回傳錯誤清單而不丟錯，什麼都不寫。業務事件鍵重複時回傳 `duplicate_event`。
 * 資料庫約束或觸發器擋下時（例如提交時不平衡）仍會丟錯，那代表程式有誤。
 */
export async function postJournal(
  tx: OrgTx,
  input: PostJournalInput,
  registry: LedgerRegistry = defaultLedgerRegistry,
): Promise<LedgerResult<OriginalJournal>> {
  const context = await readContext(tx);
  const built = buildJournal(registry, {
    journalId: newUlid(),
    orgId: context.orgId,
    caseId: input.caseId,
    eventType: input.eventType,
    eventId: input.eventId,
    postedAt: input.postedAt ?? context.now,
    effectiveDate: input.effectiveDate,
    payload: input.payload,
  });
  if (!built.ok) return built;

  const journal = built.value;
  const written = await insertJournal(tx, journal, newUlid);
  if (!written) {
    return {
      ok: false,
      errors: [ledgerError('duplicate_event', `業務事件已寫過：${journal.eventType} ${journal.eventId}。要更正請先沖銷，再用新的業務事件 ID 重新登錄`)],
    };
  }
  return built;
}

export interface ReverseJournalInput {
  /** 被沖銷的分錄 ID。 */
  journalId: string;
  /** 沖銷自己的業務事件 ID，必須是新的。 */
  eventId: string;
  /** 沖銷原因，必填。 */
  reason: string;
  effectiveDate: string;
  postedAt?: string;
  /** 選填。業務函式知道自己在處理哪個案件時帶上，與原分錄不同就拒絕，防止沖銷到別的案件。 */
  caseId?: string;
}

/**
 * 沖銷一筆分錄：寫入借貸互換的新分錄，指向原分錄。
 * 找不到、已被沖銷、原分錄本身是沖銷、案件不符時回傳錯誤清單，什麼都不寫。
 */
export async function reverseJournal(tx: OrgTx, input: ReverseJournalInput): Promise<LedgerResult<ReversalJournal>> {
  const context = await readContext(tx);

  const stored = await loadJournal(tx, context.orgId, input.journalId);
  if (!stored) {
    return { ok: false, errors: [ledgerError('journal_not_found', `找不到分錄：${input.journalId}`)] };
  }
  if (stored.reversesJournalId !== null) {
    return { ok: false, errors: [ledgerError('cannot_reverse_reversal', '沖銷分錄不得再被沖銷，要更正時，沖銷後另發新的入帳確認')] };
  }
  if (input.caseId !== undefined && input.caseId !== stored.header.caseId) {
    return { ok: false, errors: [ledgerError('case_mismatch', `分錄屬於案件 ${stored.header.caseId}，不是 ${input.caseId}`)] };
  }
  if (await hasReversal(tx, context.orgId, input.journalId)) {
    return { ok: false, errors: [ledgerError('already_reversed', `分錄 ${input.journalId} 已被沖銷，一筆分錄最多沖銷一次`)] };
  }

  const original: OriginalJournal = { ...stored.header, reversesJournalId: null, reason: null, lines: stored.lines };
  const built = buildReversal(original, {
    journalId: newUlid(),
    eventId: input.eventId,
    reason: input.reason,
    postedAt: input.postedAt ?? context.now,
    effectiveDate: input.effectiveDate,
  });
  if (!built.ok) return built;

  const written = await insertJournal(tx, built.value, newUlid);
  if (!written) {
    // 同一時間另一個交易搶先沖銷，或沖銷的業務事件 ID 已被用過
    const reversed = await hasReversal(tx, context.orgId, input.journalId);
    return {
      ok: false,
      errors: [
        reversed
          ? ledgerError('already_reversed', `分錄 ${input.journalId} 已被沖銷，一筆分錄最多沖銷一次`)
          : ledgerError('duplicate_event', `業務事件已寫過：${built.value.eventType} ${built.value.eventId}`),
      ],
    };
  }
  return built;
}
