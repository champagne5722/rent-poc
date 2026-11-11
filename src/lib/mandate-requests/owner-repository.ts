import { appendAudit } from '../audit';
import { currentNotice, NOTICE_CATALOG } from '../consent';
import { TRANSCRIPT_NOTICE } from '../ownership/repository';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { MandateRequestClosedBy, MandateRequestDraft, MandateRequestKind, OwnerMandateRequest } from '../types';
import { hashRequestCode } from './code';
import { KIND_LABEL } from './messages';
import { deadlineOf, effectiveStatus, type StoredStatus } from './status';
import { factsOf, iso } from './repository';

// 屋主端的資料存取（MIL-206）。一律在屋主組織的成員脈絡內呼叫。
// 每個函式的政策（誰能呼叫、回什麼、為什麼）寫在 migration 0086 的函式註解。時間由呼叫端傳入。
// 稽核事件寫在屋主自己的鏈，payload 只放 ID 與計數。業者的鏈沒有屋主的任何事件，業者只收到站內通知。

interface OwnerRow {
  request_id: string;
  kind: MandateRequestKind;
  status: StoredStatus;
  created_at: Date;
  link_expires_at: Date;
  claimed_at: Date | null;
  submitted_at: Date | null;
  withdrawn_at: Date | null;
  accepted_at: Date | null;
  contract_sent_at: Date | null;
  practice_name: string;
  tax_id: string;
  verified_kinds: string[];
  draft: MandateRequestDraft | null;
  has_transcript: boolean;
  transcript_file_name: string | null;
  draft_confirmed_at: Date | null;
  confirmed_unit_id: string | null;
  unit_ids: string[];
  closed_at: Date | null;
  closed_by: MandateRequestClosedBy | null;
}

const OWNER_COLUMNS = `request_id, kind, status, created_at, link_expires_at, claimed_at, submitted_at, withdrawn_at, accepted_at,
  contract_sent_at, practice_name, tax_id, verified_kinds, draft, has_transcript, transcript_file_name, draft_confirmed_at,
  confirmed_unit_id, unit_ids, closed_at, closed_by`;

function consentNotice(): OwnerMandateRequest['consent_notice'] {
  const notice = currentNotice(NOTICE_CATALOG, TRANSCRIPT_NOTICE);
  return { notice_type: TRANSCRIPT_NOTICE, version: notice.version, title: notice.title, text: notice.text };
}

export function toOwnerView(row: OwnerRow, now: Date): OwnerMandateRequest {
  const facts = factsOf(row);
  const status = effectiveStatus(facts, now);
  return {
    id: row.request_id,
    kind: row.kind,
    kind_label: KIND_LABEL[row.kind],
    status,
    created_at: row.created_at.toISOString(),
    deadline: status === 'expired' ? null : iso(deadlineOf(facts)),
    submitted_at: iso(row.submitted_at),
    withdrawn_at: iso(row.withdrawn_at),
    accepted_at: iso(row.accepted_at),
    closed_at: iso(row.closed_at),
    closed_by: row.closed_by,
    practice: { name: row.practice_name, tax_id: row.tax_id, verified_kinds: row.verified_kinds },
    draft: status === 'pending_owner' ? row.draft : null,
    has_transcript: status === 'pending_owner' && row.has_transcript,
    confirmed_unit_id: row.confirmed_unit_id,
    unit_ids: row.unit_ids,
    consent_notice: status === 'pending_owner' && row.draft !== null ? consentNotice() : null,
  };
}

export type ClaimOutcome = 'claimed' | 'already_claimed' | 'not_owner' | 'unavailable';

/**
 * 屋主組織綁定連結。同交易寫稽核事件 request.claim（第一次綁定才寫，寫在屋主的鏈，業者的鏈沒有）。
 * 所有無效的原因都回 unavailable，不區分。
 */
export async function claimMandateRequest(tx: OrgTx, code: string, now: Date): Promise<{ outcome: ClaimOutcome; requestId: string | null }> {
  const { rows } = await tx.query<{ outcome: ClaimOutcome; request_id: string | null }>('SELECT * FROM registry.claim_mandate_request($1, $2)', [
    hashRequestCode(code),
    now,
  ]);
  const row = rows[0];
  if (row.outcome === 'claimed') {
    await appendAudit(tx, { action: 'request.claim', object: { type: 'mandate_request', id: row.request_id! }, payload: {} });
  }
  return { outcome: row.outcome, requestId: row.request_id };
}

/** 屋主綁定的申請，最新的 200 筆。 */
export async function listOwnerRequests(tx: OrgTx, now: Date): Promise<OwnerMandateRequest[]> {
  const { rows } = await tx.query<OwnerRow>(`SELECT ${OWNER_COLUMNS} FROM registry.mandate_requests_for_owner(NULL, $1)`, [now]);
  return rows.map((row) => toOwnerView(row, now));
}

