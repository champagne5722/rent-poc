import { appendAudit } from '../audit';
import { newUlid } from '../pg/ulid';
import { getMyRegistration } from '../practice-entities/applicant';
import { listOrgEmployments } from '../practitioners/applicant';
import { signableManagers } from '../practitioners/signable-managers';
import type { OrgTx } from '../pg/with-tx';
import type { MandateManagerCandidate, MandateRequestClosedBy } from '../types';

// 業者接受、不接受，以及雙方結束申請的資料存取（MIL-210 前半）。
// 每個資料庫函式的政策（誰能呼叫、回什麼、為什麼）寫在 migration 0087 的函式註解。時間由呼叫端傳入。
// 資料庫函式在同一個交易對另一方寫站內通知。這裡在同一個交易寫稽核事件，寫在呼叫者自己組織的鏈，
// payload 只放任職 ID（接受時），不放原因，也不放對方的任何資料。

/**
 * 接受時能指派的管理人員：呼叫者自己組織、現在有效的租賃住宅管理人員。
 * 判定用 signableManagers（credentialStatusAt，與建案入口同一份）。組織沒有任何已驗證的業別時回空陣列。
 * 只讀自己組織的任職（registry.org_employments），不做跨組織查詢。
 */
export async function listManagerCandidates(tx: OrgTx, now: Date): Promise<MandateManagerCandidate[]> {
  const registration = await getMyRegistration(tx);
  if (!registration?.licenses.some((license) => license.state === 'verified')) return [];
  const employments = await listOrgEmployments(tx);
  return signableManagers(employments, now).map((employment) => ({
    employment_id: employment.id,
    display_name: employment.displayName,
    certificate_kind: 'rental_housing_manager' as const,
  }));
}

export type AcceptOutcome =
  | 'accepted'
  | 'not_found'
  | 'not_pending'
  | 'license_not_verified'
  /** 任職不是自己組織的現在有效的租賃住宅管理人員。別家的任職 ID 與不存在的 ID 回應相同。 */
  | 'manager_not_eligible'
  /** 組織沒有任何合格的管理人員，所以不能接受。 */
  | 'no_eligible_manager';

/**
 * 業者接受。呼叫者必須是業者組織的 admin（函式再查一次）。
 * 管理人員的資格在這裡先判定（同一個交易內），再呼叫 registry.accept_mandate_request。
 * 判定只能在 TypeScript 做，因為 credentialStatusAt 是 TypeScript 的純函式。函式本身只再檢查任職屬於自己組織、
 * 是租賃住宅管理人員、任職與證書是 verified，以及申請的業別是 verified。
 * 成功時同交易寫稽核事件 request.accept。
 */
export async function acceptMandateRequest(tx: OrgTx, id: string, managerEmploymentId: string, now: Date): Promise<AcceptOutcome> {
  const candidates = await listManagerCandidates(tx, now);
  if (candidates.length === 0) return 'no_eligible_manager';
  if (!candidates.some((candidate) => candidate.employment_id === managerEmploymentId)) return 'manager_not_eligible';
  const { rows } = await tx.query<{ outcome: Exclude<AcceptOutcome, 'no_eligible_manager'> }>(
    'SELECT * FROM registry.accept_mandate_request($1, $2, $3, $4)',
    [id, managerEmploymentId, newUlid(), now],
  );
  const outcome = rows[0].outcome;
  if (outcome === 'accepted') {
    await appendAudit(tx, { action: 'request.accept', object: { type: 'mandate_request', id }, payload: { employment_id: managerEmploymentId } });
  }
  return outcome;
}

export type DeclineOutcome = 'declined' | 'not_found' | 'not_pending';

/** 業者不接受。不收原因。呼叫者必須是業者組織的 admin。成功時同交易寫稽核事件 request.decline。 */
export async function declineMandateRequest(tx: OrgTx, id: string, now: Date): Promise<DeclineOutcome> {
  const { rows } = await tx.query<{ outcome: DeclineOutcome }>('SELECT * FROM registry.decline_mandate_request($1, $2, $3)', [id, newUlid(), now]);
  const outcome = rows[0].outcome;
  if (outcome === 'declined') {
    await appendAudit(tx, { action: 'request.decline', object: { type: 'mandate_request', id }, payload: {} });
  }
  return outcome;
}

export type EndOutcome = { outcome: 'ended'; endedBy: MandateRequestClosedBy } | { outcome: 'not_found' | 'not_pending'; endedBy: null };

/**
 * 結束已接受的申請。業者（admin）與屋主（admin、staff）都能呼叫，資料庫函式依呼叫者的組織判斷是哪一方。
 * 成功時同交易寫稽核事件 request.end，寫在呼叫者自己的鏈。
 */
export async function endMandateRequest(tx: OrgTx, id: string, now: Date): Promise<EndOutcome> {
  const { rows } = await tx.query<{ outcome: 'ended' | 'not_found' | 'not_pending'; ended_by: MandateRequestClosedBy | null }>(
    'SELECT * FROM registry.end_mandate_request($1, $2, $3)',
    [id, newUlid(), now],
  );
  const row = rows[0];
  if (row.outcome === 'ended') {
    await appendAudit(tx, { action: 'request.end', object: { type: 'mandate_request', id }, payload: {} });
    return { outcome: 'ended', endedBy: row.ended_by! };
  }
  return { outcome: row.outcome, endedBy: null };
}
