// 執業主體登錄、審核台核對與證據檔（MIL-109）。各模組只從這裡 import。
export { applicantMayRead, applicantMayWrite } from './access';
export { getMyRegistration, submitLicense, type LicensePhase, type MyLicense, type MyRegistration, type SubmitResult } from './applicant';
export { getReviewDetail, listQueue, recordLicenseCheck, resolveEntityClaim, type CheckOutcome, type ClaimDecision, type ClaimOutcome, type QueueItem, type ReviewDetail } from './desk';
export { lookupPracticeEntities, LOOKUP_MAX_IDS, type PracticeEntitySummary } from './lookup';
export { openEvidenceFlow, recordCheckFlow, resolveClaimFlow, submitLicenseFlow, type FlowDeps, type OperatorRun } from './flows';
export { deskTicket, inOperatorTx } from './operator-tx';
export { pendingFileRemovals } from './evidence';
export { MANUAL_CHANNELS, CHECK_RESULTS, EVIDENCE_MAX_BYTES, EVIDENCE_MAX_FILES, validateCheckForm, validateSubmission } from './rules';
