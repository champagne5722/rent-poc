import { appendAudit } from '../audit';
import { currentNotice, latestConsent, NOTICE_CATALOG, recordConsent } from '../consent';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { PropertyOwnership, OwnershipSubmissionView, OwnershipTrustView } from '../types';
import type { TrustItem } from '../leasing-authority/preconditions';
import type { OwnershipGate } from './gate';
import { AWAITING_REVIEW_MESSAGE, NOT_SUBMITTED_MESSAGE, VERIFIED_NOTE, mismatchMessages } from './messages';
import type { TranscriptForm } from './forms';
import { toPropertyVerificationStatus, type OwnershipStatus } from './status';

// 所有權節點與謄本送件的資料層（MIL-201，ADR-0026、ADR-0028 決議 3）。組織脈絡內呼叫（org 或 operator 進入的組織）。
// 規則：
// - 一律由物件（org.properties）找到它所屬的錨點，再找這個組織在該錨點的節點。別的組織的物件與不存在的物件結果相同。
// - 節點與送件的狀態轉移由資料庫函式執行，這裡不直接 UPDATE。
// - 稽核 payload 只放 ID 與計數，不放姓名、建號與檔名（寫入後刪不掉）。

/** 謄本個資告知的類型（consent 模組的 NOTICE_TYPES）。 */
export const TRANSCRIPT_NOTICE = 'transcript_id_pii' as const;

interface PropertyAnchorRow {
  anchor_id: string;
  building_no: string | null;
  archived_at: Date | null;
}

/** 物件所屬的錨點。物件不存在（含別的組織的）回 null。建號用呼叫者看到的鍵（撞號時是宣稱的鍵）。 */
async function lookupAnchor(tx: OrgTx, propertyId: string): Promise<{ anchorId: string; hasKey: boolean; archived: boolean } | null> {
  const { rows: props } = await tx.query<{ rental_unit_id: string; archived_at: Date | null }>(
    'SELECT rental_unit_id, archived_at FROM org.properties WHERE id = $1',
    [propertyId],
  );
  if (!props[0]) return null;
  const { rows } = await tx.query<Pick<PropertyAnchorRow, 'anchor_id' | 'building_no'>>(
    'SELECT anchor_id, building_no FROM registry.get_anchors_for_units($1::text[])',
    [[props[0].rental_unit_id]],
  );
  if (!rows[0]) return null;
  return { anchorId: rows[0].anchor_id, hasKey: rows[0].building_no !== null, archived: props[0].archived_at !== null };
}

interface NodeRow {
  id: string;
  anchor_id: string;
  status: OwnershipStatus;
  current_submission_id: string | null;
  key_match: boolean | null;
  holder_match: boolean | null;
  holder_masked: string | null;
  checked_at: Date | null;
}

const NODE_COLUMNS = 'id, anchor_id, status, current_submission_id, key_match, holder_match, holder_masked, checked_at';

/** 這個組織在這個錨點未失效的節點。沒有回 null。 */
async function findActiveNode(tx: OrgTx, anchorId: string): Promise<NodeRow | null> {
  const { rows } = await tx.query<NodeRow>(`SELECT ${NODE_COLUMNS} FROM org.ownership_nodes WHERE anchor_id = $1 AND status <> 'lapsed'`, [anchorId]);
  return rows[0] ?? null;
}

/**
 * 一批錨點的節點狀態，給物件列表與物件詳情的 verification_status 用。沒有節點或節點已失效的錨點不在結果內。
 * 只讀呼叫者組織自己的節點（RLS）。
 */
export async function fetchOwnershipStatuses(tx: OrgTx, anchorIds: readonly string[]): Promise<Map<string, OwnershipStatus>> {
  if (anchorIds.length === 0) return new Map();
  const { rows } = await tx.query<{ anchor_id: string; status: OwnershipStatus }>(
    `SELECT anchor_id, status FROM org.ownership_nodes WHERE anchor_id = ANY($1::text[]) AND status <> 'lapsed'`,
    [[...anchorIds]],
  );
  return new Map(rows.map((r) => [r.anchor_id, r.status]));
}

interface GateRow {
  node_id: string;
  status: OwnershipStatus;
  submission_id: string | null;
  has_trust: boolean | null;
  trust_registered_owner: string | null;
  trust_related_parties: string | null;
  trust_registration_status: string | null;
  trust_lease_clause: string | null;
}

const filled = (value: string | null): boolean => value !== null && value.trim() !== '';

