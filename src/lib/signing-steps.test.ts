import { describe, expect, it } from 'vitest';
import { evaluateRouting, signerChainLabels, type RoutingEvaluation } from './signature-routing';
import {
  buildSigningSteps,
  isPartyATurn,
  signerRoleOfStatus,
  signingStepDots,
  signingStepStateLabel,
  stepsShowSignerDetail,
  type SigningProgressInput,
} from './signing-steps';
import type { ContractRoutingConditions, ContractStatus, SignerRole } from './types';

// 簽署進度的步驟與目前位置（MIL-72）。純函式：輸入簽署序列與簽署進度，輸出步驟與位置。

const routing = (patch: Partial<ContractRoutingConditions> = {}): ContractRoutingConditions => ({
  businessType: 'self_managed',
  lesseeIsMasterLessor: false,
  brokerMediated: false,
  ...patch,
});

function seatsOf(r: ContractRoutingConditions, type: 'lease' | 'management' = 'lease') {
  const evaluation = evaluateRouting(r, type) as Extract<RoutingEvaluation, { ok: true }>;
  expect(evaluation.ok).toBe(true);
  return evaluation.seats;
}

const TWO = seatsOf(routing());
const MASTER = seatsOf(routing({ businessType: 'master_lease' }));
const REVERSED = seatsOf(routing({ lesseeIsMasterLessor: true }));
const FOUR = seatsOf(routing({ businessType: 'master_lease', brokerMediated: true }));

type Signed = 'signed' | 'pending' | 'declined';
function progress(
  signers: Array<[SignerRole, Signed, SignerRole[]?]>,
  status: SigningProgressInput['status'] = 'in_progress'
): SigningProgressInput {
  return {
    status,
    signers: signers.map(([role, signerStatus, concurrentRoles], i) => ({
      role,
      name: `${role}-${i}`,
      status: signerStatus,
      ...(concurrentRoles ? { concurrentRoles } : {}),
    })),
  };
}

const roles = (r: ReturnType<typeof buildSigningSteps>) => r.steps.map((s) => s.role);
const states = (r: ReturnType<typeof buildSigningSteps>) => r.steps.map((s) => s.state);

describe('buildSigningSteps：依簽署進度（2 位）', () => {
  const p = (first: Signed, second: Signed, status?: SigningProgressInput['status']) =>
    progress([['party_b', first], ['party_a', second]], status);

  it('乙方待簽：位置在第 0 步', () => {
    const r = buildSigningSteps({ status: 'awaiting_tenant', progress: p('pending', 'pending'), seats: TWO });
    expect(roles(r)).toEqual(['party_b', 'party_a']);
    expect(states(r)).toEqual(['current', 'waiting']);
    expect(r.position).toBe(0);
    expect(r.completed).toBe(false);
  });
  it('甲方待簽：乙方已簽，位置在第 1 步', () => {
    const r = buildSigningSteps({ status: 'awaiting_landlord', progress: p('signed', 'pending'), seats: TWO });
    expect(states(r)).toEqual(['signed', 'current']);
    expect(r.position).toBe(1);
  });
  it('已完成：全部已簽，位置在「完成」', () => {
    const r = buildSigningSteps({ status: 'completed', progress: p('signed', 'signed', 'completed'), seats: TWO });
    expect(states(r)).toEqual(['signed', 'signed']);
    expect(r.position).toBe(2);
    expect(r.completed).toBe(true);
  });
  it('全員簽完但完成事件還沒到：位置在「完成」，不算已完成', () => {
    const r = buildSigningSteps({ status: 'awaiting_landlord', progress: p('signed', 'signed'), seats: TWO });
    expect(r.position).toBe(2);
    expect(r.completed).toBe(false);
  });
  it('拒簽：標出拒簽的簽署人，沒有目前位置', () => {
    const r = buildSigningSteps({ status: 'declined', progress: p('declined', 'pending', 'declined'), seats: TWO });
    expect(states(r)).toEqual(['declined', 'waiting']);
    expect(r.position).toBeNull();
  });
  it('撤回：沒有目前位置', () => {
    const r = buildSigningSteps({ status: 'voided', progress: p('signed', 'pending', 'voided'), seats: TWO });
    expect(states(r)).toEqual(['signed', 'waiting']);
    expect(r.position).toBeNull();
  });
  it('步驟帶簽署人姓名、稱謂與完整稱謂', () => {
    const r = buildSigningSteps({ status: 'awaiting_tenant', progress: p('pending', 'pending'), seats: TWO });
    expect(r.steps[0]).toMatchObject({ name: 'party_b-0', label: '乙方', fullLabel: '乙方（承租人）' });
    expect(r.steps[1]).toMatchObject({ name: 'party_a-1', label: '甲方', fullLabel: '甲方（出租人）' });
  });
});

