import type { OrgTx } from '../pg/with-tx';
import type {
  OwnershipConflictBasis,
  OwnershipConflictContact,
  OwnershipConflictContactChannel,
  OwnershipConflictContactTarget,
  OwnershipConflictDecision,
  OwnershipConflictSide,
  OwnershipConflictView,
} from '../types';

// 兩方都通過核對時的衝突個案：資料庫函式的薄包裝（MIL-208，migration 0085）。
// 全部是平台營運者的函式：precheck、detail、contact 在平台組織的 operator 脈絡呼叫，
// decide 在後來的一方的 operator 脈絡呼叫。權限與回傳的說明在 0085 的函式註解。
// 稽核事件與通知由資料庫函式在同一個交易寫，這裡不再寫。

/**
 * 衝突偵測。回 held 代表項目已有衝突個案（或剛建立），這次判定到此為止，不得進入登錄方的組織。
 * 平台脈絡。輸入不合格丟 22023。
 */
export async function precheckConflict(
  tx: OrgTx,
  itemId: string,
  check: { keyMatch: boolean; holderMatch: boolean; holderMasked: string; reason: string },
  decisionId: string,
): Promise<'held' | 'clear'> {
  const { rows } = await tx.query<{ r: 'held' | 'clear' }>('SELECT registry.precheck_ownership_conflict($1, $2, $3, $4, $5, $6) AS r', [
    itemId,
    check.keyMatch,
    check.holderMatch,
    check.holderMasked,
    check.reason,
    decisionId,
  ]);
  return rows[0].r;
}

interface RawSide {
  org_id: string;
  org_name: string | null;
  node_id: string;
  submission_id: string | null;
  holder_masked: string | null;
  verified_at?: string | null;
}

interface RawContact {
  id: string;
  target: OwnershipConflictContactTarget;
  channel: OwnershipConflictContactChannel;
  outcome: string;
  contacted_at: string;
  recorded_by: string;
  recorded_at: string;
}

interface RawConflict {
  id: string;
  item_id: string;
  status: 'open' | 'decided';
  created_at: string;
  decision: OwnershipConflictDecision | null;
  decision_basis: OwnershipConflictBasis | null;
  decision_reason: string | null;
  affected_case_count: number | null;
  decided_by: string | null;
  decided_at: string | null;
  claimed_key: { city_code: string; town_code: string; section_code: string; building_no: string; sub_no: string };
  later: RawSide;
  earlier: RawSide;
  contacts: RawContact[];
}

const iso = (value: string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

function toSide(raw: RawSide): OwnershipConflictSide {
  return {
    orgId: raw.org_id,
    orgName: raw.org_name,
    nodeId: raw.node_id,
    submissionId: raw.submission_id,
    holderMasked: raw.holder_masked,
    verifiedAt: iso(raw.verified_at),
    acquiredAt: null,
  };
}

/** 項目的衝突個案。沒有回 null。平台脈絡。 */
export async function getConflict(tx: OrgTx, itemId: string): Promise<OwnershipConflictView | null> {
  const { rows } = await tx.query<{ c: RawConflict | null }>('SELECT registry.ownership_conflict_detail($1) AS c', [itemId]);
  const c = rows[0]?.c;
  if (!c) return null;
  return {
    id: c.id,
    itemId: c.item_id,
    status: c.status,
    createdAt: new Date(c.created_at).toISOString(),
    decision: c.decision,
    decisionBasis: c.decision_basis,
    decisionReason: c.decision_reason,
    affectedCaseCount: c.affected_case_count,
    decidedBy: c.decided_by,
    decidedAt: iso(c.decided_at),
    claimedKey: {
      cityCode: c.claimed_key.city_code,
      townCode: c.claimed_key.town_code,
      sectionCode: c.claimed_key.section_code,
      buildingNo: c.claimed_key.building_no,
      subNo: c.claimed_key.sub_no,
    },
    later: toSide(c.later),
    earlier: toSide(c.earlier),
    contacts: c.contacts.map(
      (k): OwnershipConflictContact => ({
        id: k.id,
        target: k.target,
        channel: k.channel,
        outcome: k.outcome,
        contactedAt: new Date(k.contacted_at).toISOString(),
        recordedBy: k.recorded_by,
        recordedAt: new Date(k.recorded_at).toISOString(),
      }),
    ),
  };
}

/** 記一筆聯絡。項目沒有個案回 not_found。平台脈絡。時間不合格丟 22023。 */
export async function insertContact(
  tx: OrgTx,
  itemId: string,
  contactId: string,
  form: { target: OwnershipConflictContactTarget; channel: OwnershipConflictContactChannel; outcome: string; contactedAt: Date | null },
): Promise<'recorded' | 'not_found'> {
  const { rows } = await tx.query<{ outcome: 'recorded' | 'not_found' }>('SELECT outcome FROM registry.record_ownership_contact($1, $2, $3, $4, $5, $6)', [
    itemId,
    contactId,
    form.target,
    form.channel,
    form.outcome,
    form.contactedAt,
  ]);
  return rows[0].outcome;
}

export interface ConflictNotice {
  id: string;
  kind: string;
  title: string;
  body: string;
}

export type DecideConflictRow = { outcome: OwnershipConflictDecision | 'not_found' | 'already_decided'; affectedCaseCount: number };

/**
 * 決定。後來的一方的 operator 脈絡。通知由呼叫端依決定提供，資料庫只檢查形狀並寫進各自的組織。
 * 不合格的輸入丟 22023，個案或項目狀態不符丟 55000，鍵有多個並存的節點時讓後來的成立丟 0A000。
 */
export async function decideConflict(
  tx: OrgTx,
  itemId: string,
  decision: { decision: OwnershipConflictDecision; reason: string; basis: OwnershipConflictBasis | null },
  decisionId: string,
  notices: { later: ConflictNotice; earlier: ConflictNotice | null },
): Promise<DecideConflictRow> {
  const { rows } = await tx.query<{ outcome: DecideConflictRow['outcome']; affected_case_count: number }>(
    'SELECT outcome, affected_case_count FROM registry.decide_ownership_conflict($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)',
    [
      itemId,
      decision.decision,
      decision.reason,
      decision.basis,
      decisionId,
      JSON.stringify(notices.later),
      notices.earlier ? JSON.stringify(notices.earlier) : null,
    ],
  );
  return { outcome: rows[0].outcome, affectedCaseCount: Number(rows[0].affected_case_count) };
}
