// 入帳配置、預收抵充與改配置（ADR-0015 決議 11、ADR-0050 決議 3）。
// 純函式，沒有 I/O。函式只回傳「要寫的配置草稿」與「要失效的配置 id」，id 與寫入由呼叫端負責。
// 押金不進應收期別：期別與配置的 kind 型別固定為 'rent'，執行時再擋一次。

import { outstandingAmount } from './status';
import type { Allocation, AllocationDraft, ReceivablePeriod } from './types';

export type AllocationFailureReason =
  | 'invalid_amount'
  | 'wrong_kind'
  | 'unknown_period'
  | 'period_cancelled';

export interface AllocateReceiptOptions {
  /** 入帳確認 ID，成為配置的 sourceId。 */
  receiptId: string;
  /** 該案件目前所有配置（含失效的）。用來算每期尚未足額的金額。 */
  allocations: readonly Allocation[];
  /** 使用者指定的優先順序（期別 id）。排在前面的先配，其餘照預設順序補。 */
  periodOrder?: readonly string[];
}

export type AllocateReceiptResult =
  | {
      ok: true;
      allocations: AllocationDraft[];
      /** 配滿所有期別之後多出來的金額，記為預收租金。 */
      prepaid: number;
    }
  | { ok: false; reason: AllocationFailureReason };

function isRent(kind: string): boolean {
  return kind === 'rent';
}

function isPositiveMoney(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** 預設順序：到期日由舊到新，同日依期別鍵，再依 id，結果固定。 */
function byOldest(a: ReceivablePeriod, b: ReceivablePeriod): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.periodKey !== b.periodKey) return a.periodKey < b.periodKey ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 一筆租金入帳的配置。預設配給最舊的未足額期別，放不下再往下一期，
 * 全部配滿後的剩餘金額回傳為預收。已取消與已足額的期別跳過。
 * 這個函式只接受租金期別，押金不得配置到期別。
 */
export function allocateReceipt(
  periods: readonly ReceivablePeriod[],
  amount: number,
  options: AllocateReceiptOptions,
): AllocateReceiptResult {
  if (!isPositiveMoney(amount)) return { ok: false, reason: 'invalid_amount' };
  if (periods.some((p) => !isRent(p.kind))) return { ok: false, reason: 'wrong_kind' };

  const byId = new Map(periods.map((p) => [p.id, p] as const));
  const preferred: ReceivablePeriod[] = [];
  for (const id of options.periodOrder ?? []) {
    const p = byId.get(id);
    if (!p) return { ok: false, reason: 'unknown_period' };
    if (p.state === 'cancelled') return { ok: false, reason: 'period_cancelled' };
    if (!preferred.includes(p)) preferred.push(p);
  }
  const rest = periods.filter((p) => p.state === 'active' && !preferred.includes(p)).sort(byOldest);

  const drafts: AllocationDraft[] = [];
  let remaining = amount;
  for (const period of [...preferred, ...rest]) {
    if (remaining === 0) break;
    const room = outstandingAmount(period, options.allocations);
    if (room === 0) continue;
    const portion = Math.min(room, remaining);
    drafts.push({ sourceId: options.receiptId, periodId: period.id, amount: portion, source: 'receipt', kind: 'rent' });
    remaining -= portion;
  }
  return { ok: true, allocations: drafts, prepaid: remaining };
}

export type ApplyPrepaidFailureReason =
  | 'invalid_amount'
  | 'wrong_kind'
  | 'period_cancelled'
  | 'exceeds_prepaid_balance'
  | 'exceeds_outstanding';

export interface ApplyPrepaidOptions {
  /** 預收抵充事件 ID（`prepaid_applied` 的業務事件 ID），成為配置的 sourceId。 */
  applicationId: string;
  /** 該案件目前所有配置（含失效的）。用來算該期尚未足額的金額。 */
  allocations: readonly Allocation[];
}

export type ApplyPrepaidResult =
  | { ok: true; allocation: AllocationDraft; remainingPrepaid: number }
  | { ok: false; reason: ApplyPrepaidFailureReason };

/**
 * 以預收抵充某一期。系統不自動抵充，由使用者在期別上選擇。
 * 金額不得超過預收餘額，也不得超過該期尚未足額的金額。
 */
