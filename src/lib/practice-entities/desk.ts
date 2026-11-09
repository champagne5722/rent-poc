import { appendAudit } from '../audit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import {
  checkLicenseEligibility,
  decideCredentialTransition,
  decideRegistrationLoss,
  isRegistrationApproved,
  type CredentialState,
  type EntityType,
  type LicenseKind,
  type LicenseShortfall,
} from '../registry-rules';
import { deleteEvidence, listEvidence, transferClaimEvidence, type DeletedEvidence, type EvidenceMeta } from './evidence';
import type { CheckForm } from './rules';

// 審核台（MIL-109）：佇列、項目詳情、業別核對、認領歸屬判定。都在平台營運者脈絡內呼叫（withTx 的 operator 脈絡），
// 稽核事件因此寫在平台組織的鏈，行為者是營運者。權限由資料庫函式的 assert_operator() 把關。

export type QueueStatus = 'open' | 'resolved';

export interface QueueItem {
  id: string;
  type: string;
  subjectType: string;
  subjectId: string;
  status: QueueStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  /** 等待時間，毫秒。待核對項目是現在減去排進佇列的時間，已結案項目是結案減排進。 */
  waitingMs: number;
  summary: {
    entityName?: string;
    taxId?: string;
    entityType?: EntityType;
    kind?: LicenseKind;
    kinds?: LicenseKind[];
    permitNo?: string | null;
    state?: CredentialState;
  };
}

interface QueueRow {
  id: string;
  type: string;
  subject_type: string;
  subject_id: string;
  status: QueueStatus;
  created_at: Date | string;
  resolved_at: Date | string | null;
  resolution: string | null;
  summary: { entity_name?: string; tax_id?: string; entity_type?: EntityType; kind?: LicenseKind; kinds?: LicenseKind[]; permit_no?: string | null; state?: CredentialState };
}

const iso = (value: Date | string): string => new Date(value).toISOString();

export async function listQueue(tx: OrgTx, status: QueueStatus, now: Date): Promise<QueueItem[]> {
  const { rows } = await tx.query<QueueRow>('SELECT * FROM registry.review_queue($1, 200)', [status]);
  return rows.map((r) => {
    const created = new Date(r.created_at).getTime();
    const end = r.resolved_at ? new Date(r.resolved_at).getTime() : now.getTime();
    return {
      id: r.id,
      type: r.type,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      status: r.status,
      createdAt: iso(r.created_at),
      resolvedAt: r.resolved_at ? iso(r.resolved_at) : null,
      resolution: r.resolution,
      waitingMs: Math.max(0, end - created),
      summary: {
        entityName: r.summary.entity_name,
        taxId: r.summary.tax_id,
        entityType: r.summary.entity_type,
        kind: r.summary.kind,
        kinds: r.summary.kinds,
        permitNo: r.summary.permit_no,
        state: r.summary.state,
      },
    };
  });
}

// ---------------------------------------------------------------------------

export interface DeskLicense {
  id: string;
  kind: LicenseKind;
  state: CredentialState;
  permitNo: string | null;
  submittedAt: string | null;
}

export interface DeskCheck {
  id: string;
  licenseId: string;
  channel: string;
  querySource: string;
  observed: Record<string, unknown>;
  result: 'match' | 'mismatch' | 'not_found' | 'revoked';
  note: string;
  checkedBy: string;
  checkedAt: string;
}

export interface DeskEntity {
  id: string;
  taxId: string;
  name: string;
  entityType: EntityType;
  orgId: string;
  orgName: string;
  businessItemCodes: string[];
  registrationStatus: string | null;
  registrationCheckedAt: string | null;
  licenses: DeskLicense[];
}

export interface DeskClaim {
  claimantOrgId: string;
  claimantOrgName: string | null;
  taxId: string;
  name: string;
  entityType: EntityType;
  kinds: LicenseKind[];
  submissions: Partial<Record<LicenseKind, { permitNo: string; submittedAt: string }>>;
  resolutionNote: string | null;
}

export interface ReviewDetail {
  item: { id: string; type: string; status: QueueStatus; resolution: string | null; createdAt: string; resolvedAt: string | null; subjectId: string };
  entity: DeskEntity | null;
  license: DeskLicense | null;
  claim: DeskClaim | null;
  checks: DeskCheck[];
  /** 證據檔中繼資料：license 項目是該業別的，claim 項目是認領項目的。 */
  evidence: EvidenceMeta[];
}

