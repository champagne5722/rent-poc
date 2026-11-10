import type { CaseEvent, CaseMemberRelation, CaseState, MasterLeaseCaseFacts, NewCase, NewCaseMember } from '../cases';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { CaseEventRecord, CaseMemberRecord, CaseRecord } from './types';

// 案件、案件成員、案件事件的 repository（MIL-115）。寫法照 src/lib/contracts/repository.ts：
// - 第一個參數是 withTx 給的 tx。INSERT 取交易的 app.org_id，查詢靠 RLS 篩選。
// - 日期欄位在 SQL 內轉成 YYYY-MM-DD 字串，避免驅動依時區轉成 Date。
// - 這裡的寫入函式不做權限判斷，也不做狀態轉移的決策。呼叫端先 authorize()，轉移一律走 dispatch()。

interface CaseRow {
  id: string;
  org_id: string;
  kind: CaseRecord['kind'];
  case_kind: CaseRecord['caseKind'];
  state: CaseState;
  state_version: number;
  business_type: CaseRecord['businessType'];
  title: string;
  rental_unit_id: string | null;
  property_id: string | null;
  current_contract_id: string | null;
  linked_mandate_case_id: string | null;
  linked_master_lease_case_id: string | null;
  predecessor_case_id: string | null;
  handover_id: string | null;
  valid_until: string | null;
  lease_start: string | null;
  lease_end: string | null;
  monthly_rent: number | null;
  social_housing: boolean;
  default_rent_account_id: string | null;
  default_deposit_account_id: string | null;
  created_at: Date;
  updated_at: Date | null;
}

const CASE_COLUMNS = `id, org_id, kind, case_kind, state, state_version, business_type, title, rental_unit_id, property_id,
  current_contract_id, linked_mandate_case_id, linked_master_lease_case_id, predecessor_case_id, handover_id,
  to_char(valid_until, 'YYYY-MM-DD') AS valid_until, to_char(lease_start, 'YYYY-MM-DD') AS lease_start,
  to_char(lease_end, 'YYYY-MM-DD') AS lease_end, monthly_rent, social_housing, default_rent_account_id,
  default_deposit_account_id, created_at, updated_at`;

function toCase(row: CaseRow): CaseRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    kind: row.kind,
    caseKind: row.case_kind,
    state: row.state,
    stateVersion: row.state_version,
    businessType: row.business_type,
    title: row.title,
    rentalUnitId: row.rental_unit_id,
    propertyId: row.property_id,
    currentContractId: row.current_contract_id,
    linkedMandateCaseId: row.linked_mandate_case_id,
    linkedMasterLeaseCaseId: row.linked_master_lease_case_id,
    predecessorCaseId: row.predecessor_case_id,
    handoverId: row.handover_id,
    validUntil: row.valid_until,
    leaseStart: row.lease_start,
    leaseEnd: row.lease_end,
    monthlyRent: row.monthly_rent,
    socialHousing: row.social_housing,
    defaultRentAccountId: row.default_rent_account_id,
    defaultDepositAccountId: row.default_deposit_account_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

