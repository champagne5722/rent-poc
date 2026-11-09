import { appendAudit } from '../audit';
import { latestConsent, recordConsent, type ConsentDecision } from '../consent';
import { registerEvidence, type StoredEvidence } from '../practice-entities/evidence';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import {
  checkValidUntilConsistency,
  decideCredentialTransition,
  BLOCKED_MESSAGE,
  CONSENT_NOTICE,
  presentCreationVerdict,
  type CertificateKind,
  type CreationVerdict,
  type CredentialState,
} from '../registry-rules';
import { formatCertificateNumber, type CertificateForm, type CertificateNumber } from './rules';

// 執業人員端（MIL-111，ADR-0022 決議 9）：本人登錄證書、建立任職、補同意書、結束任職。組織成員脈絡。
//
// 規則：
// - 成員只能登錄自己的證書。party 來自交易脈絡（app.party_id），資料庫函式再查成員資格，組織不能替別人登錄。
// - 登錄前必須對「證書資料個資告知」目前版本表態同意（P0-24 AC3）。
// - 專任判定在資料庫內，與寫入同一個函式呼叫（MIL-186）：submit_practitioner 與 create_employment 回傳結論，
//   別家的任職事實不離開資料庫。規則的參考實作是 registry-rules 的 classifyEmploymentCreation。
//   阻擋與提示都寫稽核事件（P0-05 AC6）。阻擋時資料庫回傳結果而不是丟錯，讓稽核事件跟著交易提交。
// - 回應與稽核事件都不透露別的組織（ADR-0012 決議 8）：只有結論，沒有別家的 ID、名稱、狀態與日期。

/** 證書（或任職）在執業人員端看到的進度。 */
export type Phase = 'awaiting_review' | 'needs_resubmission' | 'verified' | 'lapsed';

export interface MyCertificate {
  id: string;
  kind: CertificateKind;
  number: CertificateNumber;
  issuedOn: string;
  validUntil: string;
  state: CredentialState;
  phase: Phase;
  lastResult: 'match' | 'mismatch' | 'not_found' | 'revoked' | null;
  /** 營運者的判定理由，執業人員據此補件。最新一筆是相符時為 null。 */
  lastNote: string | null;
  lastCheckedAt: string | null;
  submittedAt: string;
}

export type ConsentPhase = 'not_submitted' | 'awaiting_review' | 'needs_resubmission' | 'verified' | 'ended';

export interface MyEmployment {
  id: string;
  practitionerId: string;
  certificateKind: CertificateKind;
  state: CredentialState;
  startedOn: string;
  endedOn: string | null;
  phase: Phase;
  lastResult: MyCertificate['lastResult'];
  lastNote: string | null;
  consentRequired: boolean;
  consentPhase: ConsentPhase | null;
  consentNote: string | null;
  consentValidUntil: string | null;
  /** 任職標示「經所屬業者同意」（P0-05 規則 6）。 */
  consentedByEntity: boolean;
}

export interface MyPractitioner {
  /** 目前組織有執業主體登錄，才能建立任職。 */
  entityRegistered: boolean;
  certificates: MyCertificate[];
  /** 只有目前組織的任職，不含其他組織（ADR-0012 決議 8）。 */
  employments: MyEmployment[];
}

interface RawCertificate {
  id: string; certificate_kind: CertificateKind; cert_year: string; cert_word: string; cert_serial: string;
  issued_on: string; valid_until: string; state: CredentialState; phase: Phase; last_result: MyCertificate['lastResult'];
  last_note: string | null; last_checked_at: string | null; submitted_at: string;
}
interface RawEmployment {
  id: string; practitioner_id: string; certificate_kind: CertificateKind; state: CredentialState; started_on: string; ended_on: string | null;
  phase: Phase; last_result: MyCertificate['lastResult']; last_note: string | null; consent_required: boolean;
  consent_phase: ConsentPhase | null; consent_note: string | null; consent_valid_until: string | null; consented_by_entity: boolean;
}

const iso = (value: string): string => new Date(value).toISOString();