interface RawDetail {
  item: { id: string; type: string; subject_type: string; subject_id: string; status: QueueStatus; resolution: string | null; created_at: string; resolved_at: string | null };
  entity: null | {
    id: string; tax_id: string; name: string; entity_type: EntityType; org_id: string; org_name: string;
    business_item_codes: string[]; registration_status: string | null; registration_checked_at: string | null;
    licenses: Array<{ id: string; kind: LicenseKind; state: CredentialState; permit_no: string | null; submitted_at: string | null }>;
  };
  license: null | { id: string; kind: LicenseKind; state: CredentialState; permit_no: string | null; submitted_at: string | null };
  claim: null | {
    claimant_org_id: string; claimant_org_name: string | null; tax_id: string; name: string; entity_type: EntityType; kinds: LicenseKind[];
    submissions: Record<string, { permit_no: string; submitted_at: string }>; resolution_note: string | null;
  };
  checks: Array<{ id: string; subject_id: string; channel: string; query_source: string; observed: Record<string, unknown>; result: DeskCheck['result']; note: string; checked_by: string; checked_at: string }>;
}

const toLicense = (l: { id: string; kind: LicenseKind; state: CredentialState; permit_no: string | null; submitted_at: string | null }): DeskLicense => ({
  id: l.id, kind: l.kind, state: l.state, permitNo: l.permit_no, submittedAt: l.submitted_at ? iso(l.submitted_at) : null,
});

export async function getReviewDetail(tx: OrgTx, itemId: string): Promise<ReviewDetail | null> {
  const { rows } = await tx.query<{ detail: RawDetail | null }>('SELECT registry.review_item_detail($1) AS detail', [itemId]);
  const raw = rows[0]?.detail;
  if (!raw) return null;

  const evidence =
    raw.item.type === 'license'
      ? await listEvidence(tx, 'license', [raw.item.subject_id], true)
      : raw.item.type === 'entity_claim'
        ? await listEvidence(tx, 'claim', [raw.item.id], true)
        : [];

  return {
    item: {
      id: raw.item.id, type: raw.item.type, status: raw.item.status, resolution: raw.item.resolution,
      createdAt: iso(raw.item.created_at), resolvedAt: raw.item.resolved_at ? iso(raw.item.resolved_at) : null, subjectId: raw.item.subject_id,
    },
    entity: raw.entity && {
      id: raw.entity.id, taxId: raw.entity.tax_id, name: raw.entity.name, entityType: raw.entity.entity_type,
      orgId: raw.entity.org_id, orgName: raw.entity.org_name, businessItemCodes: raw.entity.business_item_codes,
      registrationStatus: raw.entity.registration_status,
      registrationCheckedAt: raw.entity.registration_checked_at ? iso(raw.entity.registration_checked_at) : null,
      licenses: raw.entity.licenses.map(toLicense),
    },
    license: raw.license && toLicense(raw.license),
    claim: raw.claim && {
      claimantOrgId: raw.claim.claimant_org_id, claimantOrgName: raw.claim.claimant_org_name, taxId: raw.claim.tax_id,
      name: raw.claim.name, entityType: raw.claim.entity_type, kinds: raw.claim.kinds,
      submissions: Object.fromEntries(
        Object.entries(raw.claim.submissions).map(([k, v]) => [k, { permitNo: v.permit_no, submittedAt: iso(v.submitted_at) }]),
      ),
      resolutionNote: raw.claim.resolution_note,
    },
    checks: raw.checks.map((c) => ({
      id: c.id, licenseId: c.subject_id, channel: c.channel, querySource: c.query_source, observed: c.observed,
      result: c.result, note: c.note, checkedBy: c.checked_by, checkedAt: iso(c.checked_at),
    })),
    evidence,
  };
}

// ---------------------------------------------------------------------------
// 業別核對

export type CheckOutcome =
  | {
      status: 'recorded';
      checkId: string;
      from: CredentialState;
      to: CredentialState;
      result: CheckForm['result'];
      /** 因登記狀態不是核准設立而一併轉成已失效的其他業別。 */
      lapsedLicenseIds: string[];
      /** 要通知補件的組織與判定理由。相符時為 null。 */
      supplement: { orgId: string; note: string } | null;
      /** 已在資料庫標記刪除，提交後要刪 FileStore 檔案的證據檔。 */
      deletedEvidence: DeletedEvidence[];
    }
  | { status: 'not_found' }
  | { status: 'wrong_type' }
  | { status: 'already_resolved' }
  /** 營業項目不符業別規則（P0-03 AC2），列出缺少的項目。什麼都沒寫入。 */
  | { status: 'ineligible'; reasons: LicenseShortfall[] }
  | { status: 'registration_not_approved'; registrationStatus: string };