/** 讀一個案件，找不到（含看不到的別的組織的案件）回 null。 */
export async function getCase(tx: OrgTx, id: string): Promise<CaseRecord | null> {
  const { rows } = await tx.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM org.cases WHERE id = $1`, [id]);
  return rows[0] ? toCase(rows[0]) : null;
}

/** 新建案件列。`NewCase` 來自 `decideCaseCreation`。合約之後用 `setCurrentContract` 掛上。 */
export async function insertCase(
  tx: OrgTx,
  newCase: NewCase,
  extra: {
    title: string;
    propertyId: string | null;
    rentalUnitId: string | null;
    leaseStart?: string | null;
    leaseEnd?: string | null;
    monthlyRent?: number | null;
    /** 社宅代管案件旗標，預設 false（MIL-123）。 */
    socialHousing?: boolean;
  },
  now: Date,
): Promise<void> {
  const lease = newCase.kind === 'lease' ? newCase : null;
  await tx.query(
    `INSERT INTO org.cases
       (id, org_id, kind, state, state_version, business_type, title, rental_unit_id, property_id, current_contract_id,
        linked_mandate_case_id, predecessor_case_id, handover_id, valid_until, lease_start, lease_end, monthly_rent,
        created_at, social_housing, case_kind, linked_master_lease_case_id)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, 0, $4, $5, $6, $7, NULL, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      newCase.id,
      newCase.kind,
      newCase.state,
      lease?.businessType ?? null,
      extra.title,
      extra.rentalUnitId,
      extra.propertyId,
      lease?.linkedMandateCaseId ?? null,
      lease?.predecessorCaseId ?? null,
      lease?.handoverId ?? null,
      newCase.kind === 'management' ? newCase.validUntil : null,
      extra.leaseStart ?? null,
      extra.leaseEnd ?? null,
      extra.monthlyRent ?? null,
      now.toISOString(),
      extra.socialHousing ?? false,
      newCase.caseKind,
      lease?.linkedMasterLeaseCaseId ?? null,
    ],
  );
}

/**
 * 找這個租賃單位上、目前組織主辦的有效包租案件，給「建立轉租案件」的判定函式當事實（ADR-0030 決議 5）。
 *
 * 誰能呼叫：已在 `inOrgTx` 內的程式碼，由呼叫端先 authorize()。
 * 回什麼：有效（active）且租賃單位相同的包租案件的事實，優先回 active 的那一筆；沒有則回 null。
 * 為什麼安全：查詢明確限定 `org_id` 等於目前組織，所以即使目前身分因成員關係讀得到別的組織的案件，
 * 這裡也不會回它們。判定函式對「沒有」「別的組織」「沒涵蓋」「不是 active」回完全相同的說明，
 * 呼叫者因此無法由拒絕訊息得知別的組織有沒有包租案件。
 */
export async function findCoveringMasterLeaseCase(tx: OrgTx, rentalUnitId: string): Promise<MasterLeaseCaseFacts | null> {
  const { rows } = await tx.query<{ id: string; org_id: string; state: MasterLeaseCaseFacts['state'] }>(
    `SELECT id, org_id, state FROM org.cases
      WHERE case_kind = 'master_lease' AND rental_unit_id = $1 AND org_id = current_setting('app.org_id', true)
      ORDER BY (state = 'active') DESC, id DESC
      LIMIT 1`,
    [rentalUnitId],
  );
  const row = rows[0];
  return row ? { id: row.id, orgId: row.org_id, state: row.state, coversRentalUnit: true } : null;
}

/** 案件的目前合約改指向另一份合約。不寫事件，事件由呼叫端的 `attachContract` 寫。 */
export async function setCurrentContract(tx: OrgTx, caseId: string, contractId: string, now: Date): Promise<void> {
  const { rows } = await tx.query(
    `UPDATE org.cases SET current_contract_id = $2, updated_at = $3 WHERE id = $1 RETURNING id`,
    [caseId, contractId, now.toISOString()],
  );
  if (rows.length === 0) throw new Error(`案件 ${caseId} 不存在，無法掛上合約`);
}

/** 租期與租金：送簽時從合約欄位同步進案件，讓只讀案件的成員（包租案件的 owner）也看得到（ADR-0016 決議 15）。 */
export async function updateLeaseTerms(
  tx: OrgTx,
  caseId: string,
  terms: { leaseStart: string | null; leaseEnd: string | null; monthlyRent: number | null },
  now: Date,
): Promise<void> {
  await tx.query(
    `UPDATE org.cases SET lease_start = $2, lease_end = $3, monthly_rent = $4, updated_at = $5 WHERE id = $1`,
    [caseId, terms.leaseStart, terms.leaseEnd, terms.monthlyRent, now.toISOString()],
  );
}

// --- 案件事件 ---

