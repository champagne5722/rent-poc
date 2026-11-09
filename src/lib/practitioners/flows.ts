import type { ConsentDecision } from '../consent';
import { withTx } from '../pg/database';
import {
  confirmFilesRemoved,
  discardEvidenceFiles,
  removeDeletedFiles,
  storeEvidenceFiles,
  type DeletedEvidence,
} from '../practice-entities/evidence';
import type { FlowDeps, OperatorRun, SubmitActor } from '../practice-entities/flows';
import { deskTicket } from '../practice-entities/ticket';
import {
  createEmployment,
  endEmployment,
  isCheckViolation,
  isStateConflict,
  isUniqueViolation,
  recordCertificateConsent,
  registerCertificate,
  submitConsentLetter,
  type CreateEmploymentResult,
  type EndEmploymentResult,
  type RegisterCertificateResult,
  type SubmitConsentResult,
} from './applicant';
import {
  getCredentialReview,
  recordCertificateCheck,
  recordConsentCheck,
  recordEmploymentCheck,
  type CredentialCheckOutcome,
  type SupplementRequest,
} from './desk';
import { taiwanDate } from './dates';
import { practitionerEmail, sendPractitionerSupplement } from './notify';
import {
  validateCertificateCheckForm,
  validateCertificateForm,
  validateConsentCheckForm,
  validateConsentUpload,
  validateEmploymentCheckForm,
  validateEmploymentForm,
  type CertificateCheckField,
  type CertificateField,
} from './rules';
import { isUlid } from '../pg/ulid';

// 把「資料庫交易」和「交易外的事」（寫檔、刪檔、寄信）接起來的流程（MIL-111）。
// route 只負責認證、權限與解析請求，規則和順序都在這裡，所以可以不經 HTTP 直接測。順序的原則同 MIL-109：
// - 交易內不做外部 I/O（ADR-0012 決議 10）。登錄與送同意書：先寫 FileStore，再開交易登記，沒成功就把檔案刪掉。
// - 核對：交易內標記證書影本刪除並寫稽核事件，提交後才刪檔案。補件通知在提交後寄，寄不出去不影響核對結果。

const now = (deps: FlowDeps): Date => (deps.now ?? (() => new Date()))();

/** 登錄證書與任職的人必須是執業主體組織的成員。角色（含唯讀）不限：證書是本人的資料。 */
const isPracticeMember = (actor: SubmitActor): boolean => actor.orgKind === 'practice';

type Conflict = { status: 'conflict' } | { status: 'number_locked' };

function conflictOf(error: unknown): Conflict | null {
  if (isStateConflict(error) || isUniqueViolation(error)) return { status: 'conflict' };
  if (isCheckViolation(error)) return { status: 'number_locked' };
  return null;
}

// ---------------------------------------------------------------------------
// 告知與同意

export type ConsentFlowResult = { status: 'recorded'; decision: ConsentDecision } | { status: 'forbidden' } | { status: 'invalid' };

/** 開啟證書登錄頁後，成員對「證書資料個資告知」目前版本表態（P0-24 AC3）。 */
export async function recordConsentFlow(actor: SubmitActor, raw: { decision?: unknown }): Promise<ConsentFlowResult> {
  if (!isPracticeMember(actor)) return { status: 'forbidden' };
  if (raw.decision !== 'agree' && raw.decision !== 'object') return { status: 'invalid' };
  const decision: ConsentDecision = raw.decision;
  await withTx({ kind: 'org', orgId: actor.orgId, partyId: actor.partyId }, (tx) => recordCertificateConsent(tx, actor.partyId, decision));
  return { status: 'recorded', decision };
}

// ---------------------------------------------------------------------------
// 登錄證書

export type RegisterFlowResult =
  | RegisterCertificateResult
  | { status: 'invalid'; field: CertificateField; message: string }
  | { status: 'forbidden' }
  /** 狀態在送件之間被改動（例如營運者剛好核對完），或同一個人在同一家剛建了任職。重新整理後再送。 */
  | { status: 'conflict' }
  /** 已驗證的任職是以舊證號核對的，證號不能改。 */
  | { status: 'number_locked' };