const REGISTRATION_LOSS_NOTE = '商工登記的登記狀態不是核准設立，所有業別轉為已失效';

/**
 * 登錄一筆業別核對（ADR-0017 決議 4、7、10）。一個交易內：
 * 1. 相符時先檢查業別規則與登記狀態。不通過就什麼都不寫，回傳缺少的項目。
 * 2. 稽核事件（平台組織的鏈）與核對紀錄、狀態轉移、項目結案。
 * 3. 登記狀態不是核准設立時，其他已驗證的業別各寫一筆 revoked 的核對紀錄並轉 lapsed。
 * 4. 相符時，這個業別的證據檔標記刪除。
 * 提交後的事（刪檔、通知）由 flows.ts 處理。
 */
export async function recordLicenseCheck(
  tx: OrgTx,
  itemId: string,
  form: CheckForm,
): Promise<CheckOutcome> {
  const detail = await getReviewDetail(tx, itemId);
  if (!detail) return { status: 'not_found' };
  if (detail.item.type !== 'license' || !detail.entity || !detail.license) return { status: 'wrong_type' };
  if (detail.item.status !== 'open') return { status: 'already_resolved' };

  const { entity, license } = detail;
  const codes = form.businessItemCodes ?? entity.businessItemCodes;
  const registrationStatus = form.registrationStatus ?? entity.registrationStatus;
  const approved = registrationStatus === null ? true : isRegistrationApproved(registrationStatus);

  if (form.result === 'match') {
    if (!approved) return { status: 'registration_not_approved', registrationStatus: registrationStatus ?? '' };
    const eligibility = checkLicenseEligibility({ kind: license.kind, entityType: entity.entityType, businessItemCodes: codes });
    if (!eligibility.ok) return { status: 'ineligible', reasons: eligibility.reasons };
  }

  const transition = decideCredentialTransition(license.state, {
    layer: 'license',
    event: form.result === 'match' ? { type: 'check_matched', violatesExclusivity: false } : { type: 'check_mismatched' },
  });
  // license 項目的業別一定是 pending（送件時轉成 pending）。不是的話項目已過時
  if (!transition) return { status: 'already_resolved' };

  const evidenceIds = detail.evidence.filter((e) => e.state === 'stored').map((e) => e.id);
  const checkId = newUlid();
  await writeCheck(tx, {
    checkId,
    itemId,
    licenseId: license.id,
    form,
    from: license.state,
    to: transition.to,
    evidenceIds,
    entityUpdate: { businessItemCodes: form.businessItemCodes, registrationStatus: form.registrationStatus },
    observed: { business_item_codes: codes, registration_status: registrationStatus, permit_no_checked: license.permitNo !== null },
    note: form.note,
  });

  // 登記狀態不是核准設立：全部已驗證的業別轉 lapsed（P0-03 規則 7，ADR-0017 決議 5）
  const lapsedLicenseIds: string[] = [];
  if (registrationStatus !== null && form.registrationStatus !== null) {
    const losses = decideRegistrationLoss({
      registrationStatus,
      licenses: entity.licenses.filter((l) => l.id !== license.id).map((l) => ({ id: l.id, state: l.state })),
    });
    for (const loss of losses) {
      await writeCheck(tx, {
        checkId: newUlid(),
        itemId: null,
        licenseId: loss.licenseId,
        form: { ...form, result: 'revoked', note: REGISTRATION_LOSS_NOTE },
        from: loss.transition.from as CredentialState,
        to: loss.transition.to,
        evidenceIds: [],
        entityUpdate: { businessItemCodes: null, registrationStatus: null },
        observed: { registration_status: registrationStatus },
        note: REGISTRATION_LOSS_NOTE,
      });
      lapsedLicenseIds.push(loss.licenseId);
    }
  }

  // 相符後刪除證據檔（ADR-0017 補充）。不符時保留，等補件
  const deletedEvidence = form.result === 'match' ? await deleteEvidence(tx, evidenceIds, 'matched') : [];

  return {
    status: 'recorded',
    checkId,
    from: license.state,
    to: transition.to,
    result: form.result,
    lapsedLicenseIds,
    supplement: form.result === 'match' ? null : { orgId: entity.orgId, note: form.note },
    deletedEvidence,
  };
}

