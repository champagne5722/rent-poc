import { actionForUncasedObject, type AccessFacts, type ActionId, type CaseAccessFacts } from '../access';
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
 * 查詢帶 `org_id`，再加 RLS，別的組織的資料一律當作不存在。
 *
 * 【MIL-115 接線處 1】案件表建立後，`contracts` 會有 `case_id` 欄位。把合約的查詢改成
 * `SELECT case_id FROM org.contracts WHERE ...`，回傳 `caseId: row.case_id`，其餘不用改。
 */
async function resolveObject(t: Tx, rc: RequestContext, object: AuthObject): Promise<ResolvedObject> {
  if (object.type === 'org') return { exists: true, caseId: null };
  // 物件與合約表只在組織脈絡內可見。承租人（party）脈絡看不到，當作不存在。
  if (rc.kind !== 'org') return ABSENT;
  const table = object.type === 'property' ? 'org.properties' : 'org.contracts';
  const { rows } = await t.query(`SELECT 1 FROM ${table} WHERE id = $1 AND org_id = $2`, [object.id, rc.orgId]);
  return { exists: rows.length > 0, caseId: null };
}

/**
 * 【MIL-115 接線處 2】載入案件事實：案件種類與狀態、是不是主辦組織成員、目前身分的成員關係
 * （只取查詢時點 `valid_period` 有效的列，時間由 `now` 傳入）、代管案件的委託事實。
 * 欄位來源見 `src/lib/access/README.md` 的 `loadAccessFacts` 表。
 * `withCaseMemberTx` 的第 2 步也走 `authorize()`，不必另寫。
 *
 * 目前沒有案件表，`resolveObject` 不會回傳 `caseId`。真的走到這裡就是接線錯誤，拒絕處理，不放行。
 */
async function loadCaseFacts(_t: Tx, _rc: RequestContext, caseId: string): Promise<CaseAccessFacts> {
  throw new Error(`案件 ${caseId} 的事實載入尚未接線（MIL-115）`);
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
