// 應收期別純函式模組（MIL-155）。只匯出純函式與型別，不碰資料庫。

export { splitPeriods, cancelPeriodsAfter } from './periods';
export { allocateReceipt, applyPrepaid, reallocate } from './allocation';
export type {
  AllocateReceiptOptions,
  AllocateReceiptResult,
  AllocationFailureReason,
  ApplyPrepaidFailureReason,
  ApplyPrepaidOptions,
  ApplyPrepaidResult,
  ReallocateFailureReason,
  ReallocateResult,
  ReallocationChange,
} from './allocation';
export { allocatedAmount, isOverdue, outstandingAmount, periodStatus } from './status';
export { handoverDelayLabel, shouldConfirmReminder, SOCIAL_HOUSING_HANDOVER_DAYS } from './reminder';
export type { HandoverDelayLabel } from './reminder';
export { toTaipeiDate } from './dates';
export type {
  Allocation,
  AllocationDraft,
  FundKind,
  PeriodContract,
  PeriodDraft,
  PeriodState,
  PeriodStatus,
  ReceivablePeriod,
} from './types';
