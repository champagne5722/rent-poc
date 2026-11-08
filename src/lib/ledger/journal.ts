// 由事件類型與 payload 建出一筆分錄。這是之後 `postJournal()` 寫入前的純函式部分。
// 這個檔案不認識任何事件類型。事件長什麼樣子，全由登錄表裡的定義決定。

import { checkHeader } from './header';
import type { LedgerRegistry } from './registry';
import { ledgerError, type JournalHeader, type LedgerError, type LedgerResult, type OriginalJournal } from './types';
import { validateJournal } from './validate';

export interface BuildJournalInput extends JournalHeader {
  /** 開放字串，不是封閉 enum。必須已在登錄表中。 */
  eventType: string;
  payload: unknown;
}

export function buildJournal(registry: LedgerRegistry, input: BuildJournalInput): LedgerResult<OriginalJournal> {
  const errors: LedgerError[] = checkHeader(input);

  const definition = registry.get(input.eventType);
  if (!definition) {
    errors.push(ledgerError('unknown_event', `事件類型尚未登錄：${input.eventType}`));
    return { ok: false, errors };
  }
  if (!definition.postable) {
    errors.push(ledgerError('event_not_postable', `${definition.label}不得直接寫入，必須由專用函式產生`));
    return { ok: false, errors };
  }

  const parsed = definition.parsePayload(input.payload);
  if (!parsed.ok) {
    for (const message of parsed.errors) {
      errors.push(ledgerError('invalid_payload', `${definition.label}：${message}`));
    }
    return { ok: false, errors };
  }
  if (errors.length > 0) return { ok: false, errors };

  const lines = definition.template(parsed.value, { caseId: input.caseId });
  const validation = validateJournal({ lines });
  if (!validation.ok) return validation;

  return {
    ok: true,
    value: {
      journalId: input.journalId,
      orgId: input.orgId,
      caseId: input.caseId,
      eventType: input.eventType,
      eventId: input.eventId,
      postedAt: input.postedAt,
      effectiveDate: input.effectiveDate,
      reversesJournalId: null,
      reason: null,
      lines,
    },
  };
}
