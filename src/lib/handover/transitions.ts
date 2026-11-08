// 移交的狀態轉移（MIL-94「狀態與協調」、ADR-0024 決議 8）。
// 純函式，沒有 I/O，寫法沿用 src/lib/transitions.ts 的 decideTransition。

export const HANDOVER_STATES = [
  'draft',
  'owner_confirmed',
  'accepted',
  'released',
  'completed',
  'cancelled',
] as const;

export type HandoverState = (typeof HANDOVER_STATES)[number];

// owner_confirm：屋主確認。accept：接收方確認接手（改自管時由屋主一起做）。
// release：交出側交易已提交。receive：接收側交易已提交。cancel：取消。
export const HANDOVER_INPUTS = ['owner_confirm', 'accept', 'release', 'receive', 'cancel'] as const;

export type HandoverInput = (typeof HANDOVER_INPUTS)[number];

/** 稽核事件型別，與輸入一對一。 */
export type HandoverEventType = `handover_${HandoverInput}`;

export interface HandoverTransitionDecision {
  state: HandoverState;
  event: HandoverEventType;
}

const NEXT: Record<Exclude<HandoverInput, 'cancel'>, { from: HandoverState; to: HandoverState }> = {
  owner_confirm: { from: 'draft', to: 'owner_confirmed' },
  accept: { from: 'owner_confirmed', to: 'accepted' },
  release: { from: 'accepted', to: 'released' },
  receive: { from: 'released', to: 'completed' },
};

/** `released` 之前任一步都能取消。交出側提交後不得取消，只能重試接收側。 */
const CANCELLABLE: readonly HandoverState[] = ['draft', 'owner_confirmed', 'accepted'];

/** 由目前狀態與輸入決定下一狀態與稽核事件。不接受時回傳 null。 */
export function decideHandoverTransition(
  state: HandoverState,
  input: HandoverInput,
): HandoverTransitionDecision | null {
  if (input === 'cancel') {
    return CANCELLABLE.includes(state) ? { state: 'cancelled', event: 'handover_cancel' } : null;
  }
  const rule = NEXT[input];
  return state === rule.from ? { state: rule.to, event: `handover_${input}` } : null;
}

export function isCancellable(state: HandoverState): boolean {
  return decideHandoverTransition(state, 'cancel') !== null;
}

/** 畫面要分別顯示交出側與接收側是否完成（ADR-0015 後果段、ADR-0024 決議 8）。 */
export interface HandoverSides {
  released: boolean;
  received: boolean;
}

/** 進行中：還沒完成也沒取消。同一租賃單位同時只能有一個進行中的移交。 */
export function isOpenHandover(state: HandoverState): boolean {
  return state !== 'completed' && state !== 'cancelled';
}

export function handoverSides(state: HandoverState): HandoverSides {
  return {
    released: state === 'released' || state === 'completed',
    received: state === 'completed',
  };
}
