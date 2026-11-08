// 修繕紀錄的狀態轉移（MIL-133「修繕紀錄」、ADR-0051 決議 10、PRD P0-16）。
// 純函式，沒有 I/O。寫法沿用 src/lib/handover/transitions.ts。
// 與前例不同之處：被拒絕時回傳 { ok: false, reason }，因為「缺費用」「缺付款方」要告訴使用者原因。

export const REPAIR_STATES = ['reported', 'in_progress', 'completed', 'cancelled'] as const;
export type RepairState = (typeof REPAIR_STATES)[number];

/** 付款方：出租人、屋主、承租人、其他。系統只記錄，不付款。 */
export const REPAIR_PAYERS = ['lessor', 'owner', 'lessee', 'other'] as const;
export type RepairPayer = (typeof REPAIR_PAYERS)[number];

// start：開始處理。complete：完成，必須帶費用與付款方。cancel：取消未完成的紀錄。
export const REPAIR_INPUT_TYPES = ['start', 'complete', 'cancel'] as const;
export type RepairInputType = (typeof REPAIR_INPUT_TYPES)[number];

export type RepairInput =
  | { type: 'start' }
  /** 費用是整數新台幣元，得為 0。 */
  | { type: 'complete'; cost: number; payer: RepairPayer }
  | { type: 'cancel' };

/** 稽核事件型別，與輸入一對一。 */
export type RepairEventType = `repair_${RepairInputType}`;

export type RepairRejection =
  | 'invalid_transition'
  | 'cost_required'
  | 'invalid_cost'
  | 'payer_required'
  | 'invalid_payer';

export type RepairTransitionResult =
  | { ok: true; state: RepairState; event: RepairEventType }
  | { ok: false; reason: RepairRejection };

/** 只能往前。已報修可直接完成，不必經過處理中。 */
const ALLOWED: Record<RepairInputType, { from: readonly RepairState[]; to: RepairState }> = {
  start: { from: ['reported'], to: 'in_progress' },
  complete: { from: ['reported', 'in_progress'], to: 'completed' },
  cancel: { from: ['reported', 'in_progress'], to: 'cancelled' },
};

/** 由目前狀態與輸入決定下一狀態與稽核事件。狀態不對先回 invalid_transition，再查完成所需欄位。 */
export function decideRepairTransition(state: RepairState, input: RepairInput): RepairTransitionResult {
  const rule = ALLOWED[input.type];
  if (!rule || !rule.from.includes(state)) return { ok: false, reason: 'invalid_transition' };

  if (input.type === 'complete') {
    const { cost, payer } = input as { cost?: unknown; payer?: unknown };
    if (cost === undefined || cost === null) return { ok: false, reason: 'cost_required' };
    if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0) {
      return { ok: false, reason: 'invalid_cost' };
    }
    if (payer === undefined || payer === null) return { ok: false, reason: 'payer_required' };
    if (!REPAIR_PAYERS.includes(payer as RepairPayer)) return { ok: false, reason: 'invalid_payer' };
  }

  return { ok: true, state: rule.to, event: `repair_${input.type}` };
}
