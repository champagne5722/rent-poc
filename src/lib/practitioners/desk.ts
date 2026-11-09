import { appendAudit } from '../audit';
import { deleteEvidence, listEvidence, type DeletedEvidence, type EvidenceMeta } from '../practice-entities/evidence';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import {
  decideCredentialTransition,
  decideEmploymentVerification,
  type CertificateKind,
  type CredentialState,
  type OtherEmployment,
} from '../registry-rules';
import { taiwanDate } from './dates';
import { formatCertificateNumber, type CertificateNumber, type LayerCheckForm } from './rules';

// 審核台的證書、任職與同意書核對（MIL-111）。都在平台營運者脈絡內呼叫（withTx 的 operator 脈絡），
// 稽核事件因此寫在平台組織的鏈，行為者是營運者。權限由資料庫函式的 assert_operator() 把關。
// 規則呼叫 src/lib/registry-rules 的純函式，這裡不重寫。

export type ItemStatus = 'open' | 'resolved';
export type CheckResultCode = 'match' | 'mismatch' | 'not_found' | 'revoked';

export interface CredentialPractitioner {
  id: string;
  partyName: string;
  kind: CertificateKind;
  number: CertificateNumber;
  certificateKey: string;
  issuedOn: string;
  validUntil: string;
  state: CredentialState;
  submittedAt: string;
}

export interface CredentialEmployment {
  id: string;
  state: CredentialState;
  startedOn: string;
  endedOn: string | null;
  certificateKey: string;
  entityName: string;
  consentRequired: boolean;
  consentVerifiedAt: string | null;
  consentValidUntil: string | null;
  consentEndedAt: string | null;
}

export interface CompetingEmployment {
  id: string;
  entityName: string;
  partyName: string;
  state: CredentialState;
  startedOn: string;
  endedOn: string | null;
  consentRequired: boolean;
  consentedByEntity: boolean;
}

export interface CredentialCheck {
  id: string;
  subjectType: string;
  subjectId: string;
  channel: string;
  querySource: string;
  observed: Record<string, unknown>;
  result: CheckResultCode;
  note: string;
  checkedBy: string;
  checkedAt: string;
}

export interface CredentialReview {
  item: { id: string; type: 'certificate' | 'employment' | 'consent'; status: ItemStatus; resolution: string | null; createdAt: string; resolvedAt: string | null; subjectId: string };
  practitioner: CredentialPractitioner | null;
  employment: CredentialEmployment | null;
  /** 同一證號在其他執業主體的未結束任職。兩家都待驗證時，營運者據此判定哪一家相符。 */
  competing: CompetingEmployment[];
  checks: CredentialCheck[];
  /** 證書項目是證書影本，同意書項目是同意書。 */
  evidence: EvidenceMeta[];
}

interface RawReview {
  item: { id: string; type: string; subject_id: string; status: ItemStatus; resolution: string | null; created_at: string; resolved_at: string | null };
  practitioner: null | {
    id: string; party_name: string; certificate_kind: CertificateKind; cert_year: string; cert_word: string; cert_serial: string;
    certificate_key: string; issued_on: string; valid_until: string; state: CredentialState; submitted_at: string;
  };
  employment: null | {
    id: string; state: CredentialState; started_on: string; ended_on: string | null; certificate_key: string; entity_name: string;
    consent_required: boolean; consent_verified_at: string | null; consent_valid_until: string | null; consent_ended_at: string | null;
  };
  competing_employments: Array<{
    id: string; entity_name: string; party_name: string; state: CredentialState; started_on: string; ended_on: string | null;
    consent_required: boolean; consented_by_entity: boolean;
  }>;
  checks: Array<{
    id: string; subject_type: string; subject_id: string; channel: string; query_source: string; observed: Record<string, unknown>;
    result: CheckResultCode; note: string; checked_by: string; checked_at: string;
  }>;
}

const iso = (value: string): string => new Date(value).toISOString();
const isoOrNull = (value: string | null): string | null => (value ? iso(value) : null);