export function applyPrepaid(
  period: ReceivablePeriod,
  prepaidBalance: number,
  amount: number,
  options: ApplyPrepaidOptions,
): ApplyPrepaidResult {
  if (!isPositiveMoney(amount) || !Number.isSafeInteger(prepaidBalance) || prepaidBalance < 0) {
    return { ok: false, reason: 'invalid_amount' };
  }
  if (!isRent(period.kind)) return { ok: false, reason: 'wrong_kind' };
  if (period.state === 'cancelled') return { ok: false, reason: 'period_cancelled' };
  if (amount > prepaidBalance) return { ok: false, reason: 'exceeds_prepaid_balance' };
  if (amount > outstandingAmount(period, options.allocations)) return { ok: false, reason: 'exceeds_outstanding' };
  return {
    ok: true,
    allocation: { sourceId: options.applicationId, periodId: period.id, amount, source: 'prepaid', kind: 'rent' },
    remainingPrepaid: prepaidBalance - amount,
  };
}

export interface ReallocationChange {
  /** 要改的既有配置 id。 */
  allocationId: string;
  /** 改配到哪些期別與金額。金額合計必須等於原配置金額。 */
  to: readonly { periodId: string; amount: number }[];
}

export type ReallocateFailureReason =
  | 'invalid_amount'
  | 'wrong_kind'
  | 'unknown_allocation'
  | 'inactive_allocation'
  | 'duplicate_change'
  | 'duplicate_period'
  | 'unknown_period'
  | 'period_cancelled'
  | 'amount_mismatch'
  | 'exceeds_period_amount';

export type ReallocateResult =
  | {
      ok: true;
      /** 要標記失效的舊配置 id。 */
      invalidated: string[];
      /** 要寫入的新配置。來源（sourceId、source）沿用舊配置。 */
      created: AllocationDraft[];
    }
  | { ok: false; reason: ReallocateFailureReason };

/**
 * 改配置：舊配置標記失效、新配置寫入，有效配置的金額合計不變。
 * 改完後任何期別都不得超過應收金額，也不得配到已取消的期別。
 * 全有或全無：任何一項不合法就整批拒絕。
 */
export function reallocate(
  allocations: readonly Allocation[],
  changes: readonly ReallocationChange[],
  periods: readonly ReceivablePeriod[],
): ReallocateResult {
  const periodById = new Map(periods.map((p) => [p.id, p] as const));
  const allocationById = new Map(allocations.map((a) => [a.id, a] as const));
  const seen = new Set<string>();
  const invalidated: string[] = [];
  const created: AllocationDraft[] = [];

  for (const change of changes) {
    const old = allocationById.get(change.allocationId);
    if (!old) return { ok: false, reason: 'unknown_allocation' };
    if (!old.active) return { ok: false, reason: 'inactive_allocation' };
    if (seen.has(old.id)) return { ok: false, reason: 'duplicate_change' };
    seen.add(old.id);

    const targets = new Set<string>();
    let total = 0;
    for (const t of change.to) {
      if (!isPositiveMoney(t.amount)) return { ok: false, reason: 'invalid_amount' };
      if (targets.has(t.periodId)) return { ok: false, reason: 'duplicate_period' };
      targets.add(t.periodId);
      const period = periodById.get(t.periodId);
      if (!period) return { ok: false, reason: 'unknown_period' };
      if (!isRent(period.kind) || !isRent(old.kind)) {
        return { ok: false, reason: 'wrong_kind' };
      }
      if (period.state === 'cancelled') return { ok: false, reason: 'period_cancelled' };
      total += t.amount;
      created.push({ sourceId: old.sourceId, periodId: t.periodId, amount: t.amount, source: old.source, kind: 'rent' });
    }
    if (total !== old.amount) return { ok: false, reason: 'amount_mismatch' };
    invalidated.push(old.id);
  }

  // 改完之後，被配到的期別不得超過應收金額。
  const after = new Map<string, number>();
  for (const a of allocations) {
    if (a.active && !seen.has(a.id)) after.set(a.periodId, (after.get(a.periodId) ?? 0) + a.amount);
  }
  for (const c of created) after.set(c.periodId, (after.get(c.periodId) ?? 0) + c.amount);
  for (const c of created) {
    const period = periodById.get(c.periodId);
    if (period && (after.get(c.periodId) ?? 0) > period.amount) return { ok: false, reason: 'exceeds_period_amount' };
  }

  return { ok: true, invalidated, created };
}
