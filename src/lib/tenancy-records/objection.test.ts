import { describe, expect, it } from 'vitest';
import {
  OBJECTION_INPUT_TYPES,
  OBJECTION_STATES,
  decideObjectionTransition,
  type ObjectionInput,
  type ObjectionInputType,
  type ObjectionRejection,
  type ObjectionState,
} from './objection';

type Expected = ObjectionState | ObjectionRejection;

function input(type: ObjectionInputType): ObjectionInput {
  return type === 'raise' ? { type, note: '冷氣清潔費過高' } : { type };
}

// 全矩陣：每個狀態乘每個輸入（ADR-0051 決議 9）。
// resolve 是出租方想把異議改為已解決。沒有已解決狀態，任何狀態都拒絕。
const EXPECTED: Record<ObjectionState, Record<ObjectionInputType, Expected>> = {
  none: { raise: 'objected', withdraw: 'invalid_transition', resolve: 'lessor_cannot_resolve' },
  objected: { raise: 'invalid_transition', withdraw: 'withdrawn', resolve: 'lessor_cannot_resolve' },
  withdrawn: { raise: 'objected', withdraw: 'invalid_transition', resolve: 'lessor_cannot_resolve' },
};

const CASES = OBJECTION_STATES.flatMap((state) =>
  OBJECTION_INPUT_TYPES.map((type) => [state, type, EXPECTED[state][type]] as const),
);

const isState = (value: Expected): value is ObjectionState =>
  (OBJECTION_STATES as readonly string[]).includes(value);

describe('decideObjectionTransition（狀態乘輸入的全矩陣）', () => {
  it.each(CASES)('%s 收到 %s → %s', (state, type, expected) => {
    const decision = decideObjectionTransition(state, input(type));
    if (isState(expected)) {
      expect(decision).toEqual({ ok: true, state: expected, event: `objection_${type}` });
    } else {
      expect(decision).toEqual({ ok: false, reason: expected });
    }
  });

  it('沒有已解決狀態', () => {
    expect(OBJECTION_STATES).toEqual(['none', 'objected', 'withdrawn']);
  });

  it('不認得的狀態或輸入一律拒絕', () => {
    expect(decideObjectionTransition('foo' as ObjectionState, input('raise'))).toEqual({
      ok: false,
      reason: 'invalid_transition',
    });
    expect(decideObjectionTransition('none', { type: 'foo' } as never)).toEqual({
      ok: false,
      reason: 'invalid_transition',
    });
  });
});

describe('標示異議必須有說明', () => {
  it.each<ObjectionState>(['none', 'withdrawn'])('%s：說明空白被拒絕', (state) => {
    expect(decideObjectionTransition(state, { type: 'raise', note: '' })).toEqual({
      ok: false,
      reason: 'note_required',
    });
    expect(decideObjectionTransition(state, { type: 'raise', note: '  \n\t ' })).toEqual({
      ok: false,
      reason: 'note_required',
    });
  });

  it('沒帶說明被拒絕', () => {
    expect(decideObjectionTransition('none', { type: 'raise' } as never)).toEqual({
      ok: false,
      reason: 'note_required',
    });
  });

  it('說明不是字串被拒絕', () => {
    expect(decideObjectionTransition('none', { type: 'raise', note: 5 } as never)).toEqual({
      ok: false,
      reason: 'note_required',
    });
  });

  it('已撤回後再標示異議仍須填說明', () => {
    expect(decideObjectionTransition('withdrawn', { type: 'raise', note: '' })).toEqual({
      ok: false,
      reason: 'note_required',
    });
    expect(decideObjectionTransition('withdrawn', { type: 'raise', note: '仍不同意' })).toEqual({
      ok: true,
      state: 'objected',
      event: 'objection_raise',
    });
  });

  it('狀態錯誤優先於說明檢查', () => {
    expect(decideObjectionTransition('objected', { type: 'raise', note: '' })).toEqual({
      ok: false,
      reason: 'invalid_transition',
    });
  });
});