const CREDENTIAL_TYPES = ['certificate', 'employment', 'consent'] as const;
export const isCredentialItemType = (type: string): type is (typeof CREDENTIAL_TYPES)[number] => (CREDENTIAL_TYPES as readonly string[]).includes(type);

/** 證書、任職、同意書項目的詳情。找不到或不是這三種項目回 null。 */
export async function getCredentialReview(tx: OrgTx, itemId: string): Promise<CredentialReview | null> {
  const { rows } = await tx.query<{ detail: RawReview | null }>('SELECT registry.review_item_detail($1) AS detail', [itemId]);
  const raw = rows[0]?.detail;
  if (!raw || !isCredentialItemType(raw.item.type)) return null;
  const type = raw.item.type;

  const evidence =
    type === 'certificate'
      ? await listEvidence(tx, 'practitioner', [raw.item.subject_id], true)
      : type === 'consent'
        ? await listEvidence(tx, 'employment_consent', [raw.item.subject_id], true)
        : [];

  return {
    item: {
      id: raw.item.id, type, status: raw.item.status, resolution: raw.item.resolution,
      createdAt: iso(raw.item.created_at), resolvedAt: isoOrNull(raw.item.resolved_at), subjectId: raw.item.subject_id,
    },
    practitioner: raw.practitioner && {
      id: raw.practitioner.id, partyName: raw.practitioner.party_name, kind: raw.practitioner.certificate_kind,
      number: { year: raw.practitioner.cert_year, word: raw.practitioner.cert_word, serial: raw.practitioner.cert_serial },
      certificateKey: raw.practitioner.certificate_key, issuedOn: raw.practitioner.issued_on, validUntil: raw.practitioner.valid_until,
      state: raw.practitioner.state, submittedAt: iso(raw.practitioner.submitted_at),
    },
    employment: raw.employment && {
      id: raw.employment.id, state: raw.employment.state, startedOn: raw.employment.started_on, endedOn: raw.employment.ended_on,
      certificateKey: raw.employment.certificate_key, entityName: raw.employment.entity_name, consentRequired: raw.employment.consent_required,
      consentVerifiedAt: isoOrNull(raw.employment.consent_verified_at), consentValidUntil: raw.employment.consent_valid_until,
      consentEndedAt: isoOrNull(raw.employment.consent_ended_at),
    },
    competing: raw.competing_employments.map((c) => ({
      id: c.id, entityName: c.entity_name, partyName: c.party_name, state: c.state, startedOn: c.started_on, endedOn: c.ended_on,
      consentRequired: c.consent_required, consentedByEntity: c.consented_by_entity,
    })),
    checks: raw.checks.map((c) => ({
      id: c.id, subjectType: c.subject_type, subjectId: c.subject_id, channel: c.channel, querySource: c.query_source,
      observed: c.observed, result: c.result, note: c.note, checkedBy: c.checked_by, checkedAt: iso(c.checked_at),
    })),
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 共用

export interface SupplementRequest {
  /** 要通知補件的執業人員（party）與判定理由。 */
  partyId: string;
  layer: 'certificate' | 'employment' | 'consent';
  note: string;
}

export type CredentialCheckOutcome =
  | {
      status: 'recorded';
      checkId: string;
      from: CredentialState | null;
      to: CredentialState | null;
      result: CheckResultCode;
      supplement: SupplementRequest | null;
      /** 任職核對相符但同意書尚未核對（經紀人員掛第二家）。畫面提示營運者。 */
      warnings: Array<'consent_missing'>;
      deletedEvidence: DeletedEvidence[];
    }
  | { status: 'not_found' }
  | { status: 'wrong_type' }
  | { status: 'already_resolved' }
  /** 專任排除：別家已有已驗證的任職。什麼都沒寫（只有稽核事件），營運者先判定哪一家相符。 */
  | { status: 'exclusivity_blocked'; message: string };

async function ownerPartyOf(tx: OrgTx, practitionerId: string): Promise<string> {
  // 營運者要通知的對象。party ID 只在審核台與通知流程用，不進回應
  const { rows } = await tx.query<{ party_id: string }>('SELECT registry.practitioner_party($1) AS party_id', [practitionerId]);
  return rows[0].party_id;
}

async function writeAudit(tx: OrgTx, objectType: string, objectId: string, payload: Record<string, unknown>) {
  return appendAudit(tx, { action: 'practitioner.verify', object: { type: objectType, id: objectId }, payload });
}

// ---------------------------------------------------------------------------
// 證書核對

/**
 * 登錄證書核對（ADR-0017 決議 4、8、10）。相符時 valid_until 以營運者登錄的 resim 效期為準。
 * 相符後證書影本刪除（ADR-0017 補充）。不符時維持待驗證，影本保留，通知補件。
 */
export async function recordCertificateCheck(tx: OrgTx, itemId: string, form: LayerCheckForm): Promise<CredentialCheckOutcome> {
  const review = await getCredentialReview(tx, itemId);
  if (!review) return { status: 'not_found' };
  if (review.item.type !== 'certificate' || !review.practitioner) return { status: 'wrong_type' };
  if (review.item.status !== 'open') return { status: 'already_resolved' };
  const cert = review.practitioner;

  const transition = decideCredentialTransition(cert.state, {
    layer: 'practitioner',
    event: form.result === 'match' ? { type: 'check_matched', violatesExclusivity: false } : { type: 'check_mismatched' },
  });
  // 送件時證書一定轉成 pending。不是的話項目已過時
  if (!transition) return { status: 'already_resolved' };

  const evidenceIds = review.evidence.filter((e) => e.state === 'stored').map((e) => e.id);
  const checkId = newUlid();
  const ref = await writeAudit(tx, 'practitioner', cert.id, {
    layer: 'practitioner', check_id: checkId, channel: form.channel, result: form.result, from: cert.state, to: transition.to,
  });
  await tx.query('SELECT registry.record_practitioner_check($1, $2, $3, $4, $5, $6::jsonb, $7, $8::text[], $9, $10, $11, $12::date, $13, $14, $15)', [
    checkId, itemId, cert.id, form.channel, form.querySource,
    JSON.stringify({ certificate_kind: cert.kind, valid_until: form.validUntil, issued_on: cert.issuedOn }),
    form.result, evidenceIds, form.note, cert.state, transition.to, form.validUntil, review.practitioner.certificateKey, ref.chainId, ref.seq,
  ]);

  const deletedEvidence = form.result === 'match' ? await deleteEvidence(tx, evidenceIds, 'matched') : [];
  return {
    status: 'recorded',
    checkId,
    from: cert.state,
    to: transition.to,
    result: form.result,
    warnings: [],
    supplement: form.result === 'match' ? null : { partyId: await ownerPartyOf(tx, cert.id), layer: 'certificate', note: form.note },
    deletedEvidence,
  };
}

// ---------------------------------------------------------------------------
// 任職核對

/**
 * 登錄任職核對（resim 任職查詢）。相符前先判定專任（判定點 2，ADR-0017 決議 7）：
 * 管理人員在別家已有已驗證在職時擋下，寫稽核事件（平台組織的鏈），營運者先判定哪一家相符。
 * 經紀人員不擋，同意書尚未核對時回傳警示。資料庫的部分唯一索引是最後防線。
 */
export async function recordEmploymentCheck(tx: OrgTx, itemId: string, form: LayerCheckForm, now: Date): Promise<CredentialCheckOutcome> {
  const review = await getCredentialReview(tx, itemId);
  if (!review) return { status: 'not_found' };
  if (review.item.type !== 'employment' || !review.employment || !review.practitioner) return { status: 'wrong_type' };
  if (review.item.status !== 'open') return { status: 'already_resolved' };
  const employment = review.employment;
  const cert = review.practitioner;

  const warnings: Array<'consent_missing'> = [];
  if (form.result === 'match') {
    const others: OtherEmployment[] = review.competing.map((c) => ({ entityId: c.id, state: c.state, periodStart: c.startedOn, periodEnd: c.endedOn }));
    const verification = decideEmploymentVerification({
      certificateKind: cert.kind,
      certificateNumber: formatCertificateNumber(cert.number),
      entityId: employment.id,
      today: taiwanDate(now),
      at: now.toISOString(),
      otherEmployments: others,
      consentVerified: employment.consentVerifiedAt !== null && employment.consentEndedAt === null,
    });
    if (verification.audit) {
      await appendAudit(tx, {
        action: verification.violatesExclusivity ? 'rule.full_time_block' : 'rule.full_time_notice',
        object: { type: 'employment', id: employment.id },
        payload: { event: verification.audit.event, reason: verification.audit.reason, certificate_number: verification.audit.certificateNumber, at: verification.audit.at },
      });
    }
    if (verification.violatesExclusivity) return { status: 'exclusivity_blocked', message: verification.message ?? '' };
    warnings.push(...verification.warnings);
  }

  const transition = decideCredentialTransition(employment.state, {
    layer: 'employment',
    event: form.result === 'match' ? { type: 'check_matched', violatesExclusivity: false } : { type: 'check_mismatched' },
  });
  if (!transition) return { status: 'already_resolved' };

  const checkId = newUlid();
  const ref = await writeAudit(tx, 'employment', employment.id, {
    layer: 'employment', check_id: checkId, channel: form.channel, result: form.result, from: employment.state, to: transition.to,
  });
  await tx.query('SELECT registry.record_employment_check($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)', [
    checkId, itemId, employment.id, form.channel, form.querySource,
    JSON.stringify({ certificate_kind: cert.kind, started_on: employment.startedOn }),
    form.result, form.note, employment.state, transition.to, employment.certificateKey, ref.chainId, ref.seq,
  ]);

  return {
    status: 'recorded',
    checkId,
    from: employment.state,
    to: transition.to,
    result: form.result,
    warnings,
    supplement: form.result === 'match' ? null : { partyId: await ownerPartyOf(tx, cert.id), layer: 'employment', note: form.note },
    deletedEvidence: [],
  };
}

// ---------------------------------------------------------------------------
// 同意書核對

/**
 * 登錄所屬業者同意書核對（document_review）。相符後任職標示「經所屬業者同意」。
 * 同意書在任職有效期間保留，不因相符而刪除（ADR-0017 補充）。
 */
export async function recordConsentCheck(tx: OrgTx, itemId: string, form: LayerCheckForm): Promise<CredentialCheckOutcome> {
  const review = await getCredentialReview(tx, itemId);
  if (!review) return { status: 'not_found' };
  if (review.item.type !== 'consent' || !review.employment || !review.practitioner) return { status: 'wrong_type' };
  if (review.item.status !== 'open') return { status: 'already_resolved' };
  const employment = review.employment;

  const evidenceIds = review.evidence.filter((e) => e.state === 'stored').map((e) => e.id);
  const checkId = newUlid();
  const ref = await writeAudit(tx, 'employment', employment.id, {
    layer: 'consent', check_id: checkId, channel: form.channel, result: form.result,
  });
  await tx.query('SELECT registry.record_consent_check($1, $2, $3, $4, $5, $6::jsonb, $7, $8::text[], $9, $10::date, $11, $12)', [
    checkId, itemId, employment.id, form.channel, form.querySource,
    JSON.stringify({ certificate_kind: review.practitioner.kind, valid_until: form.validUntil }),
    form.result, evidenceIds, form.note, form.validUntil, ref.chainId, ref.seq,
  ]);

  return {
    status: 'recorded',
    checkId,
    from: null,
    to: null,
    result: form.result,
    warnings: [],
    supplement: form.result === 'match' ? null : { partyId: await ownerPartyOf(tx, review.practitioner.id), layer: 'consent', note: form.note },
    deletedEvidence: [],
  };
}
