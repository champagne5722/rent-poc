import { describe, expect, it } from 'vitest';
import { evaluateRouting, signerChainLabels } from './seats';
import type { ContractRoutingConditions } from '../types';

// 合併後的簽署序列說明（MIL-76）。畫面的確認頁用它列出實際的簽署人。

const routing = (patch: Partial<ContractRoutingConditions> = {}): ContractRoutingConditions => ({
  businessType: 'master_lease',
  lesseeIsMasterLessor: false,
  brokerMediated: false,
  ...patch,
});

function seatsOf(r: ContractRoutingConditions) {
  const evaluation = evaluateRouting(r);
  if (!evaluation.ok) throw new Error(evaluation.reason);
  return evaluation.seats;
}

describe('signerChainLabels', () => {
  it('沒有合併：一個席位一位簽署人，順序與簽署序列相同', () => {
    expect(signerChainLabels(seatsOf(routing()), [])).toEqual([
      '乙方（承租人）',
      '執業人員（租賃住宅管理人員）',
      '甲方（出租人）',
    ]);
  });

  it('合併：兼任的當事人席位併入執業人員，標示兼任角色', () => {
    const merges = [{ practitionerRuleId: 'lease.master_lease.practitioner', partyRuleId: 'lease.master_lease.party_a' }];
    expect(signerChainLabels(seatsOf(routing()), merges)).toEqual([
      '乙方（承租人）',
      '執業人員（租賃住宅管理人員）兼甲方（出租人）',
    ]);
  });

  it('居間加包租：四位；合併後三位，經紀人仍排在最後', () => {
    const seats = seatsOf(routing({ brokerMediated: true }));
    expect(signerChainLabels(seats, [])).toEqual([
      '乙方（承租人）',
      '執業人員（租賃住宅管理人員）',
      '甲方（出租人）',
      '執業人員（不動產經紀人）',
    ]);
    const merges = [{ practitionerRuleId: 'lease.master_lease.practitioner', partyRuleId: 'lease.master_lease.party_a' }];
    expect(signerChainLabels(seats, merges)).toEqual([
      '乙方（承租人）',
      '執業人員（租賃住宅管理人員）兼甲方（出租人）',
      '執業人員（不動產經紀人）',
    ]);
  });
});