export async function registerCertificateFlow(
  actor: SubmitActor,
  raw: Record<string, unknown>,
  deps: FlowDeps,
): Promise<RegisterFlowResult> {
  if (!isPracticeMember(actor)) return { status: 'forbidden' };
  const at = now(deps);
  const form = validateCertificateForm(raw, taiwanDate(at));
  if (!form.ok) return { status: 'invalid', field: form.field, message: form.message };

  const stored = await storeEvidenceFiles(deps.store, actor.orgId, form.value.files);
  let result: RegisterCertificateResult;
  try {
    result = await withTx({ kind: 'org', orgId: actor.orgId, partyId: actor.partyId }, (tx) =>
      registerCertificate(tx, { userId: actor.userId, partyId: actor.partyId, form: form.value, files: stored, now: at }),
    );
  } catch (error) {
    await discardEvidenceFiles(deps.store, stored);
    const conflict = conflictOf(error);
    if (conflict) return conflict;
    throw error;
  }
  if (result.status !== 'registered') await discardEvidenceFiles(deps.store, stored);
  return result;
}

export type CreateEmploymentFlowResult =
  | CreateEmploymentResult
  | { status: 'invalid'; field: 'startedOn'; message: string }
  | { status: 'forbidden' }
  | { status: 'conflict' };

/** 換公司：證書已登錄，在目前執業主體建立待驗證任職。 */
export async function createEmploymentFlow(
  actor: SubmitActor,
  raw: { certificateId?: unknown; startedOn?: unknown },
  deps: FlowDeps,
): Promise<CreateEmploymentFlowResult> {
  if (!isPracticeMember(actor)) return { status: 'forbidden' };
  const at = now(deps);
  const form = validateEmploymentForm(raw, taiwanDate(at));
  if (!form.ok) return { status: 'invalid', field: form.field, message: form.message };
  if (typeof raw.certificateId !== 'string' || !isUlid(raw.certificateId)) return { status: 'no_certificate' };
  const certificateId = raw.certificateId;
  try {
    return await withTx({ kind: 'org', orgId: actor.orgId, partyId: actor.partyId }, (tx) =>
      createEmployment(tx, { partyId: actor.partyId, certificateId, startedOn: form.value.startedOn, now: at }),
    );
  } catch (error) {
    if (isStateConflict(error) || isUniqueViolation(error)) return { status: 'conflict' };
    throw error;
  }
}

export type ConsentLetterFlowResult =
  | SubmitConsentResult
  | { status: 'invalid'; field: 'files'; message: string }
  | { status: 'forbidden' }
  | { status: 'conflict' };

/** 經紀人員掛第二家時，上傳所屬業者的同意書（P0-05 AC3）。 */
export async function submitConsentLetterFlow(
  actor: SubmitActor,
  employmentId: string,
  raw: { files?: unknown },
  deps: FlowDeps,
): Promise<ConsentLetterFlowResult> {
  if (!isPracticeMember(actor)) return { status: 'forbidden' };
  const form = validateConsentUpload(raw);
  if (!form.ok) return { status: 'invalid', field: form.field, message: form.message };
  if (!isUlid(employmentId)) return { status: 'not_found' };

  const stored = await storeEvidenceFiles(deps.store, actor.orgId, form.value.files);
  let result: SubmitConsentResult;
  try {
    result = await withTx({ kind: 'org', orgId: actor.orgId, partyId: actor.partyId }, (tx) =>
      submitConsentLetter(tx, { userId: actor.userId, employmentId, files: stored }),
    );
  } catch (error) {
    await discardEvidenceFiles(deps.store, stored);
    if (isStateConflict(error) || isUniqueViolation(error)) return { status: 'conflict' };
    throw error;
  }
  if (result.status !== 'submitted') await discardEvidenceFiles(deps.store, stored);
  return result;
}

export type EndEmploymentFlowResult =
  | EndEmploymentResult
  | { status: 'invalid'; field: 'endedOn'; message: string }
  | { status: 'forbidden' }
  | { status: 'conflict' };

