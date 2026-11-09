import type {
  BusinessType,
  CaseEvent,
  CaseEventType,
  CaseKind,
  CaseMemberRelation,
  CaseState,
  OutboxTask,
} from '../cases';

// 案件資料層的型別（MIL-115）。純函式在 src/lib/cases/，這裡是帶 I/O 的 repository、dispatch 與訂閱。

/** 案件列。日期欄位一律是 YYYY-MM-DD 字串（台灣日期），時間欄位是 ISO 8601。 */
export interface CaseRecord {
  id: string;
  orgId: string;
  kind: CaseKind;
  state: CaseState;
  stateVersion: number;
  businessType: BusinessType | null;
  title: string;
  rentalUnitId: string | null;
  propertyId: string | null;
  currentContractId: string | null;
  linkedMandateCaseId: string | null;
  predecessorCaseId: string | null;
  handoverId: string | null;
  validUntil: string | null;
  leaseStart: string | null;
  leaseEnd: string | null;
  monthlyRent: number | null;
  /** 社宅代管案件旗標（ADR-0050 決議 10）。修改走 changeSocialHousing，必須填原因。 */
  socialHousing: boolean;
  /** 租金與押金的預設收款帳戶，只用來預填入帳表單（MIL-123）。 */
  defaultRentAccountId: string | null;
  defaultDepositAccountId: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface CaseMemberRecord {
  id: string;
  caseId: string;
  partyId: string;
  relation: CaseMemberRelation;
  /** 成員顯示名稱，取自 control.parties。 */
  displayName: string;
  email: string;
  /** 關係開始的時間，ISO 8601。 */
  validFrom: string;
  /** 關係結束的時間。還有效是 null。 */
  validUntil: string | null;
}

export interface CaseEventRecord {
  id: string;
  caseId: string;
  type: CaseEventType;
  fromState: CaseState | null;
  toState: CaseState | null;
  payload: Record<string, string | boolean | number | null>;
  actorPartyId: string | null;
  occurredAt: string;
}

/** 案件事件的行為者。`null` 是系統（簽署事件、遷移、worker）。 */
export interface CaseActor {
  partyId: string | null;
}

export type DispatchResult =
  | {
      ok: true;
      from: CaseState;
      state: CaseState;
      stateVersion: number;
      event: CaseEvent;
      /** 純函式回傳的 outbox 任務。`audit_unsettled_close` 已在同交易寫成稽核事件，其餘由呼叫端或之後的票處理。 */
      outbox: OutboxTask[];
    }
  | {
      /** 案件拒絕了這個輸入。已寫 `input_rejected` 事件，狀態不變（ADR-0016 決議 11）。 */
      ok: false;
      reason: 'rejected';
      state: CaseState;
    };

/** 案件不存在，或不屬於目前的組織脈絡（RLS 看不到）。 */
export class CaseNotFound extends Error {
  constructor(readonly caseId: string) {
    super(`案件 ${caseId} 不存在`);
    this.name = 'CaseNotFound';
  }
}

/** 樂觀鎖衝突：讀到之後 `state_version` 被別的交易推進了。呼叫端讓交易回滾，由 inbox 重試（ADR-0016 決議 11）。 */
export class CaseVersionConflict extends Error {
  constructor(readonly caseId: string) {
    super(`案件 ${caseId} 的狀態版本已被更新，請重試`);
    this.name = 'CaseVersionConflict';
  }
}
