// 案件狀態機（ADR-0016 決議 1、3、6、9、11，ADR-0023 決議 4，ADR-0024 決議 2 到 4）。
// 純函式，沒有 I/O。不接受時回傳 null，寫法沿用 src/lib/transitions.ts 的 decideTransition。
// 寫入、樂觀鎖、input_rejected 事件與 outbox 由之後的 dispatch() 負責，見同目錄 README.md。

export const CASE_KINDS = ['lease', 'management'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export const LEASE_CASE_STATES = ['draft', 'signing', 'active', 'move_out', 'settling', 'closed', 'aborted'] as const;
export type LeaseCaseState = (typeof LEASE_CASE_STATES)[number];

export const MANAGEMENT_CASE_STATES = ['draft', 'signing', 'active', 'terminated', 'expired', 'aborted'] as const;
export type ManagementCaseState = (typeof MANAGEMENT_CASE_STATES)[number];

export type CaseState = LeaseCaseState | ManagementCaseState;

/** 業務類型：自管、代管、包租。識別字與 src/lib/owner-overview.ts 相同。 */
export const BUSINESS_TYPES = ['self_managed', 'managed', 'master_lease'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** 案件成員關係（ADR-0016 決議 14）。 */
export const CASE_MEMBER_RELATIONS = [
  'lessor',
  'lessee',
  'co_lessee',
  'mandator',
  'mandatary',
  'owner',
  'practitioner',
  'broker',
] as const;
export type CaseMemberRelation = (typeof CASE_MEMBER_RELATIONS)[number];

interface CaseSnapshotBase {
  id: string;
  stateVersion: number;
  /** 案件只認這份合約的送簽、全員完成、拒簽、撤回（ADR-0016 決議 11）。後繼案件沒有合約，是 null。 */
  currentContractId: string | null;
}

export interface LeaseCaseSnapshot extends CaseSnapshotBase {
  kind: 'lease';
  state: LeaseCaseState;
  businessType: BusinessType;
}

export interface ManagementCaseSnapshot extends CaseSnapshotBase {
  kind: 'management';
  state: ManagementCaseState;
  /** 委託期間的最後一天（含），YYYY-MM-DD，台灣時間。未定時是 null。 */
  validUntil: string | null;
}

export type CaseSnapshot = LeaseCaseSnapshot | ManagementCaseSnapshot;

/** 退租結案時要檢查的未結事項（ADR-0016 決議 6）。 */
export interface UnsettledFacts {
  depositBalanceNonZero: boolean;
  settlementStatementIncomplete: boolean;
  /** 只有代管與包租案件有退還證明。自管案件傳 false。 */
  returnProofIncomplete: boolean;
}

export type CaseInput =
  // 合約訂閱（ADR-0016 決議 11）
  | { type: 'contract_sent'; contractId: string }
  | { type: 'contract_completed'; contractId: string }
  | { type: 'contract_declined'; contractId: string; reason: string | null }
  | { type: 'contract_voided'; contractId: string }
  // 使用者操作
  | { type: 'abandon' }
  | { type: 'start_move_out' }
  | { type: 'cancel_move_out' }
  | { type: 'complete_move_out_inspection' }
  | { type: 'advance_after_notice'; noticeNote: string }
  | { type: 'close'; unsettled: UnsettledFacts; unsettledReason: string | null }
  | { type: 'register_paper_contract'; documentId: string }
  | { type: 'terminate_mandate'; reason: string }
  // 系統轉移
  | { type: 'mandate_expired' }
  | { type: 'handover_effective'; handoverId: string; effectiveDate: string };

export type CaseInputType = CaseInput['type'];

export const CASE_EVENT_TYPES = [
  'created',
  'succeeded',
  'migrated',
  'input_rejected',
  'contract_sent',
  'contract_completed',
  'contract_declined',
  'contract_voided',
  'aborted',
  'move_out_started',
  'move_out_cancelled',
  'move_out_inspection_completed',
  'advanced_after_notice',
  'closed',
  'paper_contract_registered',
  'terminated',
  'expired',
  'handed_over',
  // MIL-115：資料層加的兩個案件層動作。不是狀態轉移，decideCaseTransition 不產生它們。
  /** 加入案件成員（送簽時的承租人、手動加入的共同承租人）。 */
  'member_added',
  /** 案件的目前合約改指向另一份合約：建立案件時掛第一份草稿，或撤回、拒簽後複製的新草稿。 */
  'contract_attached',
] as const;
export type CaseEventType = (typeof CASE_EVENT_TYPES)[number];

export interface CaseEvent {
  type: CaseEventType;
  /** ISO 8601，取自呼叫者傳入的 now。 */
  occurredAt: string;
  payload: Readonly<Record<string, string | boolean | null>>;
}

export type OutboxTask =
  /** 委託管理案件生效後，自動連結受託人組織內既有的代管租賃案件（ADR-0023 決議 4、P0-11 AC3）。 */
  | { type: 'link_managed_lease_cases'; mandateCaseId: string }
  /** 關閉受託人在連結案件的成員 valid_period（ADR-0016 決議 15、ADR-0024 決議 3）。 */
  | { type: 'close_mandatary_valid_period'; mandateCaseId: string }
  /** 通知屋主移交（P0-11 AC5）。 */
  | { type: 'notify_mandator_handover'; mandateCaseId: string }
  /** 有未結事項仍結案時寫稽核紀錄（ADR-0016 決議 6）。 */
  | { type: 'audit_unsettled_close'; caseId: string; reason: string };

export interface CaseTransitionDecision<S extends CaseState = CaseState> {
  state: S;
  event: CaseEvent;
  outbox: OutboxTask[];
}

/** 由案件快照與輸入決定下一狀態、案件事件與 outbox 任務。不接受時回傳 null。 */
export function decideCaseTransition(
  snapshot: LeaseCaseSnapshot,
  input: CaseInput,
  now: Date,
): CaseTransitionDecision<LeaseCaseState> | null;
export function decideCaseTransition(
  snapshot: ManagementCaseSnapshot,
  input: CaseInput,
  now: Date,
): CaseTransitionDecision<ManagementCaseState> | null;
export function decideCaseTransition(
  snapshot: CaseSnapshot,
  input: CaseInput,
  now: Date,
): CaseTransitionDecision | null;
export function decideCaseTransition(
  snapshot: CaseSnapshot,
  input: CaseInput,
  now: Date,
): CaseTransitionDecision | null {
  if (isContractInput(input) && input.contractId !== snapshot.currentContractId) return null;
  return snapshot.kind === 'lease' ? decideLease(snapshot, input, now) : decideManagement(snapshot, input, now);
}

type ContractInput = Extract<CaseInput, { type: `contract_${string}` }>;

// 案件只認 current_contract_id 的合約事件（ADR-0016 決議 11）。用 type 判斷，不靠欄位名稱。
function isContractInput(input: CaseInput): input is ContractInput {
  return input.type.startsWith('contract_');
}

// 合約訂閱的四種輸入，兩種案件的轉移相同（ADR-0016 決議 3、9）。
function decideContractInput(
  state: CaseState,
  input: CaseInput,
  now: Date,
): CaseTransitionDecision<'signing' | 'active' | 'draft'> | null {
  switch (input.type) {
    case 'contract_sent':
      return state === 'draft' ? decision('signing', 'contract_sent', now, { contractId: input.contractId }) : null;
    case 'contract_completed':
      return state === 'signing'
        ? decision('active', 'contract_completed', now, { contractId: input.contractId })
        : null;
    case 'contract_declined':
      return state === 'signing'
        ? decision('draft', 'contract_declined', now, { contractId: input.contractId, reason: input.reason })
        : null;
    case 'contract_voided':
      return state === 'signing' ? decision('draft', 'contract_voided', now, { contractId: input.contractId }) : null;
    default:
      return null;
  }
}

function decideLease(
  snapshot: LeaseCaseSnapshot,
  input: CaseInput,
  now: Date,
): CaseTransitionDecision<LeaseCaseState> | null {
  const { state } = snapshot;
  switch (input.type) {
    case 'contract_sent':
    case 'contract_completed':
    case 'contract_declined':
    case 'contract_voided':
      return decideContractInput(state, input, now);
    case 'abandon':
      return state === 'draft' ? decision('aborted', 'aborted', now) : null;
    case 'start_move_out':
      return state === 'active' ? decision('move_out', 'move_out_started', now) : null;
    case 'cancel_move_out':
      return state === 'move_out' ? decision('active', 'move_out_cancelled', now) : null;
    case 'complete_move_out_inspection':
      return state === 'move_out' ? decision('settling', 'move_out_inspection_completed', now) : null;
    case 'advance_after_notice': {
      const note = input.noticeNote.trim();
      if (state !== 'move_out' || note === '') return null;
      return decision('settling', 'advanced_after_notice', now, { noticeNote: note });
    }
    case 'close':
      return state === 'settling' ? decideClose(snapshot, input.unsettled, input.unsettledReason, now) : null;
    case 'handover_effective': {
      // 移交只適用代管租賃案件（ADR-0024 決議 1），舊案件轉 closed（決議 3）
      if (snapshot.businessType !== 'managed') return null;
      if (state !== 'active' && state !== 'move_out' && state !== 'settling') return null;
      if (!isOnOrAfter(now, input.effectiveDate)) return null;
      const payload = { handoverId: input.handoverId, effectiveDate: input.effectiveDate };
      return {
        state: 'closed',
        event: buildCaseEvent('handed_over', now, { ...payload, unsettledReason: input.handoverId }),
        outbox: [{ type: 'audit_unsettled_close', caseId: snapshot.id, reason: input.handoverId }],
      };
    }
    case 'register_paper_contract':
    case 'terminate_mandate':
    case 'mandate_expired':
      return null;
  }
}

function decideClose(
  snapshot: LeaseCaseSnapshot,
  unsettled: UnsettledFacts,
  unsettledReason: string | null,
  now: Date,
): CaseTransitionDecision<LeaseCaseState> | null {
  // 自管案件沒有退還證明，不列入
  const items = {
    depositBalanceNonZero: unsettled.depositBalanceNonZero,
    settlementStatementIncomplete: unsettled.settlementStatementIncomplete,
    returnProofIncomplete: snapshot.businessType !== 'self_managed' && unsettled.returnProofIncomplete,
  };
  const hasUnsettled = Object.values(items).some(Boolean);
  if (!hasUnsettled) return decision('closed', 'closed', now, { ...items, unsettledReason: null });

  const reason = unsettledReason?.trim() ?? '';
  if (reason === '') return null;
  return {
    state: 'closed',
    event: buildCaseEvent('closed', now, { ...items, unsettledReason: reason }),
    outbox: [{ type: 'audit_unsettled_close', caseId: snapshot.id, reason }],
  };
}

function decideManagement(
  snapshot: ManagementCaseSnapshot,
  input: CaseInput,
  now: Date,
): CaseTransitionDecision<ManagementCaseState> | null {
  const { state, id } = snapshot;
  switch (input.type) {
    case 'contract_sent':
    case 'contract_declined':
    case 'contract_voided':
      return decideContractInput(state, input, now);
    case 'contract_completed': {
      const next = decideContractInput(state, input, now);
      return next && { ...next, outbox: [{ type: 'link_managed_lease_cases', mandateCaseId: id }] };
    }
    case 'register_paper_contract':
      if (state !== 'draft') return null;
      return {
        state: 'active',
        event: buildCaseEvent('paper_contract_registered', now, { documentId: input.documentId }),
        outbox: [{ type: 'link_managed_lease_cases', mandateCaseId: id }],
      };
    case 'abandon':
      return state === 'draft' ? decision('aborted', 'aborted', now) : null;
    case 'terminate_mandate': {
      const reason = input.reason.trim();
      if (state !== 'active' || reason === '') return null;
      return {
        state: 'terminated',
        event: buildCaseEvent('terminated', now, { reason }),
        outbox: endMandateTasks(id, { notifyMandator: true }),
      };
    }
    case 'mandate_expired':
      // validUntil 是最後一天（含），隔天起屆滿
      if (state !== 'active' || snapshot.validUntil === null) return null;
      if (taiwanDate(now) <= snapshot.validUntil) return null;
      return {
        state: 'expired',
        event: buildCaseEvent('expired', now, { validUntil: snapshot.validUntil }),
        outbox: endMandateTasks(id, { notifyMandator: true }),
      };
    case 'handover_effective':
      // 移交生效時舊委託管理案件轉 terminated（ADR-0024 決議 3）。屋主已在移交中，不再提示移交
      if (state !== 'active' || !isOnOrAfter(now, input.effectiveDate)) return null;
      return {
        state: 'terminated',
        event: buildCaseEvent('handed_over', now, { handoverId: input.handoverId, effectiveDate: input.effectiveDate }),
        outbox: endMandateTasks(id, { notifyMandator: false }),
      };
    case 'start_move_out':
    case 'cancel_move_out':
    case 'complete_move_out_inspection':
    case 'advance_after_notice':
    case 'close':
      return null;
  }
}

function endMandateTasks(mandateCaseId: string, options: { notifyMandator: boolean }): OutboxTask[] {
  const tasks: OutboxTask[] = [{ type: 'close_mandatary_valid_period', mandateCaseId }];
  if (options.notifyMandator) tasks.push({ type: 'notify_mandator_handover', mandateCaseId });
  return tasks;
}

function decision<S extends CaseState>(
  state: S,
  type: CaseEventType,
  now: Date,
  payload: CaseEvent['payload'] = {},
): CaseTransitionDecision<S> {
  return { state, event: buildCaseEvent(type, now, payload), outbox: [] };
}

export function buildCaseEvent(type: CaseEventType, now: Date, payload: CaseEvent['payload'] = {}): CaseEvent {
  return { type, occurredAt: now.toISOString(), payload };
}

const TAIWAN_OFFSET_MS = 8 * 60 * 60 * 1000;

/** now 在台灣時間的日期，YYYY-MM-DD。 */
export function taiwanDate(now: Date): string {
  return new Date(now.getTime() + TAIWAN_OFFSET_MS).toISOString().slice(0, 10);
}

// YYYY-MM-DD 字串可以直接比大小
function isOnOrAfter(now: Date, date: string): boolean {
  return taiwanDate(now) >= date;
}
