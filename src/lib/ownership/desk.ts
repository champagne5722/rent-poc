import { appendAudit } from '../audit';
import type { FileStore } from '../file-store';
import { notify } from '../notifications';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { deskTicket } from '../practice-entities/ticket';
import type { OwnershipSubmissionView } from '../types';
import { businessMsBetween, isReviewOverdue } from './business-days';
import { readTranscriptBytes, type OpenFileResult } from './flows';
import { validateCheckForm, type CheckFormField } from './forms';
import { FAILED_NOTIFICATION_KIND, FAILED_NOTIFICATION_TITLE, VERIFIED_NOTIFICATION, failedNotificationBody } from './messages';
import { getNodeById, getSubmissionById, openTranscript, type OwnershipNodeView } from './repository';

// 審核台的出租權源核對（MIL-201，ADR-0026 決議 7，ADR-0028 決議 3）。
//
// 兩種交易：
// - platform：平台組織的 operator 脈絡。讀審核台項目標頭（登錄方組織 ID），資料庫函式先呼叫 assert_operator()。
// - inOrg：登錄方組織的 operator 脈絡（ADR-0026 決議 7）。工單號填審核台動作加項目 ID。
//   withTx 在同交易寫 operator.access 事件。讀送件、開原檔與判定都在這個交易內，稽核事件因此寫在登錄方的鏈，行為者是營運者。
// 判定人由資料庫從交易脈絡取，這裡沒有參數可以傳入。

export interface OperatorRuns {
  platform: <R>(ticketId: string, fn: (tx: OrgTx) => Promise<R>) => Promise<R>;
  inOrg: <R>(orgId: string, ticketId: string, fn: (tx: OrgTx) => Promise<R>) => Promise<R>;
}

interface RawHeader {
  id: string;
  type: 'leasing_authority' | 'anchor_rekey';
  status: 'open' | 'resolved';
  resolution: string | null;
  subject_id: string;
  created_at: string;
  resolved_at: string | null;
  claimant_org_id: string;
  claimant_org_name: string | null;
  submission_id: string | null;
  claimed_key: { city_code: string; town_code: string; section_code: string; building_no: string; sub_no: string };
  city_name: string | null;
  town_name: string | null;
  section_name: string | null;
  section_sub_name: string | null;
  held: boolean;
}

export interface OwnershipReviewHeader {
  id: string;
  type: 'leasing_authority' | 'anchor_rekey';
  status: 'open' | 'resolved';
  resolution: string | null;
  subjectId: string;
  createdAt: string;
  resolvedAt: string | null;
  claimantOrgId: string;
  claimantOrgName: string | null;
  submissionId: string | null;
  held: boolean;
  claimedKey: { cityCode: string; townCode: string; sectionCode: string; buildingNo: string; subNo: string };
  claimedKeyNames: { cityName: string | null; townName: string | null; sectionName: string | null; sectionSubName: string | null };
}

/** 審核台項目標頭。項目不存在或不是出租權源、修正建號項目回 null。平台組織的 operator 脈絡。 */
export async function getReviewHeader(tx: OrgTx, itemId: string): Promise<OwnershipReviewHeader | null> {
  const { rows } = await tx.query<{ h: RawHeader | null }>('SELECT registry.ownership_review_item($1) AS h', [itemId]);
  const h = rows[0]?.h;
  if (!h) return null;
  return {
    id: h.id,
    type: h.type,
    status: h.status,
    resolution: h.resolution,
    subjectId: h.subject_id,
    createdAt: new Date(h.created_at).toISOString(),
    resolvedAt: h.resolved_at ? new Date(h.resolved_at).toISOString() : null,
    claimantOrgId: h.claimant_org_id,
    claimantOrgName: h.claimant_org_name,
    submissionId: h.submission_id,
    held: h.held,
    claimedKey: {
      cityCode: h.claimed_key.city_code,
      townCode: h.claimed_key.town_code,
      sectionCode: h.claimed_key.section_code,
      buildingNo: h.claimed_key.building_no,
      subNo: h.claimed_key.sub_no,
    },
    claimedKeyNames: { cityName: h.city_name, townName: h.town_name, sectionName: h.section_name, sectionSubName: h.section_sub_name },
  };
}

export interface OwnershipReviewDetail {
  item: {
    id: string;
    type: 'leasing_authority' | 'anchor_rekey';
    status: 'open' | 'resolved';
    resolution: string | null;
    createdAt: string;
    resolvedAt: string | null;
    /** 等待時間，毫秒，只算臺北時間的週一到週五。已結案的項目算到結案。 */
    waitingBusinessMs: number;
    /** 超過 1 個工作日。 */
    overdue: boolean;
    /** 兩項都相符，但別的組織對同一個鍵已有已驗證的節點，項目停在待處理。只有營運者看得到。 */
    held: boolean;
  };
  claimantOrgName: string | null;
  /** 送件當下使用者看到的鍵，與謄本比對用。 */
  claimedKey: OwnershipReviewHeader['claimedKey'];
  claimedKeyNames: OwnershipReviewHeader['claimedKeyNames'];
  /** 修正建號項目沒有節點與送件。 */
  node: OwnershipNodeView | null;
  submission: OwnershipSubmissionView | null;
  /** 開啟原檔的路徑。每次開啟寫稽核事件。 */
  fileUrl: string | null;
}

