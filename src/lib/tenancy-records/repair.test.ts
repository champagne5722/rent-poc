import { describe, expect, it } from 'vitest';
import {
  REPAIR_INPUT_TYPES,
  REPAIR_PAYERS,
  REPAIR_STATES,
  decideRepairTransition,
  type RepairInput,
  type RepairInputType,
  type RepairState,
} from './repair';

const FULL = { cost: 1200, payer: 'lessor' } as const;

function input(type: RepairInputType): RepairInput {
  return type === 'complete' ? { type, ...FULL } : { type };
}

// 全矩陣：每個狀態乘每個輸入的期望下一狀態，null 表示拒絕（ADR-0051 決議 10）。
// 「已報修」可直接改「已完成」（只能往前不等於逐步）。
const EXPECTED: Record<RepairState, Record<RepairInputType, RepairState | null>> = {
  reported: { start: 'in_progress', complete: 'completed', cancel: 'cancelled' },
  in_progress: { start: null, complete: 'completed', cancel: 'cancelled' },
  completed: { start: null, complete: null, cancel: null },
  cancelled: { start: null, complete: null, cancel: null },
};

const CASES = REPAIR_STATES.flatMap((state) =>
  REPAIR_INPUT_TYPES.map((type) => [state, type, EXPECTED[state][type]] as const),
);

describe('decideRepairTransition（狀態乘輸入的全矩陣）', () => {
  it.each(CASES)('%s 收到 %s → %s', (state, type, next) => {
    const decision = decideRepairTransition(state, input(type));
    if (next === null) {
      expect(decision).toEqual({ ok: false, reason: 'invalid_transition' });
    } else {
      expect(decision).toEqual({ ok: true, state: next, event: `repair_${type}` });
    }
  });

  it('不認得的狀態一律拒絕', () => {
    expect(decideRepairTransition('foo' as RepairState, input('cancel'))).toEqual({
      ok: false,
      reason: 'invalid_transition',
    });
  });
});

describe('改為已完成必須有費用與付款方', () => {
  const from: RepairState[] = ['reported', 'in_progress'];

  it.each(from)('%s：缺費用被拒絕', (state) => {
    const decision = decideRepairTransition(state, { type: 'complete', payer: 'lessor' } as RepairInput);
    expect(decision).toEqual({ ok: false, reason: 'cost_required' });
  });

  it.each(from)('%s：缺付款方被拒絕', (state) => {
    const decision = decideRepairTransition(state, { type: 'complete', cost: 100 } as RepairInput);
    expect(decision).toEqual({ ok: false, reason: 'payer_required' });
  });

  it.each(from)('%s：費用與付款方都缺時先回費用', (state) => {
    expect(decideRepairTransition(state, { type: 'complete' } as RepairInput)).toEqual({
      ok: false,
      reason: 'cost_required',
    });
  });

  it('null 視同沒填', () => {
    expect(decideRepairTransition('in_progress', { type: 'complete', cost: null, payer: 'lessor' } as never)).toEqual({
      ok: false,
      reason: 'cost_required',
    });
    expect(decideRepairTransition('in_progress', { type: 'complete', cost: 0, payer: null } as never)).toEqual({
      ok: false,
      reason: 'payer_required',
    });
  });

  it('費用 0 合法', () => {
    expect(decideRepairTransition('in_progress', { type: 'complete', cost: 0, payer: 'owner' })).toEqual({
      ok: true,
      state: 'completed',
      event: 'repair_complete',
    });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '100' as unknown as number])(
    '費用 %s 不是非負整數元，被拒絕',
    (cost) => {
      expect(decideRepairTransition('in_progress', { type: 'complete', cost, payer: 'lessor' })).toEqual({
        ok: false,
        reason: 'invalid_cost',
      });
    },
  );

  it.each(REPAIR_PAYERS)('付款方 %s 合法', (payer) => {
    expect(decideRepairTransition('in_progress', { type: 'complete', cost: 10, payer }).ok).toBe(true);
  });

  it('付款方不在清單內被拒絕', () => {
    expect(decideRepairTransition('in_progress', { type: 'complete', cost: 10, payer: 'tenant' as never })).toEqual({
      ok: false,
      reason: 'invalid_payer',
    });
  });

  it('已完成與已取消的狀態錯誤優先於欄位檢查', () => {
    expect(decideRepairTransition('completed', { type: 'complete' } as RepairInput)).toEqual({
      ok: false,
      reason: 'invalid_transition',
    });
  });
});
