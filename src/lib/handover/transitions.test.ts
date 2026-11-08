import { describe, expect, it } from 'vitest';
import {
  HANDOVER_INPUTS,
  HANDOVER_STATES,
  decideHandoverTransition,
  handoverSides,
  type HandoverInput,
  type HandoverState,
} from './transitions';

// 全矩陣：每個狀態乘每個輸入的期望下一狀態，null 表示不接受（ADR-0024 決議 8）。
const EXPECTED: Record<HandoverState, Record<HandoverInput, HandoverState | null>> = {
  draft: { owner_confirm: 'owner_confirmed', accept: null, release: null, receive: null, cancel: 'cancelled' },
  owner_confirmed: { owner_confirm: null, accept: 'accepted', release: null, receive: null, cancel: 'cancelled' },
  accepted: { owner_confirm: null, accept: null, release: 'released', receive: null, cancel: 'cancelled' },
  released: { owner_confirm: null, accept: null, release: null, receive: 'completed', cancel: null },
  completed: { owner_confirm: null, accept: null, release: null, receive: null, cancel: null },
  cancelled: { owner_confirm: null, accept: null, release: null, receive: null, cancel: null },
};

const CASES = HANDOVER_STATES.flatMap((state) =>
  HANDOVER_INPUTS.map((input) => [state, input, EXPECTED[state][input]] as const),
);

describe('decideHandoverTransition（狀態乘輸入的全矩陣）', () => {
  it.each(CASES)('%s 收到 %s → %s', (state, input, next) => {
    const decision = decideHandoverTransition(state, input);
    if (next === null) {
      expect(decision).toBeNull();
    } else {
      expect(decision).toEqual({ state: next, event: `handover_${input}` });
    }
  });

  it('released 之後不得取消，只能等接收側完成', () => {
    expect(decideHandoverTransition('released', 'cancel')).toBeNull();
    expect(decideHandoverTransition('completed', 'cancel')).toBeNull();
  });
});

describe('handoverSides（兩側是否完成）', () => {
  it.each([
    ['draft', false, false],
    ['owner_confirmed', false, false],
    ['accepted', false, false],
    ['released', true, false],
    ['completed', true, true],
    ['cancelled', false, false],
  ] as const)('%s：交出側 %s、接收側 %s', (state, released, received) => {
    expect(handoverSides(state)).toEqual({ released, received });
  });
});
