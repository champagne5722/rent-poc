import type { SigningSubjectType } from './provider';
import type { SigningSubscriber } from './subscriber';

// 測試用的簽署標的訂閱者（MIL-131）：只有「存在」與狀態投影，資料放記憶體，沒有資料表。
// 點交證明、押金結算單、退還證明的真實訂閱者在 MIL-137、138、139，各自有表與業務流程，到時換掉這個。
// 只給測試引用（檔名 .fixture.ts），正式註冊在 index.ts。

const LABELS: Record<Exclude<SigningSubjectType, 'contract'>, string> = {
  handover_certificate: '點交證明',
  deposit_settlement: '押金結算單',
  deposit_refund_certificate: '退還證明',
};

export type DocumentSubjectStatus = 'draft' | 'signing' | 'completed' | 'declined' | 'voided';

export interface DocumentSubjectStub {
  readonly subscriber: SigningSubscriber;
  /** 登錄一個存在的標的，狀態是草稿 */
  add(id: string): void;
  statusOf(id: string): DocumentSubjectStatus | undefined;
  /** 訂閱者收到的呼叫，依序記錄。第一個元素是呼叫名稱 */
  readonly log: unknown[][];
}

export function createDocumentSubjectStub(type: keyof typeof LABELS): DocumentSubjectStub {
  const statuses = new Map<string, DocumentSubjectStatus>();
  const log: unknown[][] = [];
  const statusOf = (id: string) => statuses.get(id);
  const set = (id: string, status: DocumentSubjectStatus) => statuses.set(id, status);

  const subscriber: SigningSubscriber = {
    label: LABELS[type],
    exists: async (_tx, subject) => statuses.has(subject.id),
    currentStatus: async (_tx, subject) => statusOf(subject.id) ?? 'draft',
    isCompleted: async (_tx, subject) => statusOf(subject.id) === 'completed',

    onSent: async (_tx, subject, { signers }) => {
      log.push(['sent', signers.length]);
      set(subject.id, 'signing');
    },
    // 簽署人簽署不改狀態，等全員完成（ADR-0010 決議 7）
    onOutcome: async (_tx, subject, outcome) => {
      log.push([outcome.type]);
      if (outcome.type === 'completed') set(subject.id, 'completed');
      if (outcome.type === 'declined') set(subject.id, 'declined');
      if (outcome.type === 'voided') set(subject.id, 'voided');
    },
    voidWithoutTask: async (_tx, subject) => {
      log.push(['voidWithoutTask']);
      set(subject.id, 'voided');
    },
    afterCompleted: async () => {
      log.push(['afterCompleted']);
    },
  };

  return { subscriber, add: (id) => set(id, 'draft'), statusOf, log };
}
