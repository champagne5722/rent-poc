// 出租權源送簽前提的公開介面。對接說明見 `./preconditions.ts` 檔頭。
export {
  checkLeasingAuthorityPreconditions,
  requiredDocumentsFor,
  REQUIRED_DOCUMENT_LABELS,
  UNVERIFIED_AUTHORITY_TEXT,
} from './preconditions';
export type {
  LeasingAuthorityBlockCode,
  LeasingAuthorityBlockReason,
  LeasingAuthorityDocument,
  LeasingAuthorityKind,
  LeasingAuthorityPreconditionResult,
  LeasingAuthoritySendFact,
  LeasingAuthoritySendFacts,
  LeasingAuthorityStatus,
  PrimaryLeasingAuthorityFacts,
  RequiredDocument,
  TrustFacts,
  TrustItem,
  UpstreamAuthorityFacts,
} from './preconditions';