describe('buildSigningSteps：依簽署進度（3 位）', () => {
  it('包租：乙方、執業人員、甲方，目前在執業人員', () => {
    const r = buildSigningSteps({
      status: 'awaiting_practitioner',
      progress: progress([['party_b', 'signed'], ['practitioner', 'pending'], ['party_a', 'pending']]),
      seats: MASTER,
    });
    expect(roles(r)).toEqual(['party_b', 'practitioner', 'party_a']);
    expect(states(r)).toEqual(['signed', 'current', 'waiting']);
    expect(r.position).toBe(1);
    expect(r.steps[1].label).toBe('執業人員（租賃住宅管理人員）');
  });
  it('承租人是包租業者：甲方先簽', () => {
    const r = buildSigningSteps({
      status: 'awaiting_landlord',
      progress: progress([['party_a', 'pending'], ['practitioner', 'pending'], ['party_b', 'pending']]),
      seats: REVERSED,
    });
    expect(roles(r)).toEqual(['party_a', 'practitioner', 'party_b']);
    expect(r.position).toBe(0);
  });
  it('已完成：位置在「完成」', () => {
    const r = buildSigningSteps({
      status: 'completed',
      progress: progress([['party_b', 'signed'], ['practitioner', 'signed'], ['party_a', 'signed']], 'completed'),
      seats: MASTER,
    });
    expect(r.position).toBe(3);
    expect(r.completed).toBe(true);
  });
});

describe('buildSigningSteps：依簽署進度（4 位）', () => {
  const four = (signed: number): SigningProgressInput =>
    progress(
      (['party_b', 'practitioner', 'party_a', 'practitioner'] as SignerRole[]).map(
        (role, i) => [role, i < signed ? 'signed' : 'pending'] as [SignerRole, Signed]
      )
    );
  it('居間加包租：兩位執業人員靠席位區分稱謂', () => {
    const r = buildSigningSteps({ status: 'awaiting_practitioner', progress: four(3), seats: FOUR });
    expect(roles(r)).toEqual(['party_b', 'practitioner', 'party_a', 'practitioner']);
    expect(r.position).toBe(3);
    expect(r.steps[1].label).toBe(FOUR[1].label);
    expect(r.steps[3].label).toBe(FOUR[3].label);
    expect(r.steps[1].label).not.toBe(r.steps[3].label);
  });
  it('目前在第 2 位：前兩位已簽、後兩位等待', () => {
    const r = buildSigningSteps({ status: 'awaiting_landlord', progress: four(2), seats: FOUR });
    expect(states(r)).toEqual(['signed', 'signed', 'current', 'waiting']);
  });
});

describe('buildSigningSteps：同一人兼任合併後，簽署人數少於席位數', () => {
  it('席位 3、簽署人 2：兼任的簽署人標示兼任角色', () => {
    const r = buildSigningSteps({
      status: 'awaiting_practitioner',
      progress: progress([['party_b', 'signed'], ['practitioner', 'pending', ['party_a']]]),
      seats: MASTER,
    });
    expect(r.steps).toHaveLength(2);
    expect(r.steps[1]).toMatchObject({
      role: 'practitioner',
      concurrentRoles: ['party_a'],
      label: '執業人員（租賃住宅管理人員）兼甲方',
      fullLabel: '執業人員（租賃住宅管理人員）兼甲方（出租人）',
    });
    expect(r.position).toBe(1);
  });
  it('席位 4、簽署人 3：經紀人仍是最後一位，稱謂不錯位', () => {
    const r = buildSigningSteps({
      status: 'awaiting_practitioner',
      progress: progress([
        ['party_b', 'signed'],
        ['practitioner', 'signed', ['party_a']],
        ['practitioner', 'pending'],
      ]),
      seats: FOUR,
    });
    expect(r.steps).toHaveLength(3);
    expect(r.steps[1].concurrentRoles).toEqual(['party_a']);
    expect(r.steps[2].label).toBe(FOUR[3].label);
    expect(r.position).toBe(2);
  });
  it('兼任的簽署人簽完：位置往後移，簽署人數不是席位數', () => {
    const r = buildSigningSteps({
      status: 'completed',
      progress: progress([['party_b', 'signed'], ['practitioner', 'signed', ['party_a']]], 'completed'),
      seats: MASTER,
    });
    expect(r.position).toBe(2);
  });
  it('簽署人與席位對不起來時，退回角色稱謂，不錯位也不報錯', () => {
    const r = buildSigningSteps({
      status: 'awaiting_practitioner',
      progress: progress([['party_b', 'signed'], ['practitioner', 'pending']]),
      seats: MASTER,
    });
    expect(r.steps.map((s) => s.label)).toEqual(['乙方', '執業人員']);
  });
});

