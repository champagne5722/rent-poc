// 專任規則（ADR-0017 決議 7、8、11，PRD P0-04、P0-05）。純函式，沒有 I/O。
//
// 四個判定點：
//   1. 建立任職      decideEmploymentCreation
//   2. 核對相符      decideEmploymentVerification（資料庫排除約束的純函式版，約束本身屬 MIL-82 之後）
//   3. 送簽與簽章當下 credentialStatusAt()，由 D 線實作，本模組不做
//   4. 定期重驗      decideRecheckResult
// 並附 valid_until 預填與標章文字。
//
// 「別家」的任職由呼叫端查出後傳入。訊息與稽核都不含別家的 ID（ADR-0012 決議 8、ADR-0017 決議 7）。

import type { CertificateKind } from '../labels';
import { addYears, isIsoDate } from './dates';
import {
  decideCredentialTransition,
  type CredentialLayer,
  type CredentialState,
  type CredentialTransition,
} from './credential-transition';

export type { CertificateKind };

export const CERTIFICATE_KINDS = [
  'rental_housing_manager',
  'real_estate_broker',
  'real_estate_sales_agent',
] as const satisfies readonly CertificateKind[];

/** 三種證書的效期都是 4 年（P0-04 規則 5）。 */
export const CERTIFICATE_VALIDITY_YEARS = 4;

/** 管理人員專任：同時間只能在一家已驗證在職。經紀人員得經所屬業者同意掛第二家。 */
function isExclusiveKind(kind: CertificateKind): boolean {
  return kind === 'rental_housing_manager';
}

/** 別家的任職事實。entityId 只用來排除自己這家，不會出現在輸出。 */
export interface OtherEmployment {
  entityId: string;
  state: CredentialState;
  /** 任職期間的第一天，YYYY-MM-DD。 */
  periodStart: string;
  /** 任職期間的最後一天（含）。未結束時是 null。 */
  periodEnd: string | null;
}

function hasVerifiedElsewhere(entityId: string, today: string, others: readonly OtherEmployment[]): boolean {
  return others.some(
    (e) =>
      e.entityId !== entityId &&
      e.state === 'verified' &&
      e.periodStart <= today &&
      (e.periodEnd === null || today <= e.periodEnd),
  );
}

export interface ExclusivityAudit {
  event: 'employment_blocked' | 'employment_consent_required' | 'verification_blocked' | 'verification_consent_missing';
  reason: 'exclusive_employment_elsewhere' | 'second_employment_needs_consent' | 'consent_missing';
  certificateNumber: string;
  /** 發生時間，ISO 8601，由呼叫端傳入。 */
  at: string;
}

interface ExclusivityBase {
  certificateKind: CertificateKind;
  certificateNumber: string;
  /** 要建立或核對的任職所屬的執業主體。 */
  entityId: string;
  /** 今天的台灣日期，YYYY-MM-DD。 */
  today: string;
  /** 目前時間，ISO 8601，只用來填稽核。 */
  at: string;
  otherEmployments: readonly OtherEmployment[];
}

// ---------------------------------------------------------------- 判定點 1

export const BLOCKED_MESSAGE = '此證號已有在職紀錄';
const CONSENT_NOTICE = '此證號已有其他在職紀錄，請上傳所屬業者的同意書';

export type EmploymentCreationDecision =
  | { outcome: 'blocked'; message: typeof BLOCKED_MESSAGE; audit: ExclusivityAudit }
  | {
      outcome: 'created';
      /** 新任職一律是待驗證。 */
      initialState: 'pending';
      consentRequired: boolean;
      notice: string | null;
      audit: ExclusivityAudit | null;
    };

/**
 * 判定點 1：建立任職（ADR-0017 決議 7）。
 * 管理人員：別家已驗證在職時阻擋，不建列。別家只有待驗證時允許並存。
 * 經紀人員：別家已驗證在職時提示，要求所屬業者的同意書，仍建待驗證。
 */
export function decideEmploymentCreation(input: ExclusivityBase): EmploymentCreationDecision {
  const elsewhere = hasVerifiedElsewhere(input.entityId, input.today, input.otherEmployments);
  const auditBase = { certificateNumber: input.certificateNumber, at: input.at };

  if (elsewhere && isExclusiveKind(input.certificateKind)) {
    return {
      outcome: 'blocked',
      message: BLOCKED_MESSAGE,
      audit: { event: 'employment_blocked', reason: 'exclusive_employment_elsewhere', ...auditBase },
    };
  }
  if (elsewhere) {
    return {
      outcome: 'created',
      initialState: 'pending',
      consentRequired: true,
      notice: CONSENT_NOTICE,
      audit: { event: 'employment_consent_required', reason: 'second_employment_needs_consent', ...auditBase },
    };
  }
  return { outcome: 'created', initialState: 'pending', consentRequired: false, notice: null, audit: null };
}

// ---------------------------------------------------------------- 判定點 2

export interface EmploymentVerificationInput extends ExclusivityBase {
  /** 所屬業者同意書是否已核對。只有經紀人員掛第二家時用得到。 */
  consentVerified: boolean;
}

