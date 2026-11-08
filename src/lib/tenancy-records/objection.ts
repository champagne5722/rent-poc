// 扣抵異議的狀態轉移（MIL-141、ADR-0051 決議 9、GLOSSARY「扣抵異議」）。
// 純函式，沒有 I/O。異議不改分錄，也不由平台判定。
// 狀態只有無、有異議、已撤回。出租方不得改為已解決，要處理時沖銷扣抵並重新登錄（新扣抵從「無」開始）。
// 只有承租人能標示與撤回，這個權限由呼叫端的 withCaseMemberTx 檢查。

export const OBJECTION_STATES = ['none', 'objected', 'withdrawn'] as const;
export type ObjectionState = (typeof OBJECTION_STATES)[number];

// raise：承租人標示異議，必須有說明。withdraw：承租人撤回。
// resolve：出租方想改為已解決。這個輸入存在只是為了明確拒絕。
export const OBJECTION_INPUT_TYPES = ['raise', 'withdraw', 'resolve'] as const;
export type ObjectionInputType = (typeof OBJECTION_INPUT_TYPES)[number];

export type ObjectionInput = { type: 'raise'; note: string } | { type: 'withdraw' } | { type: 'resolve' };

/** 稽核事件型別，與輸入一對一。 */
export type ObjectionEventType = `objection_${ObjectionInputType}`;

export type ObjectionRejection = 'invalid_transition' | 'note_required' | 'lessor_cannot_resolve';

export type ObjectionTransitionResult =
  | { ok: true; state: ObjectionState; event: ObjectionEventType }
  | { ok: false; reason: ObjectionRejection };

// 已撤回後得再標示異議（仍須填說明）。
const NEXT: Record<'raise' | 'withdraw', { from: readonly ObjectionState[]; to: ObjectionState }> = {
  raise: { from: ['none', 'withdrawn'], to: 'objected' },
  withdraw: { from: ['objected'], to: 'withdrawn' },
};

export function decideObjectionTransition(state: ObjectionState, input: ObjectionInput): ObjectionTransitionResult {
  if (!OBJECTION_STATES.includes(state)) return { ok: false, reason: 'invalid_transition' };
  if (input.type === 'resolve') return { ok: false, reason: 'lessor_cannot_resolve' };

  const rule = NEXT[input.type];
  if (!rule || !rule.from.includes(state)) return { ok: false, reason: 'invalid_transition' };

  if (input.type === 'raise') {
    const note = (input as { note?: unknown }).note;
    if (typeof note !== 'string' || note.trim() === '') return { ok: false, reason: 'note_required' };
  }

  return { ok: true, state: rule.to, event: `objection_${input.type}` };
}
