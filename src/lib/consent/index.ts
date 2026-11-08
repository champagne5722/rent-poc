// 告知與同意紀錄模組的公開介面（MIL-84）。各模組只從這裡 import。
export {
  CONSENT_DECISIONS,
  CONSENT_SOURCES,
  latestConsent,
  recordConsent,
  type ConsentDecision,
  type ConsentRecord,
  type ConsentSource,
  type ConsentSubject,
  type LatestConsent,
  type LatestConsentQuery,
  type RecordConsentInput,
  type RelatedObject,
} from './consent';
export {
  NOTICE_CATALOG,
  NOTICE_TYPES,
  currentNotice,
  findNotice,
  textSha256,
  type LegalReviewStatus,
  type NoticeType,
  type NoticeVersion,
} from './notices';