export interface EmploymentVerificationDecision {
  /** 餵給 decideCredentialTransition 的 check_matched.violatesExclusivity。 */
  violatesExclusivity: boolean;
  /** 經紀人員掛第二家且同意書已核對時為 true，任職標示「經所屬業者同意」。 */
  consentedByEntity: boolean;
  warnings: Array<'consent_missing'>;
  /** 給審核台顯示的訊息。沒有阻擋與警示時是 null。不含別家的資訊。 */
  message: string | null;
  audit: ExclusivityAudit | null;
}

const VERIFICATION_BLOCKED_MESSAGE = '此證號已有已驗證的專任任職，請依 resim 任職查詢判定哪一家相符';
const CONSENT_MISSING_MESSAGE = '此證號已有其他在職紀錄，所屬業者的同意書尚未核對';

/**
 * 判定點 2：核對相符轉 verified 時（ADR-0017 決議 7 第 2 點）。
 * 排除約束只涵蓋管理人員專任。經紀人員不擋，同意書未核對時只回警示。
 */
export function decideEmploymentVerification(input: EmploymentVerificationInput): EmploymentVerificationDecision {
  const elsewhere = hasVerifiedElsewhere(input.entityId, input.today, input.otherEmployments);
  const auditBase = { certificateNumber: input.certificateNumber, at: input.at };

  if (elsewhere && isExclusiveKind(input.certificateKind)) {
    return {
      violatesExclusivity: true,
      consentedByEntity: false,
      warnings: [],
      message: VERIFICATION_BLOCKED_MESSAGE,
      audit: { event: 'verification_blocked', reason: 'exclusive_employment_elsewhere', ...auditBase },
    };
  }
  if (elsewhere) {
    return input.consentVerified
      ? { violatesExclusivity: false, consentedByEntity: true, warnings: [], message: null, audit: null }
      : {
          violatesExclusivity: false,
          consentedByEntity: false,
          warnings: ['consent_missing'],
          message: CONSENT_MISSING_MESSAGE,
          audit: { event: 'verification_consent_missing', reason: 'consent_missing', ...auditBase },
        };
  }
  return { violatesExclusivity: false, consentedByEntity: false, warnings: [], message: null, audit: null };
}

// ---------------------------------------------------------------- 判定點 4

export type RecheckResult = 'match' | 'mismatch' | 'not_found' | 'revoked';

/**
 * 判定點 4：定期重驗（ADR-0017 決議 7 第 4 點）。
 * 已驗證且 resim 與登錄不符、查無或廢止時，以 revoked 事件轉 lapsed。其他情況不改狀態，回傳 null。
 */
export function decideRecheckResult(input: {
  layer: CredentialLayer;
  state: CredentialState;
  result: RecheckResult;
}): CredentialTransition | null {
  if (input.result === 'match') return null;
  return decideCredentialTransition(input.state, { layer: input.layer, event: { type: 'revoked' } });
}

// ---------------------------------------------------------------- 效期預填

/** valid_until 預填：發證日加 4 年（ADR-0017 決議 8）。發證日不是有效日期時拋 RangeError。 */
export function prefillValidUntil(issuedOn: string): string {
  return addYears(issuedOn, CERTIFICATE_VALIDITY_YEARS);
}

export interface ValidUntilConsistency {
  consistent: boolean;
  expected: string;
  message: string | null;
}

/** 不一致只提示，不阻擋。valid_until 以平台營運者依 resim 登錄的為準。 */
export function checkValidUntilConsistency(issuedOn: string, validUntil: string): ValidUntilConsistency {
  const expected = prefillValidUntil(issuedOn);
  if (validUntil === expected) return { consistent: true, expected, message: null };
  return {
    consistent: false,
    expected,
    message: `效期與發證日加 ${CERTIFICATE_VALIDITY_YEARS} 年（${expected}）不一致，請確認證書`,
  };
}

// ---------------------------------------------------------------- 標章

export const CERTIFICATE_BADGE_TEXT = '證書資料已核對';

/** 標章與介面禁用的字樣（P0-04 規則 4）。 */
export const FORBIDDEN_BADGE_WORDS = ['保證合法', '認證', '擔保'] as const;

export interface CertificateBadge {
  text: typeof CERTIFICATE_BADGE_TEXT;
  checkedOn: string;
  display: string;
}

/** 屋主看到的標章投影：固定文字加核對日（ADR-0017 決議 11）。 */
export function certificateBadge(checkedOn: string): CertificateBadge {
  if (!isIsoDate(checkedOn)) throw new RangeError(`核對日必須是有效的 YYYY-MM-DD：${checkedOn}`);
  return { text: CERTIFICATE_BADGE_TEXT, checkedOn, display: `${CERTIFICATE_BADGE_TEXT} ${checkedOn}` };
}

export function containsForbiddenBadgeWord(text: string): boolean {
  return FORBIDDEN_BADGE_WORDS.some((word) => text.includes(word));
}