/**
 * 建立案件與送簽的唯一讀取入口（MIL-205，ADR-0028 決議 5）：這個組織對這個租賃單位有沒有已驗證的所有權節點。
 * 由租賃單位找到錨點，再找呼叫者組織在該錨點的節點。節點只讀自己組織的（RLS），所以別的組織的租賃單位、
 * 不存在的租賃單位與沒有節點的結果相同：`nodeStatus` 是 null。
 * 有未失效的節點時取它，否則取最近一個已失效的節點，讓呼叫端分得出「已失效」與「沒有節點」。
 * 這個函式只讀。節點失效的入口與 registry.verified_ownership_keys 的清除不在這裡（MIL-208）。
 */
export async function getOwnershipGate(tx: OrgTx, rentalUnitId: string): Promise<OwnershipGate> {
  const { rows } = await tx.query<GateRow>(
    `SELECT n.id AS node_id, n.status, s.id AS submission_id, s.has_trust,
            s.trust_registered_owner, s.trust_related_parties, s.trust_registration_status, s.trust_lease_clause
       FROM registry.get_anchors_for_units($1::text[]) a
       JOIN org.ownership_nodes n ON n.anchor_id = a.anchor_id
       LEFT JOIN org.ownership_submissions s ON s.id = n.current_submission_id
      ORDER BY (n.status = 'lapsed'), n.status_changed_at DESC, n.id DESC
      LIMIT 1`,
    [[rentalUnitId]],
  );
  const row = rows[0];
  if (!row) return { nodeStatus: null, node: null };
  const trustRegistered = row.has_trust === true;
  const trustItemsProvided: TrustItem[] = [];
  if (trustRegistered) {
    if (filled(row.trust_registered_owner)) trustItemsProvided.push('trust_registered_owner');
    if (filled(row.trust_related_parties)) trustItemsProvided.push('trust_parties');
    if (filled(row.trust_registration_status)) trustItemsProvided.push('trust_registration_status');
    if (filled(row.trust_lease_clause)) trustItemsProvided.push('trust_leasing_power_clause');
  }
  return {
    nodeStatus: row.status,
    node: { id: row.node_id, hasSubmission: row.submission_id !== null, trustRegistered, trustItemsProvided },
  };
}

interface SubmissionRow {
  id: string;
  seq: number;
  claimed_owner_name: string;
  acquired_at: Date;
  has_trust: boolean;
  trust_registered_owner: string | null;
  trust_related_parties: string | null;
  trust_registration_status: string | null;
  trust_lease_clause: string | null;
  content_type: string;
  file_name: string;
  byte_size: string | number;
  submitted_at: Date;
}

// 明確列欄位：object_key 與 sha256 app_rw 讀不到，原檔只經 org.read_ownership_file
const SUBMISSION_COLUMNS = `id, seq, claimed_owner_name, acquired_at, has_trust, trust_registered_owner, trust_related_parties,
  trust_registration_status, trust_lease_clause, content_type, file_name, byte_size, submitted_at`;

function toTrust(row: SubmissionRow): OwnershipTrustView | null {
  if (!row.has_trust) return null;
  return {
    registered_owner: row.trust_registered_owner ?? '',
    related_parties: row.trust_related_parties ?? '',
    registration_status: row.trust_registration_status ?? '',
    lease_clause: row.trust_lease_clause ?? '',
  };
}

export function toSubmissionView(row: SubmissionRow): OwnershipSubmissionView {
  return {
    id: row.id,
    seq: row.seq,
    claimed_owner_name: row.claimed_owner_name,
    acquired_at: row.acquired_at.toISOString(),
    submitted_at: row.submitted_at.toISOString(),
    trust: toTrust(row),
    file_name: row.file_name,
    content_type: row.content_type,
    byte_size: Number(row.byte_size),
  };
}

/** 節點的送件，新的在前。 */
export async function listSubmissions(tx: OrgTx, nodeId: string): Promise<OwnershipSubmissionView[]> {
  const { rows } = await tx.query<SubmissionRow>(
    `SELECT ${SUBMISSION_COLUMNS} FROM org.ownership_submissions WHERE node_id = $1 ORDER BY seq DESC`,
    [nodeId],
  );
  return rows.map(toSubmissionView);
}

/** 使用者看到的訊息，依節點狀態決定。固定文字在 messages.ts。 */
function messagesFor(node: NodeRow | null): string[] {
  if (!node || node.status === 'lapsed') return [NOT_SUBMITTED_MESSAGE];
  switch (node.status) {
    case 'pending_verification':
      return [AWAITING_REVIEW_MESSAGE];
    case 'verified':
      return [VERIFIED_NOTE];
    case 'failed':
      return mismatchMessages({ keyMatch: node.key_match === true, holderMatch: node.holder_match === true });
  }
}

