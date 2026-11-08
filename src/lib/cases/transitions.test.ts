import { describe, expect, it } from 'vitest';
import {
  BUSINESS_TYPES,
  LEASE_CASE_STATES,
  MANAGEMENT_CASE_STATES,
  decideCaseTransition,
  taiwanDate,
  type CaseInput,
  type CaseInputType,
  type LeaseCaseSnapshot,
  type LeaseCaseState,
  type ManagementCaseSnapshot,
  type ManagementCaseState,
} from './transitions';

const NOW = new Date('2026-11-08T02:00:00Z'); // 台灣時間 2026-11-08 10:00
const NOW_ISO = '2026-11-08T02:00:00.000Z';

function lease(overrides: Partial<LeaseCaseSnapshot> = {}): LeaseCaseSnapshot {
  return {
    kind: 'lease',
    id: 'case-1',
    state: 'draft',
    stateVersion: 3,
    businessType: 'managed',
    currentContractId: 'contract-1',
    ...overrides,
  };
}

function mandate(overrides: Partial<ManagementCaseSnapshot> = {}): ManagementCaseSnapshot {
  return {
    kind: 'management',
    id: 'mcase-1',
    state: 'draft',
    stateVersion: 3,
    currentContractId: 'contract-1',
    validUntil: '2026-11-07',
    ...overrides,
  };
}

// 每種輸入的合法樣本。全矩陣用它們測「狀態對了、輸入內容也合格」時的轉移。
const NO_UNSETTLED = { depositBalanceNonZero: false, settlementStatementIncomplete: false, returnProofIncomplete: false };
const INPUTS: Record<CaseInputType, CaseInput> = {
  contract_sent: { type: 'contract_sent', contractId: 'contract-1' },
  contract_completed: { type: 'contract_completed', contractId: 'contract-1' },
  contract_declined: { type: 'contract_declined', contractId: 'contract-1', reason: '租金太高' },
  contract_voided: { type: 'contract_voided', contractId: 'contract-1' },
  abandon: { type: 'abandon' },
  start_move_out: { type: 'start_move_out' },
  cancel_move_out: { type: 'cancel_move_out' },
  complete_move_out_inspection: { type: 'complete_move_out_inspection' },
  advance_after_notice: { type: 'advance_after_notice', noticeNote: '11/1 已寄存證信函，承租人未到場' },
  close: { type: 'close', unsettled: NO_UNSETTLED, unsettledReason: null },
  register_paper_contract: { type: 'register_paper_contract', documentId: 'doc-1' },
  terminate_mandate: { type: 'terminate_mandate', reason: '雙方協議終止' },
  mandate_expired: { type: 'mandate_expired' },
  handover_effective: { type: 'handover_effective', handoverId: 'ho-1', effectiveDate: '2026-11-08' },
};
const INPUT_TYPES = Object.keys(INPUTS) as CaseInputType[];

// 租賃案件七態乘十四種輸入（ADR-0016 決議 3、7、11，ADR-0024 決議 3）。
// 值是下一狀態，缺的欄位表示不接受。業務類型是 managed，所以 handover_effective 可用。
const LEASE_EXPECTED: Record<LeaseCaseState, Partial<Record<CaseInputType, LeaseCaseState>>> = {
  draft: { contract_sent: 'signing', abandon: 'aborted' },
  signing: { contract_completed: 'active', contract_declined: 'draft', contract_voided: 'draft' },
  active: { start_move_out: 'move_out', handover_effective: 'closed' },
  move_out: {
    cancel_move_out: 'active',
    complete_move_out_inspection: 'settling',
    advance_after_notice: 'settling',
    handover_effective: 'closed',
  },
  settling: { close: 'closed', handover_effective: 'closed' },
  closed: {},
  aborted: {},
};

