// 執業人員證書登錄、任職與專任規則（MIL-111）。各模組只從這裡 import。
export {
  createEmployment,
  endEmployment,
  getCertificateConsent,
  getMyPractitioner,
  listOrgEmployments,
  registerCertificate,
  type ConsentPhase,
  type EmploymentBlocked,
  type EmploymentCreated,
  type MyCertificate,
  type MyEmployment,
  type MyPractitioner,
  type OrgEmployment,
  type Phase,
} from './applicant';
export {
  getCredentialReview,
  isCredentialItemType,
  recordCertificateCheck,
  recordConsentCheck,
  recordEmploymentCheck,
  type CompetingEmployment,
  type CredentialCheck,
  type CredentialCheckOutcome,
  type CredentialReview,
  type SupplementRequest,
} from './desk';
export {
  createEmploymentFlow,
  endEmploymentFlow,
  recordConsentFlow,
  recordCredentialCheckFlow,
  registerCertificateFlow,
  submitConsentLetterFlow,
} from './flows';
export { getCertificateBadges, getSigningFacts, type LicenseFact, type PractitionerBadge, type PractitionerSigningFact, type SigningFacts } from './signing';
export { certificateKey, formatCertificateNumber, maskCertificateNumber, type CertificateNumber } from './rules';
export { taiwanDate } from './dates';