export async function endEmploymentFlow(
  actor: SubmitActor,
  employmentId: string,
  raw: { endedOn?: unknown },
  deps: FlowDeps,
): Promise<EndEmploymentFlowResult> {
  if (!isPracticeMember(actor)) return { status: 'forbidden' };
  const endedOn = typeof raw.endedOn === 'string' && raw.endedOn.trim() !== '' ? raw.endedOn.trim() : taiwanDate(now(deps));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endedOn)) return { status: 'invalid', field: 'endedOn', message: '結束日格式不正確' };
  if (!isUlid(employmentId)) return { status: 'not_found' };
  try {
    return await withTx({ kind: 'org', orgId: actor.orgId, partyId: actor.partyId }, (tx) => endEmployment(tx, { employmentId, endedOn }));
  } catch (error) {
    if (isStateConflict(error)) return { status: 'conflict' };
    // 42501：不是 admin 也不是任職本人。與「找不到」同一個回應，不透露別人的任職是否存在
    if ((error as { code?: unknown } | null)?.code === '42501') return { status: 'forbidden' };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 審核台

async function afterCommitRemoveFiles(run: OperatorRun, deps: FlowDeps, ticket: string, deleted: readonly DeletedEvidence[]): Promise<void> {
  if (deleted.length === 0) return;
  const removed = await removeDeletedFiles(deps.store, deleted);
  if (removed.length > 0) await run(ticket, (tx) => confirmFilesRemoved(tx, removed));
}

async function notifyPractitioner(request: SupplementRequest, deps: FlowDeps): Promise<void> {
  const email = await withTx({ kind: 'control' }, (tx) => practitionerEmail(tx, request.partyId));
  if (email) await sendPractitionerSupplement(deps.mailer, email, request);
}

export type CredentialCheckFlowResult =
  | CredentialCheckOutcome
  | { status: 'invalid'; field: CertificateCheckField; message: string }
  | { status: 'conflict' }
  /** 同一證號已有另一位已驗證的執業人員。營運者要先判定哪一位是本人。 */
  | { status: 'certificate_taken'; message: string }
  /** 資料庫的專任排除約束擋下（兩位營運者同時核對同一證號的兩家任職）。 */
  | { status: 'exclusivity_blocked'; message: string };

const CERTIFICATE_TAKEN_MESSAGE = '此證號已有另一位已驗證的執業人員，請先判定哪一位是本人';
const EXCLUSIVITY_MESSAGE = '此證號已有已驗證的專任任職，請依 resim 任職查詢判定哪一家相符';

function constraintOf(error: unknown): string {
  const e = error as { constraint?: unknown; message?: unknown } | null;
  return `${typeof e?.constraint === 'string' ? e.constraint : ''} ${typeof e?.message === 'string' ? e.message : ''}`;
}

/**
 * 登錄證書、任職或同意書的核對。依項目類型選表單與函式。
 * 專任阻擋時回傳 exclusivity_blocked 而不是丟錯：稽核事件要跟著交易提交（P0-05 AC6）。
 */
export async function recordCredentialCheckFlow(
  run: OperatorRun,
  itemId: string,
  raw: Record<string, unknown>,
  deps: FlowDeps,
): Promise<CredentialCheckFlowResult> {
  const ticket = deskTicket('item', itemId);
  const review = await run(ticket, (tx) => getCredentialReview(tx, itemId));
  if (!review) return { status: 'not_found' };

  const type = review.item.type;
  const form =
    type === 'certificate' ? validateCertificateCheckForm(raw) : type === 'employment' ? validateEmploymentCheckForm(raw) : validateConsentCheckForm(raw);
  if (!form.ok) return { status: 'invalid', field: form.field, message: form.message };

  let outcome: CredentialCheckOutcome;
  try {
    outcome = await run(ticket, (tx) =>
      type === 'certificate'
        ? recordCertificateCheck(tx, itemId, form.value)
        : type === 'employment'
          ? recordEmploymentCheck(tx, itemId, form.value, now(deps))
          : recordConsentCheck(tx, itemId, form.value),
    );
  } catch (error) {
    if (isStateConflict(error)) return { status: 'conflict' };
    if (isUniqueViolation(error)) {
      const where = constraintOf(error);
      if (where.includes('practitioners_one_verified_per_cert')) return { status: 'certificate_taken', message: CERTIFICATE_TAKEN_MESSAGE };
      if (where.includes('employments_exclusive_verified')) return { status: 'exclusivity_blocked', message: EXCLUSIVITY_MESSAGE };
      return { status: 'conflict' };
    }
    throw error;
  }
  if (outcome.status !== 'recorded') return outcome;

  await afterCommitRemoveFiles(run, deps, ticket, outcome.deletedEvidence);
  if (outcome.supplement) await notifyPractitioner(outcome.supplement, deps);
  return outcome;
}
