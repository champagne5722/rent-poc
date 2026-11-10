import { describe, expect, it } from 'vitest';
import { LEASE_CASE_STATES, MANAGEMENT_CASE_STATES, type CaseState } from './cases';
import { caseNextStep } from './case-next-step';

const ALL_STATES = [...new Set<CaseState>([...LEASE_CASE_STATES, ...MANAGEMENT_CASE_STATES])];

describe('caseNextStep', () => {
  it('每個案件狀態、主辦與非主辦都有下一步文字與負責人', () => {
    for (const state of ALL_STATES) {
      for (const isHost of [true, false]) {
        const step = caseNextStep({ state, isHost, hasCurrentContract: true });
        expect(step.headline.length, `${state} ${isHost}`).toBeGreaterThan(0);
        expect(step.owner.length, `${state} ${isHost}`).toBeGreaterThan(0);
      }
    }
  });

  it('主辦組織的簽署中案件：下一步在合約頁，有連結', () => {
    const step = caseNextStep({ state: 'signing', isHost: true, hasCurrentContract: true });
    expect(step.headline).toContain('簽署');
    expect(step.linkToContract).toBe(true);
  });

  it('沒有目前合約時不放合約連結', () => {
    expect(caseNextStep({ state: 'signing', isHost: true, hasCurrentContract: false }).linkToContract).toBe(false);
  });

  it('別組織的成員沒有合約連結', () => {
    for (const state of ALL_STATES) {
      expect(caseNextStep({ state, isHost: false, hasCurrentContract: true }).linkToContract, state).toBe(false);
    }
  });

  it('結束的案件寫明沒有待辦事項', () => {
    for (const state of ['closed', 'aborted', 'terminated'] as const) {
      expect(caseNextStep({ state, isHost: true, hasCurrentContract: true }).detail, state).toContain('沒有待辦事項');
    }
  });
});