export async function getMyPractitioner(tx: OrgTx): Promise<MyPractitioner> {
  const { rows } = await tx.query<{ result: { entity_registered: boolean; certificates: RawCertificate[]; employments: RawEmployment[] } }>(
    'SELECT registry.my_practitioner() AS result',
  );
  const raw = rows[0].result;
  return {
    entityRegistered: raw.entity_registered,
    certificates: raw.certificates.map((c) => ({
      id: c.id,
      kind: c.certificate_kind,
      number: { year: c.cert_year, word: c.cert_word, serial: c.cert_serial },
      issuedOn: c.issued_on,
      validUntil: c.valid_until,
      state: c.state,
      phase: c.phase,
      lastResult: c.last_result,
      lastNote: c.last_note,
      lastCheckedAt: c.last_checked_at ? iso(c.last_checked_at) : null,
      submittedAt: iso(c.submitted_at),
    })),
    employments: raw.employments.map((e) => ({
      id: e.id,
      practitionerId: e.practitioner_id,
      certificateKind: e.certificate_kind,
      state: e.state,
      startedOn: e.started_on,
      endedOn: e.ended_on,
      phase: e.phase,
      lastResult: e.last_result,
      lastNote: e.last_note,
      consentRequired: e.consent_required,
      consentPhase: e.consent_phase,
      consentNote: e.consent_note,
      consentValidUntil: e.consent_valid_until,
      consentedByEntity: e.consented_by_entity,
    })),
  };
}

// ---------------------------------------------------------------------------
// 執業主體的任職清單

export interface OrgEmployment {
  id: string;
  displayName: string;
  certificateKind: CertificateKind;
  /** 證號遮罩前的三段。畫面用 maskCertificateNumber 遮罩。 */
  number: CertificateNumber;
  state: CredentialState;
  startedOn: string;
  endedOn: string | null;
  practitionerState: CredentialState;
  validUntil: string;
  consentRequired: boolean;
  consentedByEntity: boolean;
  isSelf: boolean;
}

export async function listOrgEmployments(tx: OrgTx): Promise<OrgEmployment[]> {
  const { rows } = await tx.query<{
    result: Array<{
      id: string; display_name: string; certificate_kind: CertificateKind; cert_year: string; cert_word: string; cert_serial: string;
      state: CredentialState; started_on: string; ended_on: string | null; practitioner_state: CredentialState; valid_until: string;
      consent_required: boolean; consented_by_entity: boolean; is_self: boolean;
    }>;
  }>('SELECT registry.org_employments() AS result');
  return rows[0].result.map((e) => ({
    id: e.id,
    displayName: e.display_name,
    certificateKind: e.certificate_kind,
    number: { year: e.cert_year, word: e.cert_word, serial: e.cert_serial },
    state: e.state,
    startedOn: e.started_on,
    endedOn: e.ended_on,
    practitionerState: e.practitioner_state,
    validUntil: e.valid_until,
    consentRequired: e.consent_required,
    consentedByEntity: e.consented_by_entity,
    isSelf: e.is_self,
  }));
}

// ---------------------------------------------------------------------------
// 個資告知與同意（P0-24 AC3）

export async function getCertificateConsent(tx: OrgTx, partyId: string): Promise<{ decision: ConsentDecision; isCurrentVersion: boolean } | null> {
  const latest = await latestConsent(tx, { notice: 'certificate_pii', subject: { partyId } });
  return latest ? { decision: latest.decision, isCurrentVersion: latest.isCurrentVersion } : null;
}

/** 記錄對目前版本「證書資料個資告知」的同意或反對。同交易寫稽核事件（recordConsent 負責）。 */
export async function recordCertificateConsent(tx: OrgTx, partyId: string, decision: ConsentDecision): Promise<void> {
  await recordConsent(tx, { notice: 'certificate_pii', subject: { partyId }, decision, source: 'in_app' });
}

async function hasAgreed(tx: OrgTx, partyId: string): Promise<boolean> {
  const consent = await getCertificateConsent(tx, partyId);
  return consent !== null && consent.decision === 'agree' && consent.isCurrentVersion;
}

// ---------------------------------------------------------------------------
// 專任判定與建立任職

export type EmploymentCreated = {
  status: 'created';
  employmentId: string;
  consentRequired: boolean;
  /** 經紀人員掛第二家時的提示，要求上傳所屬業者的同意書。 */
  notice: string | null;
};
export type EmploymentBlocked = { status: 'blocked'; message: string };

/** 阻擋與提示都寫稽核事件，含證號、時間與原因（P0-05 AC6）。事件在宣稱方自己的鏈。 */
async function auditVerdict(
  tx: OrgTx,
  input: { practitionerId: string; verdict: CreationVerdict; number: CertificateNumber; now: Date },
): Promise<void> {
  const decision = presentCreationVerdict(input.verdict, { certificateNumber: formatCertificateNumber(input.number), at: input.now.toISOString() });
  const audit = decision.audit;
  if (audit) {
    await appendAudit(tx, {
      action: decision.outcome === 'blocked' ? 'rule.full_time_block' : 'rule.full_time_notice',
      object: { type: 'practitioner', id: input.practitionerId },
      payload: { event: audit.event, reason: audit.reason, certificate_number: audit.certificateNumber, at: audit.at },
    });
  }
}

/**
 * 判定點 1 與寫入：建立任職（ADR-0017 決議 7）。create_employment 在資料庫內判定並寫入。
 * 管理人員在別家已有已驗證在職時阻擋，不建列。經紀人員提示並要求同意書，仍建待驗證。
 */