/**
 * 物件頁的所有權文件狀態。找不到物件（含別的組織的）回 null。
 * partyId 是目前的使用者，用來查個資告知的同意。
 * can_submit：有建號、物件未封存，而且沒有節點或節點驗證失敗。
 */
export async function getPropertyOwnership(tx: OrgTx, propertyId: string, partyId: string): Promise<PropertyOwnership | null> {
  const anchor = await lookupAnchor(tx, propertyId);
  if (!anchor) return null;
  const node = await findActiveNode(tx, anchor.anchorId);
  const submissions = node ? await listSubmissions(tx, node.id) : [];
  const notice = currentNotice(NOTICE_CATALOG, TRANSCRIPT_NOTICE);
  const consent = await latestConsent(tx, { notice: TRANSCRIPT_NOTICE, subject: { partyId } });

  return {
    property_id: propertyId,
    verification_status: toPropertyVerificationStatus(node?.status ?? null),
    node_status: node?.status ?? null,
    messages: messagesFor(node),
    verified_note: node?.status === 'verified' ? VERIFIED_NOTE : null,
    checked_at: node?.checked_at ? node.checked_at.toISOString() : null,
    holder_masked: node?.status === 'verified' || node?.status === 'failed' ? node.holder_masked : null,
    submission: submissions[0] ?? null,
    submission_count: submissions.length,
    has_key: anchor.hasKey,
    can_submit: anchor.hasKey && !anchor.archived && (node === null || node.status === 'failed'),
    consent: {
      notice_type: TRANSCRIPT_NOTICE,
      version: notice.version,
      title: notice.title,
      text: notice.text,
      agreed: consent?.decision === 'agree' && consent.isCurrentVersion,
    },
  };
}

/** 這個組織對物件的節點狀態。物件不存在（含別的組織的）、沒有節點或節點已失效回 null。 */
export async function getOwnershipNodeStatus(tx: OrgTx, propertyId: string): Promise<OwnershipStatus | null> {
  const anchor = await lookupAnchor(tx, propertyId);
  if (!anchor) return null;
  return (await findActiveNode(tx, anchor.anchorId))?.status ?? null;
}

/** 使用者同意（或反對）謄本個資告知。同交易寫稽核事件。找不到物件回 false。 */
export async function recordTranscriptConsent(tx: OrgTx, propertyId: string, partyId: string, decision: 'agree' | 'object'): Promise<boolean> {
  const anchor = await lookupAnchor(tx, propertyId);
  if (!anchor) return false;
  await recordConsent(tx, { notice: TRANSCRIPT_NOTICE, subject: { partyId }, decision, source: 'in_app' });
  return true;
}

export type PrecheckResult =
  | { ok: true; anchorId: string }
  | { ok: false; reason: 'not_found' | 'archived' | 'no_key' | 'consent_required' | 'already_pending' | 'already_verified' };

/** 送件前的檢查。順序固定：物件存在、未封存、有建號、已同意告知、節點狀態。 */
export async function precheckSubmission(tx: OrgTx, propertyId: string, partyId: string): Promise<PrecheckResult> {
  const anchor = await lookupAnchor(tx, propertyId);
  if (!anchor) return { ok: false, reason: 'not_found' };
  if (anchor.archived) return { ok: false, reason: 'archived' };
  if (!anchor.hasKey) return { ok: false, reason: 'no_key' };
  const consent = await latestConsent(tx, { notice: TRANSCRIPT_NOTICE, subject: { partyId } });
  if (!(consent?.decision === 'agree' && consent.isCurrentVersion)) return { ok: false, reason: 'consent_required' };
  const node = await findActiveNode(tx, anchor.anchorId);
  if (node?.status === 'pending_verification') return { ok: false, reason: 'already_pending' };
  if (node?.status === 'verified') return { ok: false, reason: 'already_verified' };
  return { ok: true, anchorId: anchor.anchorId };
}

export interface StoredTranscript {
  objectKey: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  fileName: string;
  /** FileStore 檔案的 ID，也是送件 ID。 */
  id: string;
}

/** 資料庫函式拒絕送件（物件已合併或停用等）。呼叫端必須讓交易回滾，函式丟錯後交易已中止。 */
export class OwnershipSubmitRejectedError extends Error {}

