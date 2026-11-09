import { actionForUncasedObject, type AccessFacts, type ActionId, type CaseAccessFacts } from '../access';
import type { BusinessType, CaseMemberRelation, LeaseCaseState, ManagementCaseState } from '../cases';
import type { Tx } from '../pg/with-tx';
import type { RequestContext } from '../request-context';
import type { AuthObject } from './types';

// 載入 decideAccess 需要的事實（MIL-108，ADR-0023 決議 6）。
// 只讀，不寫稽核，不開交易，用呼叫端給的 tx。

/** 物件查詢的結果。`caseId` 是物件所屬案件，沒有案件是 `null`。 */
interface ResolvedObject {
  exists: boolean;
  caseId: string | null;
}

const ABSENT: ResolvedObject = { exists: false, caseId: null };

/**
 * 查物件是否存在，以及它屬於哪個案件。
 *
 * - `org`：組織本身，永遠存在，沒有案件。
 * - `property`：查詢帶 `org_id`，別的組織的資料一律當作不存在。
 * - `contract`：同上，另外帶出 `case_id`（MIL-115）。合約只在組織脈絡內可見，承租人（party）脈絡走案件物件。
 * - `case`：不綁 `org_id`。案件可能在別的組織（屋主是代管案件的 lessor，案件在代管業者的組織），
 *   可見性交給 RLS：主辦組織（org_isolation）或案件成員（member_read）看得到才算存在，其餘當作不存在。
 */
async function resolveObject(t: Tx, rc: RequestContext, object: AuthObject): Promise<ResolvedObject> {
  if (object.type === 'org') return { exists: true, caseId: null };
  if (object.type === 'case') {
    const { rows } = await t.query('SELECT 1 FROM org.cases WHERE id = $1', [object.id]);
    return rows.length > 0 ? { exists: true, caseId: object.id } : ABSENT;
  }
  // 物件與合約表只在組織脈絡內可見。承租人（party）脈絡看不到，當作不存在。
  if (rc.kind !== 'org') return ABSENT;
  if (object.type === 'property') {
    const { rows } = await t.query('SELECT 1 FROM org.properties WHERE id = $1 AND org_id = $2', [object.id, rc.orgId]);
    return { exists: rows.length > 0, caseId: null };
  }
  const { rows } = await t.query<{ case_id: string | null }>(
    'SELECT case_id FROM org.contracts WHERE id = $1 AND org_id = $2',
    [object.id, rc.orgId],
  );
  return rows.length > 0 ? { exists: true, caseId: rows[0].case_id } : ABSENT;
}

/**
 * 載入案件事實：案件種類與狀態、是不是主辦組織成員、目前身分的成員關係。
 *
 * - 成員關係只取查詢時點 `valid_period` 有效的列（資料庫的 `now()`，與讀取政策同一個時鐘）。
 *   委託終止後受託人的列已關閉，結案不關閉（ADR-0016 決議 15）。
 * - 主辦組織成員：目前脈絡是組織脈絡，且組織就是案件的 `org_id`。
 * - 代管案件的 `onBehalf` 是 `null`，代操作動作回 `no_mandate_link`（拒絕，不放行）。
 *   委託事實的載入屬 MIL-116 與 MIL-119。
 * - 事實欄位來源見 `src/lib/access/README.md`。
 */
async function loadCaseFacts(t: Tx, rc: RequestContext, caseId: string): Promise<CaseAccessFacts> {
  const { rows } = await t.query<{ org_id: string; kind: 'lease' | 'management'; state: string; business_type: BusinessType | null }>(
    'SELECT org_id, kind, state, business_type FROM org.cases WHERE id = $1',
    [caseId],
  );
  const row = rows[0];
  if (!row) throw new Error(`案件 ${caseId} 在載入事實時消失了`);
  const { rows: memberRows } = await t.query<{ relation: CaseMemberRelation }>(
    'SELECT DISTINCT relation FROM org.case_members WHERE case_id = $1 AND party_id = $2 AND valid_period @> now()',
    [caseId, rc.partyId],
  );
  const base = {
    isHostOrgMember: rc.kind === 'org' && rc.orgId === row.org_id,
    relations: memberRows.map((r) => r.relation),
  };
  if (row.kind === 'management') {
    return { kind: 'management', state: row.state as ManagementCaseState, ...base };
  }
  if (row.business_type === null) throw new Error(`租賃案件 ${caseId} 沒有業務類型`);
  return { kind: 'lease', state: row.state as LeaseCaseState, businessType: row.business_type, onBehalf: null, ...base };
}

export type LoadedFacts =
  | { ok: true; facts: AccessFacts; action: ActionId }
  | { ok: false; reason: 'object_not_found' | 'no_case' };

/**
 * 載入事實，並決定實際用哪個動作判斷。
 *
 * 物件沒有案件時，案件動作改用它的 `uncased` 對應動作（依組織角色）。沒有對應的動作回 `no_case`。
 * 物件查不到一律回 `object_not_found`，不看角色，避免角色不同洩漏物件存在與否。
 */
export async function loadAccessFacts(
  t: Tx,
  rc: RequestContext,
  action: ActionId,
  object: AuthObject,
): Promise<LoadedFacts> {
  const resolved = await resolveObject(t, rc, object);
  if (!resolved.exists) return { ok: false, reason: 'object_not_found' };

  const orgRole = rc.kind === 'org' ? rc.role : null;
  if (resolved.caseId === null) {
    const effective = actionForUncasedObject(action);
    if (effective === null) return { ok: false, reason: 'no_case' };
    return { ok: true, facts: { orgRole, caseFacts: null }, action: effective };
  }
  return { ok: true, facts: { orgRole, caseFacts: await loadCaseFacts(t, rc, resolved.caseId) }, action };
}
