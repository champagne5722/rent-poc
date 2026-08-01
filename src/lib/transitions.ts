import { updateContractStatus } from './db';
import type { Contract } from './types';

// 點點簽 webhook 事件 → 合約狀態轉移（狀態機見 docs/domain-model.md）。
// mock 模式的 /api/mock/advance 也走同一條路，確保模擬與真接行為一致。
export type DsEvent = 'signed' | 'completed' | 'declined' | 'voided';

export function applyDsEvent(contract: Contract, event: DsEvent, reason?: string): Contract['status'] | null {
  switch (event) {
    case 'signed':
      // 個別簽署人完成：乙先甲後，乙方簽完進入待甲方
      if (contract.status === 'awaiting_tenant') return set(contract, 'awaiting_landlord');
      return null; // 甲方的 signed 之後會跟著 completed 事件，這裡不動作
    case 'completed':
      if (contract.status === 'awaiting_tenant' || contract.status === 'awaiting_landlord')
        return set(contract, 'completed');
      return null;
    case 'declined':
      if (contract.status === 'awaiting_tenant' || contract.status === 'awaiting_landlord')
        return set(contract, 'declined', reason);
      return null;
    case 'voided':
      if (contract.status === 'awaiting_tenant' || contract.status === 'awaiting_landlord')
        return set(contract, 'voided');
      return null;
  }
}

function set(contract: Contract, status: Contract['status'], reason?: string): Contract['status'] {
  updateContractStatus(contract.id, status, reason);
  return status;
}