async function createEmploymentRow(
  tx: OrgTx,
  input: { practitionerId: string; kind: CertificateKind; number: CertificateNumber; startedOn: string; now: Date },
): Promise<EmploymentCreated | EmploymentBlocked> {
  const { rows } = await tx.query<{ employment_id: string | null; outcome: 'created' | 'blocked'; consent_required: boolean }>(
    'SELECT * FROM registry.create_employment($1, $2, $3::date, $4)',
    [newUlid(), input.practitionerId, input.startedOn, newUlid()],
  );
  const row = rows[0];
  const verdict: CreationVerdict = row.outcome === 'blocked' ? 'blocked' : row.consent_required ? 'consent_required' : 'clear';
  const audited = { practitionerId: input.practitionerId, verdict, number: input.number, now: input.now };
  if (row.outcome === 'blocked') {
    await auditVerdict(tx, audited);
    return { status: 'blocked', message: BLOCKED_MESSAGE };
  }

  const employmentId = row.employment_id!;
  await appendAudit(tx, {
    action: 'employment.create',
    object: { type: 'employment', id: employmentId },
    payload: { certificate_kind: input.kind, consent_required: row.consent_required },
  });
  await auditVerdict(tx, audited);
  return { status: 'created', employmentId, consentRequired: row.consent_required, notice: row.consent_required ? CONSENT_NOTICE : null };
}

// ---------------------------------------------------------------------------
// 登錄證書

export interface RegisterCertificateInput {
  userId: string;
  partyId: string;
  form: CertificateForm;
  /** 已經寫進 FileStore 的證書影本。 */
  files: readonly StoredEvidence[];
  now: Date;
}

export type RegisterCertificateResult =
  | {
      status: 'registered';
      certificateId: string;
      /** 這次新建的任職。補件（任職早就存在）時為 null。 */
      employment: EmploymentCreated | null;
      /** 效期與發證日加 4 年不一致時的提示。 */
      validUntilHint: string | null;
    }
  | EmploymentBlocked
  /** 還沒對目前版本的個資告知表態同意。 */
  | { status: 'consent_required' }
  | { status: 'entity_not_ready' }
  | { status: 'already_verified' };

/**
 * 登錄或補件證書，並在目前執業主體建立待驗證任職（ADR-0022 決議 9 第 3 點）。
 * 證書已驗證（例如換公司）時走 createEmployment，不重送證書。
 * 阻擋時什麼都不寫，只留稽核事件（MIL-186：判定在 submit_practitioner 與 create_employment 內）。
 */
export async function registerCertificate(tx: OrgTx, input: RegisterCertificateInput): Promise<RegisterCertificateResult> {
  if (!(await hasAgreed(tx, input.partyId))) return { status: 'consent_required' };

  const mine = await getMyPractitioner(tx);
  if (!mine.entityRegistered) return { status: 'entity_not_ready' };
  const existing = mine.certificates.find((c) => c.kind === input.form.kind) ?? null;
  const from = existing?.state ?? null;
  const transition = decideCredentialTransition(from, {
    layer: 'practitioner',
    event: from === null ? { type: 'submitted', requiredFieldsComplete: input.files.length > 0 } : { type: 'resubmitted' },
  });
  if (!transition) return { status: 'already_verified' };

  // 專任判定在 submit_practitioner 內，寫任何東西之前。補件時任職早就存在，不再判定
  const hasLiveEmployment = existing !== null && mine.employments.some((e) => e.practitionerId === existing.id && e.state !== 'lapsed');
  const practitionerId = existing?.id ?? newUlid();

  const { rows } = await tx.query<{ practitioner_id: string | null; outcome: 'registered' | 'blocked' }>(
    'SELECT * FROM registry.submit_practitioner($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10)',
    [
      practitionerId,
      input.form.kind,
      input.form.number.year,
      input.form.number.word,
      input.form.number.serial,
      input.form.issuedOn,
      input.form.validUntil,
      from,
      transition.to,
      newUlid(),
    ],
  );
  if (rows[0].outcome === 'blocked') {
    await auditVerdict(tx, { practitionerId, verdict: 'blocked', number: input.form.number, now: input.now });
    return { status: 'blocked', message: BLOCKED_MESSAGE };
  }
  const certificateId = rows[0].practitioner_id!;
  await registerEvidence(tx, { subjectType: 'practitioner', subjectId: certificateId, kind: input.form.kind, uploadedBy: input.userId, files: input.files });
  await appendAudit(tx, {
    action: 'practitioner.submit',
    object: { type: 'practitioner', id: certificateId },
    payload: { certificate_kind: input.form.kind, from, to: transition.to, files: input.files.length },
  });

  let employment: EmploymentCreated | null = null;
  if (!hasLiveEmployment) {
    const created = await createEmploymentRow(tx, {
      practitionerId: certificateId,
      kind: input.form.kind,
      number: input.form.number,
      startedOn: input.form.startedOn,
      now: input.now,
    });
    // 兩次呼叫之間別的請求剛好把別家任職核對成已驗證時才會到這裡。證書已登錄，任職沒建，稽核事件已寫
    if (created.status === 'blocked') return created;
    employment = created;
  }

  const hint = checkValidUntilConsistency(input.form.issuedOn, input.form.validUntil);
  return { status: 'registered', certificateId, employment, validUntilHint: hint.message };
}