/** 審核台項目詳情。項目不存在回 null。 */
export async function getOwnershipReviewDetail(runs: OperatorRuns, itemId: string, now: Date): Promise<OwnershipReviewDetail | null> {
  const header = await runs.platform(deskTicket('ownership', itemId), (tx) => getReviewHeader(tx, itemId));
  if (!header) return null;
  const waitingEnd = header.resolvedAt ? new Date(header.resolvedAt) : now;
  const created = new Date(header.createdAt);
  let node: OwnershipNodeView | null = null;
  let submission: OwnershipSubmissionView | null = null;
  if (header.type === 'leasing_authority') {
    const loaded = await runs.inOrg(header.claimantOrgId, deskTicket('ownership', itemId), async (tx) => ({
      node: await getNodeById(tx, header.subjectId),
      submission: header.submissionId ? await getSubmissionById(tx, header.submissionId) : null,
    }));
    node = loaded.node;
    submission = loaded.submission;
  }
  return {
    item: {
      id: header.id,
      type: header.type,
      status: header.status,
      resolution: header.resolution,
      createdAt: header.createdAt,
      resolvedAt: header.resolvedAt,
      waitingBusinessMs: businessMsBetween(created, waitingEnd),
      overdue: isReviewOverdue(created, waitingEnd),
      held: header.held,
    },
    claimantOrgName: header.claimantOrgName,
    claimedKey: header.claimedKey,
    claimedKeyNames: header.claimedKeyNames,
    node,
    submission,
    fileUrl: submission ? `/api/desk/ownership/${itemId}/file` : null,
  };
}

/** 營運者開啟項目的謄本原檔。資料庫函式在登錄方的鏈寫稽核事件（行為者是營運者），再讀檔。 */
export async function openOwnershipReviewFile(runs: OperatorRuns, itemId: string, store: FileStore): Promise<OpenFileResult> {
  const header = await runs.platform(deskTicket('ownership', itemId), (tx) => getReviewHeader(tx, itemId));
  if (!header || header.type !== 'leasing_authority' || !header.submissionId) return { status: 'not_found' };
  const submissionId = header.submissionId;
  const opened = await runs.inOrg(header.claimantOrgId, deskTicket('file', itemId), (tx) => openTranscript(tx, submissionId));
  if (!opened) return { status: 'not_found' };
  return readTranscriptBytes(store, opened);
}

export type DecideFlowResult =
  | { status: 'recorded'; outcome: 'verified' | 'failed' }
  /** 兩項都相符，但別的組織對同一個鍵已有已驗證的節點。項目停在待處理，登錄的一方看不到任何變化。 */
  | { status: 'held' }
  | { status: 'invalid'; field: CheckFormField; message: string }
  | { status: 'not_found' }
  | { status: 'already_resolved' };

/**
 * 判定出租權源。兩項比對各自記錄，判定人、時間與理由由資料庫記在判定紀錄。
 * 通過或不通過時，同交易寫稽核事件（rental_right.judge）並通知登錄的一方（站內）。held 不寫事件也不通知。
 */
export async function decideOwnershipFlow(runs: OperatorRuns, itemId: string, raw: Record<string, unknown>): Promise<DecideFlowResult> {
  const form = validateCheckForm(raw);
  if (!form.ok) return { status: 'invalid', field: form.field, message: form.message };
  const header = await runs.platform(deskTicket('ownership', itemId), (tx) => getReviewHeader(tx, itemId));
  if (!header || header.type !== 'leasing_authority') return { status: 'not_found' };
  if (header.status !== 'open') return { status: 'already_resolved' };

  const { keyMatch, holderMatch, holderMasked, reason } = form.value;
  return runs.inOrg(header.claimantOrgId, deskTicket('decide', itemId), async (tx): Promise<DecideFlowResult> => {
    const { rows } = await tx.query<{ outcome: string; node_id: string | null; property_id: string | null }>(
      'SELECT outcome, node_id, property_id FROM registry.decide_ownership_check($1, $2, $3, $4, $5, $6)',
      [itemId, keyMatch, holderMatch, holderMasked, reason, newUlid()],
    );
    const row = rows[0];
    switch (row.outcome) {
      case 'not_found':
        return { status: 'not_found' };
      case 'already_resolved':
        return { status: 'already_resolved' };
      case 'held':
        return { status: 'held' };
    }
    const outcome = row.outcome as 'verified' | 'failed';
    await appendAudit(tx, {
      action: 'rental_right.judge',
      object: { type: 'ownership_node', id: row.node_id! },
      payload: { outcome, key_match: keyMatch, holder_match: holderMatch },
    });
    const linkPath = row.property_id ? `/properties/${row.property_id}` : undefined;
    if (outcome === 'verified') {
      await notify(tx, { ...VERIFIED_NOTIFICATION, linkPath });
    } else {
      await notify(tx, {
        kind: FAILED_NOTIFICATION_KIND,
        title: FAILED_NOTIFICATION_TITLE,
        body: failedNotificationBody({ keyMatch, holderMatch }),
        linkPath,
      });
    }
    return { status: 'recorded', outcome };
  });
}