// 委託管理案件六態乘十四種輸入（ADR-0016 決議 9，ADR-0023 決議 4，ADR-0024 決議 3）。
const MANAGEMENT_EXPECTED: Record<ManagementCaseState, Partial<Record<CaseInputType, ManagementCaseState>>> = {
  draft: { contract_sent: 'signing', abandon: 'aborted', register_paper_contract: 'active' },
  signing: { contract_completed: 'active', contract_declined: 'draft', contract_voided: 'draft' },
  active: { terminate_mandate: 'terminated', mandate_expired: 'expired', handover_effective: 'terminated' },
  terminated: {},
  expired: {},
  aborted: {},
};

function matrix<S extends string>(states: readonly S[], expected: Record<S, Partial<Record<CaseInputType, S>>>) {
  return states.flatMap((state) =>
    INPUT_TYPES.map((type) => [state, type, expected[state][type] ?? null] as const),
  );
}

describe('decideCaseTransition：租賃案件全矩陣', () => {
  it.each(matrix(LEASE_CASE_STATES, LEASE_EXPECTED))('%s 收到 %s → %s', (state, type, next) => {
    const decision = decideCaseTransition(lease({ state }), INPUTS[type], NOW);
    if (next === null) {
      expect(decision).toBeNull();
    } else {
      expect(decision?.state).toBe(next);
    }
  });

  it('矩陣涵蓋每個狀態與每種輸入', () => {
    expect(Object.keys(LEASE_EXPECTED).sort()).toEqual([...LEASE_CASE_STATES].sort());
    expect(INPUT_TYPES).toHaveLength(14);
  });
});

describe('decideCaseTransition：委託管理案件全矩陣', () => {
  it.each(matrix(MANAGEMENT_CASE_STATES, MANAGEMENT_EXPECTED))('%s 收到 %s → %s', (state, type, next) => {
    const decision = decideCaseTransition(mandate({ state }), INPUTS[type], NOW);
    if (next === null) {
      expect(decision).toBeNull();
    } else {
      expect(decision?.state).toBe(next);
    }
  });

  it('矩陣涵蓋每個狀態', () => {
    expect(Object.keys(MANAGEMENT_EXPECTED).sort()).toEqual([...MANAGEMENT_CASE_STATES].sort());
  });
});

describe('租賃案件：事件與 outbox', () => {
  it('合約送簽：記 contract_sent，帶合約 ID', () => {
    expect(decideCaseTransition(lease(), INPUTS.contract_sent, NOW)).toEqual({
      state: 'signing',
      event: { type: 'contract_sent', occurredAt: NOW_ISO, payload: { contractId: 'contract-1' } },
      outbox: [],
    });
  });

  it('拒簽回 draft，事件帶拒簽原因', () => {
    const decision = decideCaseTransition(lease({ state: 'signing' }), INPUTS.contract_declined, NOW);
    expect(decision?.event).toEqual({
      type: 'contract_declined',
      occurredAt: NOW_ISO,
      payload: { contractId: 'contract-1', reason: '租金太高' },
    });
  });

  it('撤回回 draft，記 contract_voided', () => {
    const decision = decideCaseTransition(lease({ state: 'signing' }), INPUTS.contract_voided, NOW);
    expect(decision?.event.type).toBe('contract_voided');
  });

  it('放棄：記 aborted', () => {
    expect(decideCaseTransition(lease(), INPUTS.abandon, NOW)?.event.type).toBe('aborted');
  });

  it('發起退租、取消退租、點交完成各記對應事件', () => {
    expect(decideCaseTransition(lease({ state: 'active' }), INPUTS.start_move_out, NOW)?.event.type).toBe(
      'move_out_started',
    );
    expect(decideCaseTransition(lease({ state: 'move_out' }), INPUTS.cancel_move_out, NOW)?.event.type).toBe(
      'move_out_cancelled',
    );
    expect(
      decideCaseTransition(lease({ state: 'move_out' }), INPUTS.complete_move_out_inspection, NOW)?.event.type,
    ).toBe('move_out_inspection_completed');
  });

  it('租賃案件的合約完成不產生連結任務', () => {
    expect(decideCaseTransition(lease({ state: 'signing' }), INPUTS.contract_completed, NOW)?.outbox).toEqual([]);
  });
});