interface EventRow {
  id: string;
  case_id: string;
  type: CaseEventRecord['type'];
  from_state: CaseState | null;
  to_state: CaseState | null;
  payload: CaseEventRecord['payload'];
  actor_party_id: string | null;
  occurred_at: Date;
}

export interface NewCaseEvent {
  event: CaseEvent;
  fromState?: CaseState | null;
  toState?: CaseState | null;
  actorPartyId?: string | null;
}

/** 寫一筆案件事件。append-only，資料庫的 trigger 擋下修改與刪除。 */
export async function insertCaseEvent(tx: OrgTx, caseId: string, entry: NewCaseEvent): Promise<void> {
  await tx.query(
    `INSERT INTO org.case_events (id, org_id, case_id, type, from_state, to_state, payload, actor_party_id, occurred_at)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      newUlid(),
      caseId,
      entry.event.type,
      entry.fromState ?? null,
      entry.toState ?? null,
      JSON.stringify(entry.event.payload),
      entry.actorPartyId ?? null,
      entry.event.occurredAt,
    ],
  );
}

/** 依發生順序（ULID 單調遞增）。成員讀取時，RLS 只放行 lessor、mandator、mandatary。 */
export async function listCaseEvents(tx: OrgTx, caseId: string): Promise<CaseEventRecord[]> {
  const { rows } = await tx.query<EventRow>(
    `SELECT id, case_id, type, from_state, to_state, payload, actor_party_id, occurred_at
       FROM org.case_events WHERE case_id = $1 ORDER BY id ASC`,
    [caseId],
  );
  return rows.map((r) => ({
    id: r.id,
    caseId: r.case_id,
    type: r.type,
    fromState: r.from_state,
    toState: r.to_state,
    payload: r.payload,
    actorPartyId: r.actor_party_id,
    occurredAt: r.occurred_at.toISOString(),
  }));
}

// --- 案件成員 ---

interface MemberRow {
  id: string;
  case_id: string;
  party_id: string;
  relation: CaseMemberRelation;
  display_name: string;
  email: string;
  valid_from: Date;
  valid_until: Date | null;
}

/**
 * 案件成員，含已結束的關係。關係還有效的在前。RLS 決定看得到哪些列：
 * 主辦組織與 lessor、mandator、mandatary 看整個案件，其他關係只看到自己（ADR-0012 決議 7）。
 */
export async function listCaseMembers(tx: OrgTx, caseId: string): Promise<CaseMemberRecord[]> {
  const { rows } = await tx.query<MemberRow>(
    `SELECT m.id, m.case_id, m.party_id, m.relation, p.display_name, p.email,
            lower(m.valid_period) AS valid_from, upper(m.valid_period) AS valid_until
       FROM org.case_members m JOIN control.parties p ON p.id = m.party_id
      WHERE m.case_id = $1
      ORDER BY upper_inf(m.valid_period) DESC, m.id ASC`,
    [caseId],
  );
  return rows.map((r) => ({
    id: r.id,
    caseId: r.case_id,
    partyId: r.party_id,
    relation: r.relation,
    displayName: r.display_name,
    email: r.email,
    validFrom: r.valid_from.toISOString(),
    validUntil: r.valid_until ? r.valid_until.toISOString() : null,
  }));
}

/**
 * 加入成員。同一人同一關係已經有效時不重複加，回傳 false。
 * 回傳 true 才表示新增了一列，呼叫端據此決定要不要寫 `member_added` 事件。
 */
export async function insertCaseMember(
  tx: OrgTx,
  caseId: string,
  member: NewCaseMember,
  now: Date,
): Promise<boolean> {
  const { rows } = await tx.query(
    `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation, valid_period)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, tstzrange($5::timestamptz, NULL, '[)'))
     ON CONFLICT (org_id, case_id, party_id, relation) WHERE upper_inf(valid_period) DO NOTHING
     RETURNING id`,
    [newUlid(), caseId, member.partyId, member.relation, now.toISOString()],
  );
  return rows.length > 0;
}

/** 更新 email 前讀成員列並鎖住（FOR UPDATE），同一列的並行更新會排隊。含舊 party 的 email 與顯示名稱。 */
export async function lockMemberForReplacement(
  tx: OrgTx,
  caseId: string,
  memberId: string,
): Promise<{ partyId: string; relation: CaseMemberRelation; active: boolean; displayName: string; email: string } | null> {
  const { rows } = await tx.query<{ party_id: string; relation: CaseMemberRelation; active: boolean; display_name: string; email: string }>(
    `SELECT m.party_id, m.relation, upper_inf(m.valid_period) AS active, p.display_name, p.email
       FROM org.case_members m JOIN control.parties p ON p.id = m.party_id
      WHERE m.id = $1 AND m.case_id = $2
        FOR UPDATE OF m`,
    [memberId, caseId],
  );
  const r = rows[0];
  return r ? { partyId: r.party_id, relation: r.relation, active: r.active, displayName: r.display_name, email: r.email } : null;
}

/** 這個 email 是不是案件的有效成員（任何關係）。 */
export async function isEmailActiveMember(tx: OrgTx, caseId: string, email: string): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM org.case_members m JOIN control.parties p ON p.id = m.party_id
      WHERE m.case_id = $1 AND p.email = $2 AND upper_inf(m.valid_period) LIMIT 1`,
    [caseId, email],
  );
  return rows.length > 0;
}

