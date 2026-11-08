import { describe, expect, it } from 'vitest';
import {
  HANDOVER_RECORD_INPUT_TYPES,
  HANDOVER_RECORD_STATES,
  decideHandoverRecordTransition,
  handoverConfirmations,
  type HandoverRecordInputType,
  type HandoverRecordRejection,
  type HandoverRecordState,
} from './handover-record';

type Expected = HandoverRecordState | HandoverRecordRejection;

// 全矩陣：每個狀態乘每個輸入。值是下一狀態，或拒絕原因（ADR-0051 決議 3）。
// edit_content 指修改照片、度數或逐列狀態。add_supplement 指新增補充紀錄，狀態不變。
const EXPECTED: Record<HandoverRecordState, Record<HandoverRecordInputType, Expected>> = {
  draft: {
    submit: 'pending_lessee_confirmation',
    lessee_confirm: 'invalid_transition',
    edit_content: 'draft',
    add_supplement: 'invalid_transition',
  },
  pending_lessee_confirmation: {
    submit: 'invalid_transition',
    lessee_confirm: 'confirmed',
    edit_content: 'immutable_use_supplement',
    add_supplement: 'pending_lessee_confirmation',
  },
  confirmed: {
    submit: 'invalid_transition',
    lessee_confirm: 'invalid_transition',
    edit_content: 'immutable_use_supplement',
    add_supplement: 'confirmed',
  },
};

const CASES = HANDOVER_RECORD_STATES.flatMap((state) =>
  HANDOVER_RECORD_INPUT_TYPES.map((type) => [state, type, EXPECTED[state][type]] as const),
);

const isState = (value: Expected): value is HandoverRecordState =>
  (HANDOVER_RECORD_STATES as readonly string[]).includes(value);

describe('decideHandoverRecordTransition（狀態乘輸入的全矩陣）', () => {
  it.each(CASES)('%s 收到 %s → %s', (state, type, expected) => {
    const decision = decideHandoverRecordTransition(state, { type });
    if (isState(expected)) {
      expect(decision).toEqual({ ok: true, state: expected, event: `handover_record_${type}` });
    } else {
      expect(decision).toEqual({ ok: false, reason: expected });
    }
  });

  it('不認得的狀態或輸入一律拒絕', () => {
    expect(decideHandoverRecordTransition('foo' as HandoverRecordState, { type: 'submit' })).toEqual({
      ok: false,
      reason: 'invalid_transition',
    });
    expect(decideHandoverRecordTransition('draft', { type: 'reject' as never })).toEqual({
      ok: false,
      reason: 'invalid_transition',
    });
  });

  it('沒有拒絕狀態：承租人不同意時只能走補充紀錄', () => {
    expect(HANDOVER_RECORD_STATES).toEqual(['draft', 'pending_lessee_confirmation', 'confirmed']);
  });
});

describe('handoverConfirmations（誰已確認）', () => {
  it.each([
    ['draft', false, false],
    ['pending_lessee_confirmation', true, false],
    ['confirmed', true, true],
  ] as const)('%s：出租方 %s、承租人 %s', (state, lessor, lessee) => {
    expect(handoverConfirmations(state)).toEqual({ lessor, lessee });
  });
});
