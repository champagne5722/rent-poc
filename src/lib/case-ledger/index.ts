// 接上案件的帳務模組公開介面（MIL-123）。其他模組只從這裡匯入。
// 合約全員完成時的接線在 src/lib/case-store/contract-subscription.ts，直接匯入 ./open，避免循環匯入。
export { cancelPeriodsAfterTermination, openCaseLedger, type OpenCaseLedgerResult } from './open';
export { getDepositBalance, getDepositLedger, listPeriods } from './reads';
export { addRemitterId, listRemitterIds, removeRemitterId, type AddRemitterResult } from './remitters';
export { parseRemitterInput, normalizeAccountLast5, normalizePayerName, MAX_PAYER_NAME_LENGTH, type RemitterInput } from './remitter-input';
export { getDefaultAccounts, setDefaultAccounts, type DefaultAccountsInput, type SetDefaultAccountsResult } from './default-accounts';
export { listHolderConflicts, type HolderConflict } from './holder-conflicts';
export {
  changeSocialHousing,
  listSocialHousingChanges,
  MAX_REASON_LENGTH,
  resolveSocialHousingDefault,
  type ChangeSocialHousingResult,
} from './social-housing';
export {
  REMITTER_KINDS,
  type DefaultAccounts,
  type DepositLedger,
  type DepositLedgerStatus,
  type LeaseTerms,
  type PeriodRecord,
  type RemitterId,
  type RemitterKind,
  type SocialHousingChange,
} from './types';
