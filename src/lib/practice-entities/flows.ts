import type { FileStore } from '../file-store';
import { sha256Hex } from '../file-store';
import type { Mailer } from '../mailer';
import { withTx } from '../pg/database';
import type { OrgTx } from '../pg/with-tx';
import type { OrgRole } from '../request-context';
import {
  recordLicenseCheck,
  resolveEntityClaim,
  type CheckOutcome,
  type ClaimDecision,
  type ClaimOutcome,
} from './desk';
import { applicantMayWrite } from './access';
import { isStateConflict, submitLicense, type SubmitResult } from './applicant';
import {
  confirmFilesRemoved,
  discardEvidenceFiles,
  openEvidence,
  removeDeletedFiles,
  storeEvidenceFiles,
  type DeletedEvidence,
} from './evidence';
import { adminRecipients, sendSupplementRequested } from './notify';
import { validateCheckForm, validateSubmission, type CheckField, type SubmissionField } from './rules';

// 把「資料庫交易」和「交易外的事」（寫檔、刪檔、寄信）接起來的流程（MIL-109）。
// route 只負責認證與解析請求，規則和順序都在這裡，所以可以不經 HTTP 直接測。
//
// 順序的原則：交易內不做外部 I/O（ADR-0012 決議 10）。
// - 送件：先寫 FileStore，再開交易登記。交易沒成功就把檔案刪掉。
// - 核對與認領：交易內標記證據檔刪除並寫稽核事件，提交後才刪檔案，再另開交易登記「檔案已刪」。
//   提交後刪檔失敗不影響核對結果，資料庫標記還在，pending_file_removals() 找得到它。
// - 補件通知：提交後寄。寄不出去不影響核對結果，站內頁面仍看得到判定理由。

export interface FlowDeps {
  store: FileStore;
  mailer: Mailer;
  now?: () => Date;
}

/** 在平台營運者脈絡開一個交易。production 由 route 用 withTx 的 operator 脈絡組出，測試直接傳。 */
export type OperatorRun = <R>(ticketId: string, fn: (tx: OrgTx) => Promise<R>) => Promise<R>;

// ---------------------------------------------------------------------------
// 執業主體送件

export interface SubmitActor {
  orgId: string;
  orgKind: 'owner' | 'practice' | 'platform';
  role: OrgRole;
  userId: string;
  partyId: string;
}

export type SubmitFlowResult =
  | SubmitResult
  | { status: 'invalid'; field: SubmissionField; message: string }
  | { status: 'forbidden' }
  /** 業別的狀態在送件之間被改動（例如營運者剛好核對完）。重新整理後再送。 */
  | { status: 'conflict' };

export async function submitLicenseFlow(
  actor: SubmitActor,
  raw: { kind?: unknown; permitNo?: unknown; files?: unknown },
  deps: FlowDeps,
): Promise<SubmitFlowResult> {
  if (!applicantMayWrite(actor)) return { status: 'forbidden' };
  const form = validateSubmission(raw);
  if (!form.ok) return { status: 'invalid', field: form.field, message: form.message };

  const stored = await storeEvidenceFiles(deps.store, actor.orgId, form.value.files);
  let result: SubmitResult | undefined;
  try {
    result = await withTx({ kind: 'org', orgId: actor.orgId, partyId: actor.partyId }, (tx) =>
      submitLicense(tx, { userId: actor.userId, kind: form.value.kind, permitNo: form.value.permitNo, files: stored }),
    );
  } catch (error) {
    await discardEvidenceFiles(deps.store, stored);
    if (isStateConflict(error)) return { status: 'conflict' };
    throw error;
  }
  if (result.status !== 'submitted') await discardEvidenceFiles(deps.store, stored);
  return result;
}

// ---------------------------------------------------------------------------
// 審核台

async function afterCommitRemoveFiles(run: OperatorRun, deps: FlowDeps, ticketId: string, deleted: readonly DeletedEvidence[]): Promise<void> {
  if (deleted.length === 0) return;
  const removed = await removeDeletedFiles(deps.store, deleted);
  if (removed.length > 0) await run(ticketId, (tx) => confirmFilesRemoved(tx, removed));
}

