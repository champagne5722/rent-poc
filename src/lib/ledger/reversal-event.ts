// 沖銷事件的定義。它是一般的事件定義，用和其他事件一樣的介面。
// buildReversal() 用它的模板互換借貸，核心函式本身不認識任何事件類型。

import { asRecord } from './payload';
import { defineLedgerEvent } from './registry';
import type { JournalLine } from './types';

export interface ReversalPayload {
  /** 原分錄的明細。沖銷分錄把每列借貸互換。 */
  lines: readonly JournalLine[];
}

/**
 * 沖銷。借貸與原分錄相反。不可直接寫入，必須經 `buildReversal()`，
 * 因為沖銷要帶原因與原分錄 ID。
 */
export const reversal = defineLedgerEvent<ReversalPayload>({
  type: 'reversal',
  label: '沖銷',
  postable: false,
  parsePayload(raw) {
    const errors: string[] = [];
    const source = asRecord(raw, errors);
    if (!source) return { ok: false, errors };
    if (!Array.isArray(source.lines)) errors.push('lines 必須是陣列');
    return errors.length === 0 ? { ok: true, value: { lines: source.lines as JournalLine[] } } : { ok: false, errors };
  },
  template: ({ lines }) => lines.map((line) => ({ account: line.account, debit: line.credit, credit: line.debit })),
});