export type SubmitResult =
  | { kind: 'submitted'; nodeId: string; submissionId: string }
  | { kind: 'already_pending' }
  | { kind: 'already_verified' };

/**
 * 送出謄本：建立或喚回節點、寫入送件、排審核台項目（資料庫函式 registry.submit_ownership_transcript），並寫稽核事件。
 * 呼叫前先用 precheckSubmission 檢查，並把檔案存進 FileStore。
 */
export async function submitTranscript(tx: OrgTx, anchorId: string, form: TranscriptForm, file: StoredTranscript): Promise<SubmitResult> {
  let rows;
  try {
    ({ rows } = await tx.query<{ outcome: string; node_id: string; submission_id: string | null }>(
      'SELECT * FROM registry.submit_ownership_transcript($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)',
      [
        anchorId,
        newUlid(),
        file.id,
        newUlid(),
        form.claimedOwner,
        form.acquiredAt,
        form.trust !== null,
        form.trust?.registeredOwner ?? null,
        form.trust?.relatedParties ?? null,
        form.trust?.registrationStatus ?? null,
        form.trust?.leaseClause ?? null,
        file.objectKey,
        file.sha256,
        file.byteSize,
        file.contentType,
        file.fileName,
      ],
    ));
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    if (code === '55000' || code === '22023' || code === 'P0002') throw new OwnershipSubmitRejectedError(message);
    throw error;
  }
  const row = rows[0];
  if (row.outcome === 'already_pending') return { kind: 'already_pending' };
  if (row.outcome === 'already_verified') return { kind: 'already_verified' };
  await appendAudit(tx, {
    action: 'ownership.submit',
    object: { type: 'ownership_node', id: row.node_id },
    payload: { submission_id: row.submission_id, has_trust: form.trust !== null, byte_size: file.byteSize },
  });
  return { kind: 'submitted', nodeId: row.node_id, submissionId: row.submission_id! };
}

export interface OpenedTranscript {
  key: string;
  sha256: string;
  contentType: string;
  fileName: string;
}

/**
 * 開啟原檔：資料庫函式 org.read_ownership_file 在同交易寫稽核事件（vault.read），再回 key。
 * 組織成員與平台營運者共用。找不到送件（含別的組織的）回 null，且不寫事件。
 */
export async function openTranscript(tx: OrgTx, submissionId: string): Promise<OpenedTranscript | null> {
  const { rows } = await tx.query<{ object_key: string; sha256: string; content_type: string; file_name: string }>(
    'SELECT object_key, sha256, content_type, file_name FROM org.read_ownership_file($1)',
    [submissionId],
  );
  if (!rows[0]) return null;
  return { key: rows[0].object_key, sha256: rows[0].sha256, contentType: rows[0].content_type, fileName: rows[0].file_name };
}

/** 物件目前的送件 ID（最新一次）。物件不存在、沒有節點或沒有送件回 null。 */
export async function currentSubmissionIdOf(tx: OrgTx, propertyId: string): Promise<string | null> {
  const anchor = await lookupAnchor(tx, propertyId);
  if (!anchor) return null;
  const node = await findActiveNode(tx, anchor.anchorId);
  return node?.current_submission_id ?? null;
}

export interface OwnershipNodeView {
  id: string;
  status: OwnershipStatus;
  key_match: boolean | null;
  holder_match: boolean | null;
  holder_masked: string | null;
  checked_at: string | null;
}

/** 以 ID 讀節點。營運者在登錄方組織的 operator 脈絡內用；別的組織的節點讀不到。 */
export async function getNodeById(tx: OrgTx, nodeId: string): Promise<OwnershipNodeView | null> {
  const { rows } = await tx.query<NodeRow>(`SELECT ${NODE_COLUMNS} FROM org.ownership_nodes WHERE id = $1`, [nodeId]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    key_match: row.key_match,
    holder_match: row.holder_match,
    holder_masked: row.holder_masked,
    checked_at: row.checked_at ? row.checked_at.toISOString() : null,
  };
}

/** 以 ID 讀一次送件（不含原檔的 key 與 SHA-256）。 */
export async function getSubmissionById(tx: OrgTx, submissionId: string): Promise<OwnershipSubmissionView | null> {
  const { rows } = await tx.query<SubmissionRow>(`SELECT ${SUBMISSION_COLUMNS} FROM org.ownership_submissions WHERE id = $1`, [submissionId]);
  return rows[0] ? toSubmissionView(rows[0]) : null;
}
