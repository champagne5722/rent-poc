import type { FileStore } from '../file-store';
import { newUlid } from '../pg/ulid';
import { deskTicket } from '../practice-entities/ticket';
import type { OwnershipConflictBasis, OwnershipConflictDecision, OwnershipConflictView } from '../types';
import { decideConflict, getConflict, insertContact, type ConflictNotice } from './conflict-repository';
import { matchesOfBasis, validateConflictDecisionForm, validateContactForm, type ConflictDecisionField, type ContactFormField } from './conflict-forms';
import { getReviewHeader, type OperatorRuns } from './desk';
import { readTranscriptBytes, type OpenFileResult } from './flows';
import {
  FAILED_NOTIFICATION_KIND,
  FAILED_NOTIFICATION_TITLE,
  LAPSED_NOTIFICATION,
  VERIFIED_NOTIFICATION,
  failedNotificationBody,
} from './messages';
import { getSubmissionById, openTranscript } from './repository';

// 兩方都通過核對時，營運者處理衝突的流程（MIL-208，ADR-0028 決議 4，ADR-0025 決議 11）。
// route 只負責認證與解析請求，這裡把資料庫函式和「交易外的事」接起來。
//
// 與後來的一方有關的規則：
// - 讀衝突個案（getConflictFlow）只讀平台的 registry 表和先前的一方的組織。不進後來的一方的組織，
//   所以後來的一方的鏈不會因為營運者看了衝突而多事件。後來的一方的取得時間在項目詳情（GET /api/desk/ownership/[id]）。
// - 聯絡紀錄（recordContactFlow）只在平台脈絡，不進任何一方的組織。
// - 決定（decideConflictFlow）在後來的一方的 operator 脈絡，工單號與一般判定相同（desk:decide:<項目編號>）。
//   先前的一方的存取事件、失效與通知由資料庫函式在同一個交易處理。

export type GetConflictResult = { status: 'ok'; conflict: OwnershipConflictView } | { status: 'not_found' };

/** 衝突個案的並列內容。先前的一方的取得時間要讀它的組織（寫一筆營運者存取事件到它的鏈，工單號只含它自己的節點 ID）。 */
export async function getConflictFlow(runs: OperatorRuns, itemId: string): Promise<GetConflictResult> {
  const conflict = await runs.platform(deskTicket('ownership', itemId), (tx) => getConflict(tx, itemId));
  if (!conflict) return { status: 'not_found' };
  const earlier = conflict.earlier;
  if (earlier.submissionId) {
    const submissionId = earlier.submissionId;
    const submission = await runs.inOrg(earlier.orgId, deskTicket('ownership', earlier.nodeId), (tx) => getSubmissionById(tx, submissionId));
    if (submission) earlier.acquiredAt = submission.acquired_at;
  }
  return { status: 'ok', conflict };
}

export type RecordContactResult =
  | { status: 'recorded'; contactId: string }
  | { status: 'invalid'; field: ContactFormField; message: string }
  | { status: 'not_found' };

/** 記一筆聯絡。記錄人由資料庫從交易脈絡取。 */
export async function recordContactFlow(runs: OperatorRuns, itemId: string, raw: Record<string, unknown>, now: Date = new Date()): Promise<RecordContactResult> {
  const form = validateContactForm(raw, now);
  if (!form.ok) return { status: 'invalid', field: form.field, message: form.message };
  const contactId = newUlid();
  const result = await runs.platform(deskTicket('contact', itemId), (tx) => insertContact(tx, itemId, contactId, form.value));
  return result === 'recorded' ? { status: 'recorded', contactId } : { status: 'not_found' };
}

export type DecideConflictResult =
  | { status: 'decided'; decision: OwnershipConflictDecision; affectedCaseCount: number }
  | { status: 'invalid'; field: ConflictDecisionField; message: string }
  | { status: 'not_found' }
  | { status: 'already_decided' }
  /** 資料庫拒絕：個案或節點的狀態已變，或鍵有多個並存的節點時讓後來的成立。 */
  | { status: 'rejected'; message: string };

/** 三種決定各自要寄的站內通知。後來的一方的內容和一般判定完全相同；先前的一方只有失效時有。 */
export function noticesFor(
  decision: OwnershipConflictDecision,
  basis: OwnershipConflictBasis | null,
): { later: ConflictNotice; earlier: ConflictNotice | null } {
  if (decision === 'later_rejected') {
    return {
      later: { id: newUlid(), kind: FAILED_NOTIFICATION_KIND, title: FAILED_NOTIFICATION_TITLE, body: failedNotificationBody(matchesOfBasis(basis!)) },
      earlier: null,
    };
  }
  return {
    later: { id: newUlid(), ...VERIFIED_NOTIFICATION },
    earlier: decision === 'later_prevails' ? { id: newUlid(), ...LAPSED_NOTIFICATION } : null,
  };
}

/** 營運者決定。先前的一方既有的案件與合約不自動取消，回傳進行中的案件數給營運者看。 */
export async function decideConflictFlow(runs: OperatorRuns, itemId: string, raw: Record<string, unknown>): Promise<DecideConflictResult> {
  const form = validateConflictDecisionForm(raw);
  if (!form.ok) return { status: 'invalid', field: form.field, message: form.message };
  const header = await runs.platform(deskTicket('ownership', itemId), (tx) => getReviewHeader(tx, itemId));
  if (!header || header.type !== 'leasing_authority' || !header.conflictId) return { status: 'not_found' };
  if (header.conflictStatus === 'decided') return { status: 'already_decided' };

  const { decision, reason, basis } = form.value;
  try {
    const row = await runs.inOrg(header.claimantOrgId, deskTicket('decide', itemId), (tx) =>
      decideConflict(tx, itemId, { decision, reason, basis }, newUlid(), noticesFor(decision, basis)),
    );
    if (row.outcome === 'not_found') return { status: 'not_found' };
    if (row.outcome === 'already_decided') return { status: 'already_decided' };
    return { status: 'decided', decision: row.outcome, affectedCaseCount: row.affectedCaseCount };
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    if (code === '55000' || code === '0A000') return { status: 'rejected', message: message ?? '無法決定' };
    throw error;
  }
}

/** 營運者開啟先前的一方的謄本原檔。資料庫函式在先前的一方的鏈寫稽核事件（vault.read，行為者是營運者），再讀檔。 */
export async function openConflictPeerFile(runs: OperatorRuns, itemId: string, store: FileStore): Promise<OpenFileResult> {
  const conflict = await runs.platform(deskTicket('ownership', itemId), (tx) => getConflict(tx, itemId));
  const earlier = conflict?.earlier;
  if (!earlier?.submissionId) return { status: 'not_found' };
  const submissionId = earlier.submissionId;
  const opened = await runs.inOrg(earlier.orgId, deskTicket('file', earlier.nodeId), (tx) => openTranscript(tx, submissionId));
  if (!opened) return { status: 'not_found' };
  return readTranscriptBytes(store, opened);
}
