// 所有權文件與核對的公開介面（MIL-201）。伺服器端的程式從這裡 import。
// 前端只 import 純函式與常數：./status、./messages、./business-days、./forms（不要從這裡 import，這裡有伺服器端的程式）。
export {
  decideOwnershipFlow,
  getOwnershipReviewDetail,
  getReviewHeader,
  openOwnershipReviewFile,
  type DecideFlowResult,
  type OperatorRuns,
  type OwnershipReviewDetail,
  type OwnershipReviewHeader,
} from './desk';
export {
  checkTranscriptFile,
  openOwnTranscriptFlow,
  readTranscriptBytes,
  submitTranscriptFlow,
  type OpenFileResult,
  type OwnershipActor,
  type OwnershipFlowDeps,
  type SubmitFlowResult,
  type TranscriptUpload,
} from './flows';
export {
  canCreateCase,
  canSendContract,
  isVerified,
  leasingAuthorityFactsOf,
  PROPERTY_NOT_VERIFIED_CODE,
  PROPERTY_NOT_VERIFIED_MESSAGE,
  type OwnershipGate,
} from './gate';
export {
  fetchOwnershipStatuses,
  getOwnershipGate,
  getOwnershipNodeStatus,
  getPropertyOwnership,
  recordTranscriptConsent,
  TRANSCRIPT_NOTICE,
  type OwnershipNodeView,
} from './repository';