describe('buildSigningSteps：尚未送簽，由規則表算出的序列', () => {
  it('草稿：每個席位一步、全部等待、沒有位置', () => {
    for (const [seats, expected] of [
      [TWO, ['party_b', 'party_a']],
      [MASTER, ['party_b', 'practitioner', 'party_a']],
      [REVERSED, ['party_a', 'practitioner', 'party_b']],
      [FOUR, ['party_b', 'practitioner', 'party_a', 'practitioner']],
    ] as const) {
      const r = buildSigningSteps({ status: 'draft', seats });
      expect(roles(r)).toEqual(expected);
      expect(states(r).every((s) => s === 'waiting')).toBe(true);
      expect(r.position).toBeNull();
      expect(r.steps.every((s) => s.name === null)).toBe(true);
    }
  });
  it('指派同一人兼任：被併入的席位不單獨成步，完整稱謂與確認頁的簽署序列相同', () => {
    const merges = [{ practitionerRuleId: MASTER[1].ruleId, partyRuleId: MASTER[2].ruleId, partyRole: 'party_a' as const }];
    const r = buildSigningSteps({ status: 'draft', seats: MASTER, merges });
    expect(r.steps).toHaveLength(2);
    expect(r.steps[1].concurrentRoles).toEqual(['party_a']);
    expect(r.steps.map((s) => s.fullLabel)).toEqual(signerChainLabels(MASTER, merges));
  });
  it('沒有合併時，完整稱謂與簽署序列相同', () => {
    expect(buildSigningSteps({ status: 'draft', seats: FOUR }).steps.map((s) => s.fullLabel)).toEqual(
      signerChainLabels(FOUR, [])
    );
  });
});

describe('buildSigningSteps：沒有簽署任務的舊合約', () => {
  it('依合約狀態找位置，沒有序列時退回兩方', () => {
    const r = buildSigningSteps({ status: 'awaiting_landlord' });
    expect(roles(r)).toEqual(['party_b', 'party_a']);
    expect(states(r)).toEqual(['signed', 'current']);
    expect(r.position).toBe(1);
  });
  it('已完成：全部已簽、位置在「完成」', () => {
    const r = buildSigningSteps({ status: 'completed', seats: TWO });
    expect(states(r)).toEqual(['signed', 'signed']);
    expect(r.position).toBe(2);
    expect(r.completed).toBe(true);
  });
  it('有序列時照序列：甲方先簽的舊合約待乙方簽，甲方已簽', () => {
    const r = buildSigningSteps({ status: 'awaiting_tenant', seats: REVERSED });
    expect(states(r)).toEqual(['signed', 'signed', 'current']);
    expect(r.position).toBe(2);
  });
  it('狀態對應的角色不在序列裡：沒有位置，不報錯', () => {
    const r = buildSigningSteps({ status: 'awaiting_practitioner', seats: TWO });
    expect(roles(r)).toEqual(['party_b', 'party_a']);
    expect(r.position).toBeNull();
  });
  it('簽署進度沒有簽署人（空陣列）時當作沒有簽署任務', () => {
    const r = buildSigningSteps({ status: 'awaiting_tenant', progress: progress([]), seats: TWO });
    expect(states(r)).toEqual(['current', 'waiting']);
  });
  it('草稿、拒簽、撤回沒有位置', () => {
    for (const status of ['draft', 'declined', 'voided'] as ContractStatus[]) {
      expect(buildSigningSteps({ status, seats: TWO }).position).toBeNull();
    }
  });
});

describe('buildSigningSteps：稱謂依合約類型', () => {
  it('委託管理合約的甲乙方是委託人、受託人', () => {
    const seats = seatsOf({ businessType: 'managed', lesseeIsMasterLessor: false, brokerMediated: false }, 'management');
    const r = buildSigningSteps({ status: 'draft', seats, contractType: 'management' });
    expect(r.steps.map((s) => s.fullLabel)).toEqual(['甲方（委託人）', seats[1].label, '乙方（受託人）']);
    // 沒有席位時，稱謂也依合約類型
    const fallback = buildSigningSteps({ status: 'awaiting_tenant', contractType: 'management' });
    expect(fallback.steps.map((s) => s.fullLabel)).toEqual(['乙方（受託人）', '甲方（委託人）']);
  });
});

describe('signerRoleOfStatus', () => {
  it('合約狀態對應當前簽署人的角色（ADR-0010）', () => {
    expect(signerRoleOfStatus('awaiting_tenant')).toBe('party_b');
    expect(signerRoleOfStatus('awaiting_landlord')).toBe('party_a');
    expect(signerRoleOfStatus('awaiting_practitioner')).toBe('practitioner');
    expect(signerRoleOfStatus('draft')).toBeNull();
    expect(signerRoleOfStatus('completed')).toBeNull();
  });
});

