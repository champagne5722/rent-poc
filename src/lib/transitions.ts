import type Database from 'better-sqlite3';
import { commitTransition, type ContractEventInput } from './db';
import type { Contract, ContractStatus } from './types';

// 點點簽 webhook 事件 → 合約狀態轉移（狀態機見 docs/domain-model.md）。
// mock 模式的 /api/mock/advance 也走同一條路，確保模擬與真接行為一致。
export type DsEvent = 'signed' | 'completed' | 'declined' | 'voided';

export interface TransitionDecision {
  status: ContractStatus;
  event: ContractEventInput;
}

// 純函式 seam：由目前狀態與點點簽事件決定「下一狀態」與「要記的歷程事件」；
// 不接受該事件時回 null。沒有任何 I/O，可獨立測試（ADR-0007 要求兩者一致）。
export function decideTransition(
  status: ContractStatus,
  event: DsEvent,
  reason?: string
): TransitionDecision | null {
  const signing = status === 'awaiting_tenant' || status === 'awaiting_landlord';

  switch (event) {
    case 'signed':
      // 個別簽署人完成：乙先甲後，乙方簽完進入待甲方。
      // 甲方的 signed 之後會跟著 completed 事件，這裡不動作
      if (status !== 'awaiting_tenant') return null;
      return {
        status: 'awaiting_landlord',
        event: { type: 'tenant_signed', actor: 'tenant', note: null },
      };
    case 'completed':
      if (!signing) return null;
      return {
        status: 'completed',
        event: { type: 'completed', actor: 'landlord', note: null },
      };
    case 'declined':
      if (!signing) return null;
      // 拒簽方＝當前輪到的簽署人；原因寫進事件附註
      return {
        status: 'declined',
        event: {
          type: 'declined',
          actor: status === 'awaiting_tenant' ? 'tenant' : 'landlord',
          note: reason ?? null,
        },
      };
    case 'voided':
      if (!signing) return null;
      return {
        status: 'voided',
        event: { type: 'voided', actor: 'landlord', note: null },
      };
  }
}

// 套用轉移：狀態與歷程事件在同一次交易寫入（任一失敗一起回滾）。
// db 參數只給測試注入 in-memory DB 用，正式路徑走預設的檔案 DB。
export function applyDsEvent(
  contract: Contract,
  event: DsEvent,
  reason?: string,
  db?: Database.Database
): ContractStatus | null {
  const decision = decideTransition(contract.status, event, reason);
  if (!decision) return null;

  commitTransition(
    contract.id,
    {
      status: decision.status,
      event: decision.event,
      declinedReason: decision.status === 'declined' ? (reason ?? null) : null,
    },
    db
  );
  return decision.status;
}
