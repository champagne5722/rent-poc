import { describe, expect, it } from 'vitest';
import { detailSigningSteps, mockAdvanceActions } from './contract-detail';
import type { SignerRecord } from './signing-module/sign-task-store';
import type { ContractStatus, SignerRole } from './types';

// 詳情頁依實際的簽署序列畫步驟與模擬按鈕（MIL-69）。清單、工作台與確認頁的進度屬 MIL-72。

function progress(roles: SignerRole[], signed: number) {
  const signers: SignerRecord[] = roles.map((role, i) => ({
    role,
    name: `${role}-name`,
    email: `${role}@example.com`,
    status: i < signed ? 'signed' : 'pending',
    signedAt: null,
  }));
  return { signers };
}

const MASTER: SignerRole[] = ['party_b', 'practitioner', 'party_a'];
const REVERSED: SignerRole[] = ['party_a', 'practitioner', 'party_b'];
const TWO_PARTY: SignerRole[] = ['party_b', 'party_a'];

describe('detailSigningSteps 依簽署進度', () => {
  it('包租：乙方、執業人員、甲方，目前在執業人員', () => {
    expect(detailSigningSteps('awaiting_practitioner', progress(MASTER, 1))).toEqual({
      titles: ['待乙方（租客）簽署', '待執業人員簽署', '待甲方（房東）簽署', '完成'],
      current: 1,
    });
  });
  it('自管且承租人是包租業者：甲方先簽', () => {
    expect(detailSigningSteps('awaiting_landlord', progress(REVERSED, 0))).toEqual({
      titles: ['待甲方（房東）簽署', '待執業人員簽署', '待乙方（租客）簽署', '完成'],
      current: 0,
    });
    expect(detailSigningSteps('awaiting_tenant', progress(REVERSED, 2)).current).toBe(2);
  });
  it('全員簽完（已完成）：停在最後一步', () => {
    expect(detailSigningSteps('completed', progress(MASTER, 3)).current).toBe(3);
  });
  it('兩方合約與沒有簽署進度時，和原本相同', () => {
    for (const status of ['awaiting_tenant', 'awaiting_landlord', 'completed'] as ContractStatus[]) {
      const withoutProgress = detailSigningSteps(status);
      expect(withoutProgress.titles).toEqual(['待乙方（租客）簽署', '待甲方（房東）簽署', '完成']);
    }
    expect(detailSigningSteps('awaiting_landlord', progress(TWO_PARTY, 1))).toEqual(detailSigningSteps('awaiting_landlord'));
    expect(detailSigningSteps('awaiting_tenant', progress(TWO_PARTY, 0))).toEqual(detailSigningSteps('awaiting_tenant'));
  });
});

describe('mockAdvanceActions：mock 模式的模擬按鈕依當前簽署人', () => {
  const labels = (status: ContractStatus, p: ReturnType<typeof progress> | null) =>
    mockAdvanceActions(status, p).map((a) => [a.event, a.label]);

  it('兩方合約維持原本的按鈕', () => {
    expect(labels('awaiting_tenant', progress(TWO_PARTY, 0))).toEqual([
      ['signed', '模擬乙方簽署'],
      ['declined', '模擬乙方拒簽'],
    ]);
    expect(labels('awaiting_landlord', progress(TWO_PARTY, 1))).toEqual([['completed', '模擬甲方簽署完成']]);
  });
  it('沒有簽署進度時依合約狀態，與原本相同', () => {
    expect(labels('awaiting_tenant', null)).toEqual([
      ['signed', '模擬乙方簽署'],
      ['declined', '模擬乙方拒簽'],
    ]);
    expect(labels('awaiting_practitioner', null)).toEqual([
      ['signed', '模擬執業人員簽署'],
      ['declined', '模擬執業人員拒簽'],
    ]);
    expect(labels('awaiting_landlord', null)).toEqual([['completed', '模擬甲方簽署完成']]);
  });
  it('包租：執業人員不是最後一位，簽署後輪到甲方', () => {
    expect(labels('awaiting_practitioner', progress(MASTER, 1))).toEqual([
      ['signed', '模擬執業人員簽署'],
      ['declined', '模擬執業人員拒簽'],
    ]);
  });
  it('甲方先簽的序列：甲方不是最後一位，按鈕是簽署而不是完成', () => {
    expect(labels('awaiting_landlord', progress(REVERSED, 0))).toEqual([
      ['signed', '模擬甲方簽署'],
      ['declined', '模擬甲方拒簽'],
    ]);
    expect(labels('awaiting_tenant', progress(REVERSED, 2))).toEqual([
      ['completed', '模擬乙方簽署完成'],
      ['declined', '模擬乙方拒簽'],
    ]);
  });
  it('不在簽署中的狀態沒有按鈕', () => {
    expect(labels('completed', progress(MASTER, 3))).toEqual([]);
    expect(labels('draft', null)).toEqual([]);
  });
});