describe('isPartyATurn：球在甲方手上（工作台的待辦）', () => {
  it('甲方待簽時是', () => {
    const p = progress([['party_b', 'signed'], ['party_a', 'pending']]);
    expect(isPartyATurn('awaiting_landlord', p)).toBe(true);
  });
  it('乙方待簽時不是', () => {
    expect(isPartyATurn('awaiting_tenant', progress([['party_b', 'pending'], ['party_a', 'pending']]))).toBe(false);
  });
  it('輪到執業人員或經紀人時不是，球不在甲方手上', () => {
    const p = progress([['party_b', 'signed'], ['practitioner', 'pending'], ['party_a', 'pending']]);
    expect(isPartyATurn('awaiting_practitioner', p)).toBe(false);
    const broker = progress([
      ['party_b', 'signed'],
      ['practitioner', 'signed'],
      ['party_a', 'signed'],
      ['practitioner', 'pending'],
    ]);
    expect(isPartyATurn('awaiting_practitioner', broker)).toBe(false);
  });
  it('甲方先簽的序列：一開始就輪到甲方，簽完後輪到執業人員就不是', () => {
    const start = progress([['party_a', 'pending'], ['practitioner', 'pending'], ['party_b', 'pending']]);
    expect(isPartyATurn('awaiting_landlord', start)).toBe(true);
    const next = progress([['party_a', 'signed'], ['practitioner', 'pending'], ['party_b', 'pending']]);
    expect(isPartyATurn('awaiting_practitioner', next)).toBe(false);
  });
  it('兼任甲方的簽署人輪到時是：合併不改變輪到誰', () => {
    const p = progress([['party_b', 'signed'], ['practitioner', 'pending', ['party_a']]]);
    expect(isPartyATurn('awaiting_practitioner', p)).toBe(true);
  });
  it('沒有簽署任務的舊合約依合約狀態', () => {
    expect(isPartyATurn('awaiting_landlord', null)).toBe(true);
    expect(isPartyATurn('awaiting_tenant', null)).toBe(false);
    expect(isPartyATurn('awaiting_practitioner', null)).toBe(false);
  });
  it('不在簽署中的狀態不是', () => {
    expect(isPartyATurn('draft', null)).toBe(false);
    expect(isPartyATurn('completed', progress([['party_a', 'signed']], 'completed'))).toBe(false);
  });
});

describe('signingStepDots：清單的進度點', () => {
  const dots = (r: ReturnType<typeof buildSigningSteps>) => signingStepDots(r)?.map((d) => `${d.label}:${d.state}`);
  it('兩方：乙方簽、甲方簽、完成', () => {
    expect(dots(buildSigningSteps({ status: 'awaiting_landlord', seats: TWO }))).toEqual([
      '乙方簽:done',
      '甲方簽:current',
      '完成:pending',
    ]);
  });
  it('已完成：全部點亮，包含「完成」', () => {
    expect(dots(buildSigningSteps({ status: 'completed', seats: TWO }))).toEqual(['乙方簽:done', '甲方簽:done', '完成:done']);
  });
  it('兼任的簽署人一點，標示兼任', () => {
    const r = buildSigningSteps({
      status: 'awaiting_practitioner',
      progress: progress([['party_b', 'signed'], ['practitioner', 'pending', ['party_a']]]),
      seats: MASTER,
    });
    expect(dots(r)).toEqual(['乙方簽:done', '執業人員（租賃住宅管理人員）兼甲方簽:current', '完成:pending']);
  });
  it('不在簽署流程的狀態沒有進度點', () => {
    expect(signingStepDots(buildSigningSteps({ status: 'draft', seats: TWO }))).toBeNull();
    expect(signingStepDots(buildSigningSteps({ status: 'declined', seats: TWO }))).toBeNull();
  });
});

describe('詳情頁的簽署人明細', () => {
  it('兩方合約不加明細，畫面維持原樣；三位以上或有兼任才加', () => {
    expect(stepsShowSignerDetail(buildSigningSteps({ status: 'awaiting_tenant', seats: TWO }))).toBe(false);
    expect(stepsShowSignerDetail(buildSigningSteps({ status: 'awaiting_tenant', seats: MASTER }))).toBe(true);
    const merged = buildSigningSteps({
      status: 'awaiting_practitioner',
      progress: progress([['party_b', 'signed'], ['practitioner', 'pending', ['party_a']]]),
      seats: MASTER,
    });
    expect(stepsShowSignerDetail(merged)).toBe(true);
  });
  it('狀態文字', () => {
    expect(signingStepStateLabel('signed')).toBe('已簽署');
    expect(signingStepStateLabel('current')).toBe('待簽署');
    expect(signingStepStateLabel('waiting')).toBe('尚未輪到');
    expect(signingStepStateLabel('declined')).toBe('已拒簽');
  });
});