describe('租賃案件：合約 ID 必須是 current_contract_id', () => {
  it.each(['contract_sent', 'contract_completed', 'contract_declined', 'contract_voided'] as const)(
    '%s 帶別份合約的 ID → 不接受',
    (type) => {
      const state = type === 'contract_sent' ? 'draft' : 'signing';
      const input = { ...INPUTS[type], contractId: 'contract-OLD' } as CaseInput;
      expect(decideCaseTransition(lease({ state }), input, NOW)).toBeNull();
    },
  );

  it('current_contract_id 是 null 時，任何合約輸入都不接受', () => {
    expect(decideCaseTransition(lease({ currentContractId: null }), INPUTS.contract_sent, NOW)).toBeNull();
  });

  it('撤回後複製的新草稿成為 current_contract_id，可再送簽（P0-09 AC7）', () => {
    const snapshot = lease({ state: 'draft', currentContractId: 'contract-2' });
    const input: CaseInput = { type: 'contract_sent', contractId: 'contract-2' };
    expect(decideCaseTransition(snapshot, input, NOW)?.state).toBe('signing');
  });
});

describe('租賃案件：advance_after_notice', () => {
  it('催告紀錄是空白 → 不接受', () => {
    const input: CaseInput = { type: 'advance_after_notice', noticeNote: '   ' };
    expect(decideCaseTransition(lease({ state: 'move_out' }), input, NOW)).toBeNull();
  });

  it('事件帶去除前後空白的催告紀錄', () => {
    const input: CaseInput = { type: 'advance_after_notice', noticeNote: '  已寄存證信函 ' };
    expect(decideCaseTransition(lease({ state: 'move_out' }), input, NOW)?.event).toEqual({
      type: 'advanced_after_notice',
      occurredAt: NOW_ISO,
      payload: { noticeNote: '已寄存證信函' },
    });
  });
});

describe('租賃案件：結案的未結事項（ADR-0016 決議 6）', () => {
  const settling = (businessType: LeaseCaseSnapshot['businessType']) => lease({ state: 'settling', businessType });
  const close = (unsettled: Partial<typeof NO_UNSETTLED>, unsettledReason: string | null): CaseInput => ({
    type: 'close',
    unsettled: { ...NO_UNSETTLED, ...unsettled },
    unsettledReason,
  });

  it('全部結清：直接結案，不需要原因，不寫稽核', () => {
    expect(decideCaseTransition(settling('managed'), close({}, null), NOW)).toEqual({
      state: 'closed',
      event: {
        type: 'closed',
        occurredAt: NOW_ISO,
        payload: {
          depositBalanceNonZero: false,
          settlementStatementIncomplete: false,
          returnProofIncomplete: false,
          unsettledReason: null,
        },
      },
      outbox: [],
    });
  });

  it.each([
    ['depositBalanceNonZero'],
    ['settlementStatementIncomplete'],
    ['returnProofIncomplete'],
  ] as const)('%s 未結且沒填原因 → 不接受', (item) => {
    expect(decideCaseTransition(settling('managed'), close({ [item]: true }, null), NOW)).toBeNull();
    expect(decideCaseTransition(settling('managed'), close({ [item]: true }, '  '), NOW)).toBeNull();
  });

  it.each([
    ['depositBalanceNonZero'],
    ['settlementStatementIncomplete'],
    ['returnProofIncomplete'],
  ] as const)('%s 未結且填了原因 → 結案並寫稽核任務', (item) => {
    const decision = decideCaseTransition(settling('managed'), close({ [item]: true }, ' 押金爭議中 '), NOW);
    expect(decision?.state).toBe('closed');
    expect(decision?.event.payload).toMatchObject({ [item]: true, unsettledReason: '押金爭議中' });
    expect(decision?.outbox).toEqual([{ type: 'audit_unsettled_close', caseId: 'case-1', reason: '押金爭議中' }]);
  });

  it('自管案件沒有退還證明，returnProofIncomplete 不列入', () => {
    const decision = decideCaseTransition(settling('self_managed'), close({ returnProofIncomplete: true }, null), NOW);
    expect(decision?.state).toBe('closed');
    expect(decision?.event.payload).toMatchObject({ returnProofIncomplete: false });
    expect(decision?.outbox).toEqual([]);
  });

  it.each(['managed', 'master_lease'] as const)('%s 案件的退還證明未完成要計入', (businessType) => {
    expect(decideCaseTransition(settling(businessType), close({ returnProofIncomplete: true }, null), NOW)).toBeNull();
  });
});

