import { describe, expect, it } from 'vitest';
import { decideCaseTransition, type LeaseCaseSnapshot } from './transitions';

const NOW = new Date('2026-11-08T02:00:00Z');

function lease(overrides: Partial<LeaseCaseSnapshot> = {}): LeaseCaseSnapshot {
  return {
    kind: 'lease',
    id: 'case-1',
    state: 'draft',
    stateVersion: 3,
    businessType: 'self_managed',
    currentContractId: 'contract-1',
    ...overrides,
  };
}

describe('decideCaseTransition：租賃案件', () => {
  it('合約送簽：draft 進 signing，記 contract_sent', () => {
    expect(decideCaseTransition(lease(), { type: 'contract_sent', contractId: 'contract-1' }, NOW)).toEqual({
      state: 'signing',
      event: { type: 'contract_sent', occurredAt: '2026-11-08T02:00:00.000Z', payload: { contractId: 'contract-1' } },
      outbox: [],
    });
  });
});