/**
 * 關閉成員列的有效期，不刪列。終點用資料庫的 now()，與讀取政策同一個時鐘，成員資格立即失效。
 * 範圍不得變空：成員剛在同一個交易加入時，終點至少比起點晚 1 微秒。
 */
export async function closeMemberPeriod(tx: OrgTx, memberId: string): Promise<void> {
  await tx.query(
    `UPDATE org.case_members
        SET valid_period = tstzrange(lower(valid_period), greatest(now(), lower(valid_period) + interval '1 microsecond'), '[)')
      WHERE id = $1 AND upper_inf(valid_period)`,
    [memberId],
  );
}

// --- 當事人 ---

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/;

/** email 一律存小寫並去掉前後空白（control.parties 的 CHECK）。格式不符回 null。 */
export function normalizePartyEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  return EMAIL_PATTERN.test(normalized) ? normalized : null;
}

/**
 * 依 email 找當事人，找不到就建。承租人在登入前就可以是案件成員（0040），所以 party 不等於帳號。
 * 同時兩個交易建同一個 email 時，後到的 INSERT 不寫入，再查一次取回先到的那一列。
 * 已存在的當事人保留原本的顯示名稱，不用新名稱覆蓋。
 */
export async function findOrCreateParty(tx: OrgTx, email: string, displayName: string): Promise<string> {
  const normalized = normalizePartyEmail(email);
  if (!normalized) throw new Error('email 格式不正確');
  const existing = await tx.query<{ id: string }>(`SELECT id FROM control.parties WHERE email = $1`, [normalized]);
  if (existing.rows[0]) return existing.rows[0].id;
  const name = displayName.trim() || normalized;
  const created = await tx.query<{ id: string }>(
    `INSERT INTO control.parties (id, email, display_name) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [newUlid(), normalized, name],
  );
  if (created.rows[0]) return created.rows[0].id;
  const raced = await tx.query<{ id: string }>(`SELECT id FROM control.parties WHERE email = $1`, [normalized]);
  return raced.rows[0].id;
}

// --- 清單與詳情用的讀取 ---

/** 案件清單的一列。 */
export interface CaseSummary {
  id: string;
  orgId: string;
  /** 主辦組織的名稱。 */
  orgName: string;
  kind: CaseRecord['kind'];
  /** 案件種類（ADR-0030）：租賃、委託管理、包租、轉租。 */
  caseKind: CaseRecord['caseKind'];
  state: CaseState;
  businessType: CaseRecord['businessType'];
  title: string;
  leaseStart: string | null;
  leaseEnd: string | null;
  monthlyRent: number | null;
  /** 目前合約的狀態。沒有合約（後繼案件、草稿被刪）是 null。 */
  contractStatus: string | null;
  /** 承租人與共同承租人的名稱，用「、」串起。目前身分讀不到成員時是 null。 */
  lesseeNames: string | null;
  createdAt: string;
  updatedAt: string | null;
}

interface SummaryRow extends CaseRow {
  org_name: string;
  contract_status: string | null;
  lessee_names: string | null;
}

/**
 * 目前身分看得到的案件，新的在前（含主辦組織的全部案件與自己是成員的別組織案件）。
 * 承租人名稱靠 RLS 篩選：主辦組織與 lessor、mandator、mandatary 讀得到整個案件的成員，其他關係讀不到，名稱是 null。
 */
export async function listCaseSummaries(tx: OrgTx): Promise<CaseSummary[]> {
  const { rows } = await tx.query<SummaryRow>(
    `SELECT k.id, k.org_id, o.name AS org_name, k.kind, k.case_kind, k.state, k.business_type, k.title,
            to_char(k.lease_start, 'YYYY-MM-DD') AS lease_start, to_char(k.lease_end, 'YYYY-MM-DD') AS lease_end,
            k.monthly_rent, k.created_at, k.updated_at, c.status AS contract_status,
            (SELECT string_agg(p.display_name, '、' ORDER BY m.id)
               FROM org.case_members m JOIN control.parties p ON p.id = m.party_id
              WHERE m.case_id = k.id AND m.relation IN ('lessee', 'co_lessee') AND upper_inf(m.valid_period)) AS lessee_names
       FROM org.cases k
       JOIN control.orgs o ON o.id = k.org_id
       LEFT JOIN org.contracts c ON c.id = k.current_contract_id
      ORDER BY k.id DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    orgName: r.org_name,
    kind: r.kind,
    caseKind: r.case_kind,
    state: r.state,
    businessType: r.business_type,
    title: r.title,
    leaseStart: r.lease_start,
    leaseEnd: r.lease_end,
    monthlyRent: r.monthly_rent,
    contractStatus: r.contract_status,
    lesseeNames: r.lessee_names,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at ? r.updated_at.toISOString() : null,
  }));
}

