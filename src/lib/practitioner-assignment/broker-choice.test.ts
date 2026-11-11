import { describe, expect, it } from 'vitest';
import { BROKERAGE_BLOCKED_REASON, brokerChoiceOf } from './broker-choice';

describe('brokerChoiceOf：居間選項的可選狀態（MIL-200）', () => {
  it('執業主體組織沒有登錄經紀業別：不顯示', () => {
    expect(brokerChoiceOf('practice', null)).toEqual({ kind: 'hidden' });
  });

  it('執業主體組織登錄了經紀業別但還沒驗證：顯示成不能選，並寫出原因', () => {
    expect(brokerChoiceOf('practice', 'registered')).toEqual({ kind: 'blocked', reason: BROKERAGE_BLOCKED_REASON });
    expect(BROKERAGE_BLOCKED_REASON).toBe('經紀業別驗證後才能勾選');
  });

  it('執業主體組織的經紀業別已驗證：能選', () => {
    expect(brokerChoiceOf('practice', 'verified')).toEqual({ kind: 'allowed' });
  });

  it.each(['owner', 'platform'] as const)('%s 組織不論登錄狀態，一律不顯示，也不提示', (orgKind) => {
    for (const state of ['verified', 'registered', null] as const) {
      expect(brokerChoiceOf(orgKind, state), `${orgKind} / ${String(state)}`).toEqual({ kind: 'hidden' });
    }
  });
});