/** 屋主讀一份申請。不是呼叫者組織綁定的申請（含不存在）回 null。 */
export async function getOwnerRequest(tx: OrgTx, id: string, now: Date): Promise<OwnerMandateRequest | null> {
  const row = await getOwnerRow(tx, id, now);
  return row ? toOwnerView(row, now) : null;
}

export async function getOwnerRow(tx: OrgTx, id: string, now: Date): Promise<OwnerRow | null> {
  const { rows } = await tx.query<OwnerRow>(`SELECT ${OWNER_COLUMNS} FROM registry.mandate_requests_for_owner($1, $2)`, [id, now]);
  return rows[0] ?? null;
}

export interface StoredDraftTranscript {
  objectKey: string;
  sha256: string;
  contentType: string;
  fileName: string;
  byteSize: number;
  /** 業者代傳時填的謄本表單欄位。 */
  form: Record<string, unknown>;
}

/** 業者代傳的謄本（伺服器端用，含 FileStore 的 key）。沒有、或申請不是待屋主確認時回 null。 */
export async function getOwnerTranscript(tx: OrgTx, id: string, now: Date): Promise<StoredDraftTranscript | null> {
  const { rows } = await tx.query<{ object_key: string; sha256: string; content_type: string; file_name: string; byte_size: string; form: Record<string, unknown> }>(
    'SELECT * FROM registry.mandate_request_transcript_for_owner($1, $2)',
    [id, now],
  );
  const row = rows[0];
  if (!row) return null;
  return { objectKey: row.object_key, sha256: row.sha256, contentType: row.content_type, fileName: row.file_name, byteSize: Number(row.byte_size), form: row.form ?? {} };
}

export type RecordConfirmOutcome = 'confirmed' | 'already_confirmed' | 'not_found' | 'expired' | 'not_pending' | 'no_draft' | 'unit_not_found';

/** 記錄屋主已確認代填資料，登錄成這個租賃單位。登錄物件本身由呼叫端走 registerProperty。 */
export async function recordDraftConfirmed(tx: OrgTx, id: string, unitId: string, now: Date): Promise<{ outcome: RecordConfirmOutcome; unitId: string | null }> {
  const { rows } = await tx.query<{ outcome: RecordConfirmOutcome; unit_id: string | null }>(
    'SELECT * FROM registry.confirm_mandate_request_draft($1, $2, $3)',
    [id, unitId, now],
  );
  return { outcome: rows[0].outcome, unitId: rows[0].unit_id };
}

export type SubmitOutcome = 'submitted' | 'not_found' | 'expired' | 'not_pending' | 'no_units' | 'unit_not_found' | 'units_occupied';

/**
 * 屋主送出。資料庫函式在同一個交易對業者組織寫站內通知。成功時同交易寫稽核事件 request.submit。
 * releasedObjectKey 是被清掉的業者代傳謄本，呼叫端在提交後從 FileStore 刪除。
 */
export async function submitMandateRequest(
  tx: OrgTx,
  id: string,
  unitIds: readonly string[],
  now: Date,
): Promise<{ outcome: SubmitOutcome; unitCount: number | null; releasedObjectKey: string | null }> {
  const { rows } = await tx.query<{ outcome: SubmitOutcome; unit_count: number | null; released_object_key: string | null }>(
    'SELECT * FROM registry.submit_mandate_request($1, $2::text[], $3, $4)',
    [id, [...unitIds], newUlid(), now],
  );
  const row = rows[0];
  if (row.outcome === 'submitted') {
    await appendAudit(tx, {
      action: 'request.submit',
      object: { type: 'mandate_request', id },
      payload: { unit_count: row.unit_count },
    });
  }
  return { outcome: row.outcome, unitCount: row.unit_count, releasedObjectKey: row.released_object_key };
}

export type WithdrawOutcome = 'withdrawn' | 'not_found' | 'not_submitted' | 'expired' | 'not_pending';

/** 屋主收回。成功時資料庫函式在同一個交易對業者組織寫「申請已收回」，這裡同交易寫稽核事件 request.withdraw。 */
export async function withdrawMandateRequest(tx: OrgTx, id: string, now: Date): Promise<WithdrawOutcome> {
  const { rows } = await tx.query<{ outcome: WithdrawOutcome }>('SELECT * FROM registry.withdraw_mandate_request($1, $2, $3)', [id, newUlid(), now]);
  const outcome = rows[0].outcome;
  if (outcome === 'withdrawn') {
    await appendAudit(tx, { action: 'request.withdraw', object: { type: 'mandate_request', id }, payload: {} });
  }
  return outcome;
}