export async function getOrgName(tx: OrgTx, orgId: string): Promise<string | null> {
  const { rows } = await tx.query<{ name: string }>('SELECT name FROM control.orgs WHERE id = $1', [orgId]);
  return rows[0]?.name ?? null;
}

/** 案件詳情「合約」分頁的一列。 */
export interface CaseContractRow {
  id: string;
  status: string;
  derivedFrom: string | null;
  createdAt: string;
  /** 是不是案件的目前合約。 */
  isCurrent: boolean;
}

/** 案件下的合約，新的在前。主辦組織與 lessor 等關係讀得到（contracts 的 member_read 政策）。 */
export async function listContractsOfCase(tx: OrgTx, caseId: string): Promise<CaseContractRow[]> {
  const { rows } = await tx.query<{ id: string; status: string; derived_from: string | null; created_at: Date; is_current: boolean }>(
    `SELECT c.id, c.status, c.derived_from, c.created_at, (c.id = k.current_contract_id) AS is_current
       FROM org.contracts c JOIN org.cases k ON k.id = c.case_id
      WHERE c.case_id = $1 ORDER BY c.id DESC`,
    [caseId],
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    derivedFrom: r.derived_from,
    createdAt: r.created_at.toISOString(),
    isCurrent: r.is_current,
  }));
}

/** 案件下還有沒有合約（不分狀態）。 */
export async function caseHasContracts(tx: OrgTx, caseId: string): Promise<boolean> {
  const { rows } = await tx.query('SELECT 1 FROM org.contracts WHERE case_id = $1 LIMIT 1', [caseId]);
  return rows.length > 0;
}