describe('租賃案件：handover_effective（ADR-0024 決議 1、3）', () => {
  const handover = (effectiveDate: string): CaseInput => ({ type: 'handover_effective', handoverId: 'ho-1', effectiveDate });

  it.each(['active', 'move_out', 'settling'] as const)('代管案件在 %s 轉 closed，寫 handed_over 並以移交包 ID 當未結原因', (state) => {
    expect(decideCaseTransition(lease({ state }), handover('2026-11-08'), NOW)).toEqual({
      state: 'closed',
      event: {
        type: 'handed_over',
        occurredAt: NOW_ISO,
        payload: { handoverId: 'ho-1', effectiveDate: '2026-11-08', unsettledReason: 'ho-1' },
      },
      outbox: [{ type: 'audit_unsettled_close', caseId: 'case-1', reason: 'ho-1' }],
    });
  });

  it.each(BUSINESS_TYPES.filter((t) => t !== 'managed'))('%s 案件不適用移交 → 不接受', (businessType) => {
    expect(decideCaseTransition(lease({ state: 'active', businessType }), handover('2026-11-08'), NOW)).toBeNull();
  });

  it('生效日在未來 → 不接受', () => {
    expect(decideCaseTransition(lease({ state: 'active' }), handover('2026-11-09'), NOW)).toBeNull();
  });

  it('生效日已過 → 接受（worker 補處理）', () => {
    expect(decideCaseTransition(lease({ state: 'active' }), handover('2026-11-01'), NOW)?.state).toBe('closed');
  });

  it('台灣時間已過午夜、UTC 還是前一天時，以台灣日期判斷生效日', () => {
    const justAfterMidnightTw = new Date('2026-11-07T16:30:00Z'); // 台灣 11/08 00:30
    expect(decideCaseTransition(lease({ state: 'active' }), handover('2026-11-08'), justAfterMidnightTw)?.state).toBe(
      'closed',
    );
  });

  it('簽署中的案件不接受移交（P0-22 規則 2）', () => {
    expect(decideCaseTransition(lease({ state: 'signing' }), handover('2026-11-08'), NOW)).toBeNull();
  });
});

