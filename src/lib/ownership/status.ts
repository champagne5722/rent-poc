import type { PropertyVerificationStatus } from '../types';

// 所有權節點的狀態與轉移（MIL-201，ADR-0026 決議 2，ADR-0028 決議 3）。
// 純函式，沒有 I/O，前端與伺服器端都能匯入。資料庫的 org.ownership_nodes 觸發器用同一張轉移表，
// ownership-schema.test.ts 驗證兩者一致。

export const OWNERSHIP_STATUSES = ['pending_verification', 'verified', 'failed', 'lapsed'] as const;
export type OwnershipStatus = (typeof OWNERSHIP_STATUSES)[number];

/**
 * 轉移事件。
 * - resubmit：使用者補件後重新送出（只有驗證失敗能補件）。
 * - verify、fail：平台營運者判定。
 * - lapse：使用者停用、合併、移交等。這張票只定義轉移，沒有觸發它的入口。
 */
export const OWNERSHIP_EVENTS = ['resubmit', 'verify', 'fail', 'lapse'] as const;
export type OwnershipEvent = (typeof OWNERSHIP_EVENTS)[number];

const TRANSITIONS: Readonly<Record<OwnershipStatus, Partial<Record<OwnershipEvent, OwnershipStatus>>>> = {
  pending_verification: { verify: 'verified', fail: 'failed', lapse: 'lapsed' },
  verified: { lapse: 'lapsed' },
  failed: { resubmit: 'pending_verification', lapse: 'lapsed' },
  lapsed: {},
};

/** 下一個狀態。事件在這個狀態不合法時回 null。 */
export function nextOwnershipStatus(from: OwnershipStatus, event: OwnershipEvent): OwnershipStatus | null {
  return TRANSITIONS[from][event] ?? null;
}

/** 「有效」指待驗證或已驗證（ADR-0026 決議 2）。 */
export function isActiveOwnershipStatus(status: OwnershipStatus): boolean {
  return status === 'pending_verification' || status === 'verified';
}

/**
 * 物件對外的核對狀態（ADR-0028 決議 2）。沒有節點、待驗證與已失效都顯示「待平台核對文件」。
 * 節點的狀態只屬於登錄的一方，這個函式只用呼叫者自己組織的節點。
 */
export function toPropertyVerificationStatus(status: OwnershipStatus | null): PropertyVerificationStatus {
  if (status === 'verified') return 'verified';
  if (status === 'failed') return 'failed';
  return 'pending_verification';
}

export interface OwnershipCheckResult {
  keyMatch: boolean;
  holderMatch: boolean;
}

/** 兩項都相符才通過（ADR-0028 決議 3）。任一項不符就是驗證失敗。 */
export function outcomeOfCheck(result: OwnershipCheckResult): 'verified' | 'failed' {
  return result.keyMatch && result.holderMatch ? 'verified' : 'failed';
}