async function notifyOrg(orgId: string, note: string, deps: FlowDeps): Promise<void> {
  const recipients = await withTx({ kind: 'control' }, (tx) => adminRecipients(tx, orgId));
  await sendSupplementRequested(deps.mailer, recipients, note);
}

export type CheckFlowResult = CheckOutcome | { status: 'invalid'; field: CheckField; message: string } | { status: 'conflict' };

export async function recordCheckFlow(run: OperatorRun, itemId: string, raw: Record<string, unknown>, deps: FlowDeps): Promise<CheckFlowResult> {
  const form = validateCheckForm(raw);
  if (!form.ok) return { status: 'invalid', field: form.field, message: form.message };

  const ticket = `desk:item:${itemId}`;
  let outcome: CheckOutcome;
  try {
    outcome = await run(ticket, (tx) => recordLicenseCheck(tx, itemId, form.value));
  } catch (error) {
    if (isStateConflict(error)) return { status: 'conflict' };
    throw error;
  }
  if (outcome.status !== 'recorded') return outcome;

  await afterCommitRemoveFiles(run, deps, ticket, outcome.deletedEvidence);
  if (outcome.supplement) await notifyOrg(outcome.supplement.orgId, outcome.supplement.note, deps);
  return outcome;
}

export type ClaimFlowResult = ClaimOutcome | { status: 'invalid'; field: 'decision' | 'note'; message: string } | { status: 'conflict' };

export async function resolveClaimFlow(run: OperatorRun, itemId: string, raw: { decision?: unknown; note?: unknown }, deps: FlowDeps): Promise<ClaimFlowResult> {
  if (raw.decision !== 'keep_registrant' && raw.decision !== 'to_claimant') return { status: 'invalid', field: 'decision', message: '請選擇判定結果' };
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (note === '') return { status: 'invalid', field: 'note', message: '判定歸屬請寫理由' };
  if (note.length > 500) return { status: 'invalid', field: 'note', message: '理由不得超過 500 字' };
  const decision: ClaimDecision = raw.decision;

  const ticket = `desk:item:${itemId}`;
  let outcome: ClaimOutcome;
  try {
    outcome = await run(ticket, (tx) => resolveEntityClaim(tx, itemId, decision, note));
  } catch (error) {
    if (isStateConflict(error)) return { status: 'conflict' };
    throw error;
  }
  if (outcome.status !== 'resolved') return outcome;

  await afterCommitRemoveFiles(run, deps, ticket, outcome.deletedEvidence);
  // 維持原登錄者：認領方需要補件。改歸屬給認領方：認領方在頁面上看到自己的登錄，不寄信
  if (decision === 'keep_registrant') await notifyOrg(outcome.claimantOrgId, note, deps);
  return outcome;
}

export type OpenEvidenceResult =
  | { status: 'ok'; bytes: Uint8Array; contentType: string; fileName: string }
  | { status: 'not_found' }
  /** 中繼資料還在但 FileStore 找不到檔案，或內容的 SHA-256 與登記時不同。 */
  | { status: 'file_missing' }
  | { status: 'file_corrupted' };

/** 開啟證據檔。先在交易內寫 vault.read，提交後才讀檔案；沒有紀錄就沒有讀取。 */
export async function openEvidenceFlow(run: OperatorRun, evidenceId: string, deps: FlowDeps): Promise<OpenEvidenceResult> {
  const opened = await run(`desk:evidence:${evidenceId}`, (tx) => openEvidence(tx, evidenceId));
  if (!opened) return { status: 'not_found' };
  const bytes = await deps.store.read(opened.key);
  if (!bytes) return { status: 'file_missing' };
  if (sha256Hex(bytes) !== opened.sha256) return { status: 'file_corrupted' };
  return { status: 'ok', bytes, contentType: opened.contentType, fileName: opened.fileName };
}