async function writeCheck(
  tx: OrgTx,
  input: {
    checkId: string;
    itemId: string | null;
    licenseId: string;
    form: CheckForm;
    from: CredentialState;
    to: CredentialState;
    evidenceIds: string[];
    entityUpdate: { businessItemCodes: string[] | null; registrationStatus: string | null };
    observed: Record<string, unknown>;
    note: string;
  },
): Promise<void> {
  // 先寫稽核事件取得位置，再寫核對紀錄（同交易）。事件放平台組織的鏈（operator 脈絡的 app.org_id）
  const ref = await appendAudit(tx, {
    action: 'practice_entity.verify',
    object: { type: 'license', id: input.licenseId },
    payload: { check_id: input.checkId, channel: input.form.channel, result: input.form.result, from: input.from, to: input.to },
  });
  await tx.query('SELECT registry.record_license_check($1, $2, $3, $4, $5, $6::jsonb, $7, $8::text[], $9, $10, $11, $12::text[], $13, $14, $15)', [
    input.checkId,
    input.itemId,
    input.licenseId,
    input.form.channel,
    input.form.querySource,
    JSON.stringify(input.observed),
    input.form.result,
    input.evidenceIds,
    input.note,
    input.from,
    input.to,
    input.entityUpdate.businessItemCodes,
    input.entityUpdate.registrationStatus,
    ref.chainId,
    ref.seq,
  ]);
}

// ---------------------------------------------------------------------------
// 認領歸屬

export type ClaimDecision = 'keep_registrant' | 'to_claimant';

export type ClaimOutcome =
  | {
      status: 'resolved';
      decision: ClaimDecision;
      /** 認領方組織，通知補件或確認歸屬用。 */
      claimantOrgId: string;
      note: string;
      deletedEvidence: DeletedEvidence[];
    }
  | { status: 'not_found' }
  | { status: 'wrong_type' }
  | { status: 'already_resolved' }
  /** 執業主體還有已驗證的業別，要先以核對紀錄轉成失效。 */
  | { status: 'has_verified_license' };

export async function resolveEntityClaim(tx: OrgTx, itemId: string, decision: ClaimDecision, note: string): Promise<ClaimOutcome> {
  const detail = await getReviewDetail(tx, itemId);
  if (!detail) return { status: 'not_found' };
  if (detail.item.type !== 'entity_claim' || !detail.claim || !detail.entity) return { status: 'wrong_type' };
  if (detail.item.status !== 'open') return { status: 'already_resolved' };
  if (decision === 'to_claimant' && detail.entity.licenses.some((l) => l.state === 'verified')) return { status: 'has_verified_license' };

  const ref = await appendAudit(tx, {
    action: 'practice_entity.claim_resolve',
    object: { type: 'review_item', id: itemId },
    payload: { decision },
  });
  const kindCount = detail.claim.kinds.length + detail.entity.licenses.length;
  const { rows } = await tx.query<{ claimant_org_id: string; previous_org_id: string; entity_id: string; license_ids: Record<string, string> }>(
    'SELECT * FROM registry.resolve_entity_claim($1, $2, $3, $4::text[], $5::text[], $6, $7)',
    [
      itemId,
      decision,
      note,
      Array.from({ length: kindCount }, () => newUlid()),
      Array.from({ length: kindCount }, () => newUlid()),
      ref.chainId,
      ref.seq,
    ],
  );

  let deletedEvidence: DeletedEvidence[] = [];
  if (decision === 'keep_registrant') {
    // 認領方送的證據檔不再需要
    deletedEvidence = await deleteEvidence(tx, detail.evidence.filter((e) => e.state === 'stored').map((e) => e.id), 'withdrawn');
  } else {
    const moved = rows[0];
    // 原登錄者留在各業別的證據檔作廢，認領方送的改掛到對應的業別
    const previousLicenseIds = detail.entity.licenses.map((l) => l.id);
    const previous = await listEvidence(tx, 'license', previousLicenseIds);
    deletedEvidence = await deleteEvidence(tx, previous.map((e) => e.id), 'superseded');
    await transferClaimEvidence(tx, itemId, moved.license_ids);
  }
  return { status: 'resolved', decision, claimantOrgId: detail.claim.claimantOrgId, note, deletedEvidence };
}
