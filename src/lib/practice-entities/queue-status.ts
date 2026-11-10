// 審核台項目的狀態。獨立成檔，讓狀態呈現表與測試能列舉，不必載入 desk.ts 的資料庫程式。
export const QUEUE_STATUSES = ['open', 'resolved'] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];