describe('委託管理案件：事件與 outbox', () => {
  it('全員完成：轉 active，並要求連結受託人組織內的代管租賃案件（P0-11 AC3）', () => {
    expect(decideCaseTransition(mandate({ state: 'signing' }), INPUTS.contract_completed, NOW)).toEqual({
      state: 'active',
      event: { type: 'contract_completed', occurredAt: NOW_ISO, payload: { contractId: 'contract-1' } },
      outbox: [{ type: 'link_managed_lease_cases', mandateCaseId: 'mcase-1' }],
    });
  });

  it('送簽、拒簽、撤回不產生 outbox 任務', () => {
    expect(decideCaseTransition(mandate(), INPUTS.contract_sent, NOW)?.outbox).toEqual([]);
    expect(decideCaseTransition(mandate({ state: 'signing' }), INPUTS.contract_declined, NOW)?.outbox).toEqual([]);
    expect(decideCaseTransition(mandate({ state: 'signing' }), INPUTS.contract_voided, NOW)?.outbox).toEqual([]);
  });

  it('上傳紙本契約書：draft 直接進 active，事件是 paper_contract_registered（ADR-0016 決議 9）', () => {
    expect(decideCaseTransition(mandate({ currentContractId: null }), INPUTS.register_paper_contract, NOW)).toEqual({
      state: 'active',
      event: { type: 'paper_contract_registered', occurredAt: NOW_ISO, payload: { documentId: 'doc-1' } },
      outbox: [{ type: 'link_managed_lease_cases', mandateCaseId: 'mcase-1' }],
    });
  });

  it('終止：轉 terminated，關閉受託人 valid_period 並通知屋主', () => {
    expect(decideCaseTransition(mandate({ state: 'active' }), INPUTS.terminate_mandate, NOW)).toEqual({
      state: 'terminated',
      event: { type: 'terminated', occurredAt: NOW_ISO, payload: { reason: '雙方協議終止' } },
      outbox: [
        { type: 'close_mandatary_valid_period', mandateCaseId: 'mcase-1' },
        { type: 'notify_mandator_handover', mandateCaseId: 'mcase-1' },
      ],
    });
  });

  it('終止原因是空白 → 不接受', () => {
    const input: CaseInput = { type: 'terminate_mandate', reason: ' ' };
    expect(decideCaseTransition(mandate({ state: 'active' }), input, NOW)).toBeNull();
  });

  it('移交生效：轉 terminated，關閉 valid_period，但不再通知屋主移交', () => {
    expect(decideCaseTransition(mandate({ state: 'active' }), INPUTS.handover_effective, NOW)).toEqual({
      state: 'terminated',
      event: {
        type: 'handed_over',
        occurredAt: NOW_ISO,
        payload: { handoverId: 'ho-1', effectiveDate: '2026-11-08' },
      },
      outbox: [{ type: 'close_mandatary_valid_period', mandateCaseId: 'mcase-1' }],
    });
  });

  it('移交生效日在未來 → 不接受', () => {
    const input: CaseInput = { type: 'handover_effective', handoverId: 'ho-1', effectiveDate: '2026-11-09' };
    expect(decideCaseTransition(mandate({ state: 'active' }), input, NOW)).toBeNull();
  });

  it('合約 ID 不是 current_contract_id → 不接受', () => {
    const input: CaseInput = { type: 'contract_completed', contractId: 'contract-OLD' };
    expect(decideCaseTransition(mandate({ state: 'signing' }), input, NOW)).toBeNull();
  });
});

describe('委託管理案件：到期（ADR-0016 決議 9、18）', () => {
  const active = (validUntil: string | null) => mandate({ state: 'active', validUntil });

  it('valid_until 是最後一天（含），當天不到期', () => {
    expect(decideCaseTransition(active('2026-11-08'), INPUTS.mandate_expired, NOW)).toBeNull();
  });

  it('隔天起到期：轉 expired，關閉 valid_period 並通知屋主', () => {
    expect(decideCaseTransition(active('2026-11-07'), INPUTS.mandate_expired, NOW)).toEqual({
      state: 'expired',
      event: { type: 'expired', occurredAt: NOW_ISO, payload: { validUntil: '2026-11-07' } },
      outbox: [
        { type: 'close_mandatary_valid_period', mandateCaseId: 'mcase-1' },
        { type: 'notify_mandator_handover', mandateCaseId: 'mcase-1' },
      ],
    });
  });

  it('台灣時間剛過午夜時，已視為隔天', () => {
    const justAfterMidnightTw = new Date('2026-11-08T16:30:00Z'); // 台灣 11/09 00:30
    expect(decideCaseTransition(active('2026-11-08'), INPUTS.mandate_expired, justAfterMidnightTw)?.state).toBe(
      'expired',
    );
  });

  it('沒有 valid_until（未定期限）→ 不會到期', () => {
    expect(decideCaseTransition(active(null), INPUTS.mandate_expired, NOW)).toBeNull();
  });
});

describe('taiwanDate', () => {
  it('UTC 16:00 起已是台灣隔天', () => {
    expect(taiwanDate(new Date('2026-11-07T15:59:59Z'))).toBe('2026-11-07');
    expect(taiwanDate(new Date('2026-11-07T16:00:00Z'))).toBe('2026-11-08');
  });
});