// ---------------------------------------------------------------------------
// 換公司：證書已登錄，只建任職

export type CreateEmploymentResult =
  | { status: 'created'; employment: EmploymentCreated }
  | EmploymentBlocked
  | { status: 'consent_required' }
  | { status: 'no_certificate' }
  | { status: 'entity_not_ready' }
  | { status: 'already_employed' };

export async function createEmployment(
  tx: OrgTx,
  input: { partyId: string; certificateId: string; startedOn: string; now: Date },
): Promise<CreateEmploymentResult> {
  const mine = await getMyPractitioner(tx);
  if (!mine.entityRegistered) return { status: 'entity_not_ready' };
  const cert = mine.certificates.find((c) => c.id === input.certificateId);
  if (!cert) return { status: 'no_certificate' };
  if (mine.employments.some((e) => e.practitionerId === cert.id && e.state !== 'lapsed')) return { status: 'already_employed' };
  // 同意是記在登錄時所在的組織。換到新組織要在新組織重新表態
  if (!(await hasAgreed(tx, input.partyId))) return { status: 'consent_required' };

  const created = await createEmploymentRow(tx, { practitionerId: cert.id, kind: cert.kind, number: cert.number, startedOn: input.startedOn, now: input.now });
  if (created.status === 'blocked') return created;
  return { status: 'created', employment: created };
}

// ---------------------------------------------------------------------------
// 所屬業者同意書與結束任職

export type SubmitConsentResult = { status: 'submitted'; itemId: string } | { status: 'not_required' } | { status: 'not_found' };

/** 本人為需要同意書的任職送出同意書。證據檔在同一個交易登記。 */
export async function submitConsentLetter(
  tx: OrgTx,
  input: { userId: string; employmentId: string; files: readonly StoredEvidence[] },
): Promise<SubmitConsentResult> {
  const mine = await getMyPractitioner(tx);
  const employment = mine.employments.find((e) => e.id === input.employmentId);
  if (!employment) return { status: 'not_found' };
  if (!employment.consentRequired || employment.state === 'lapsed' || employment.consentedByEntity) return { status: 'not_required' };

  const { rows } = await tx.query<{ item_id: string }>('SELECT * FROM registry.submit_consent($1, $2)', [input.employmentId, newUlid()]);
  await registerEvidence(tx, {
    subjectType: 'employment_consent',
    subjectId: input.employmentId,
    kind: employment.certificateKind,
    uploadedBy: input.userId,
    files: input.files,
  });
  return { status: 'submitted', itemId: rows[0].item_id };
}

export type EndEmploymentResult = { status: 'ended' } | { status: 'not_found' } | { status: 'not_verified' };

/** 結束已驗證的任職（事件 employment_ended）。權限由資料庫函式檢查：執業主體 admin 或任職本人。 */
export async function endEmployment(tx: OrgTx, input: { employmentId: string; endedOn: string }): Promise<EndEmploymentResult> {
  const all = await listOrgEmployments(tx);
  const employment = all.find((e) => e.id === input.employmentId);
  if (!employment) return { status: 'not_found' };
  const transition = decideCredentialTransition(employment.state, { layer: 'employment', event: { type: 'employment_ended' } });
  if (!transition) return { status: 'not_verified' };
  await tx.query('SELECT registry.end_employment($1, $2::date, $3, $4)', [input.employmentId, input.endedOn, transition.from, transition.to]);
  await appendAudit(tx, {
    action: 'employment.end',
    object: { type: 'employment', id: input.employmentId },
    payload: { ended_on: input.endedOn },
  });
  return { status: 'ended' };
}

/** SQLSTATE 40001：資料庫函式發現狀態已被別的請求改掉。 */
export function isStateConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '40001';
}

/** SQLSTATE 23505：部分唯一索引擋下（同一人在同一家已有未結束的任職，或專任排除約束）。 */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '23505';
}

/** SQLSTATE 23514：已驗證的任職是以舊證號核對的，證號不能改。 */
export function isCheckViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '23514';
}
