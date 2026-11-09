import type { ActionId } from '../access';
import { authorize, bindAccessContext, Forbidden, type AccessGrant } from '../authorize';
import type { CaseMemberRelation } from '../cases';
import { withTx } from '../pg/database';
import type { OrgTx, Tx } from '../pg/with-tx';
import type { RequestContext } from '../request-context';

// withCaseMemberTx：案件成員寫入別的組織資料的唯一入口（ADR-0016 決議 16，MIL-115）。
// 承租人確認點交、標示異議、報修，以及屋主確認點交，都要寫入別的組織的資料表。
//
// 依序執行四步，同一個交易：
// 1. 以 app.party_id 經 self_read 查成員資格。查不到丟 Forbidden（not_a_member）。
// 2. 由 authorize(tx, action, { type: 'case', id }) 檢查關係、動作與案件狀態。拒絕丟 Forbidden。
// 3. 以案件的 org_id 執行 set_config('app.org_id', ..., true)。
// 4. 呼叫 fn。fn 只呼叫固定的 repository 方法，並同交易寫稽核紀錄。
//
// 第 3 步之後，這個交易看得到整個組織的資料。所以：
// - repository 方法的第一個參數收 CaseMemberTx，內部查詢一律用 tx.caseId 過濾，不接受呼叫端傳別的案件。
// - fn 裡不得直接寫 SQL。這條靠 review 與滲透測試（member-tx.test.ts）把關，型別擋不住。
// - 對外，查不到成員、被拒絕與案件不存在是同一個回應：route 把 Forbidden 轉成 forbiddenResponse()。
//
// 規則同 withTx：fn 內不得有外部 API 呼叫、fs 非同步操作與計時器，不得巢狀呼叫。

export interface CaseMemberAccess {
  /** 這次操作的案件。repository 方法用它過濾，不接受別的案件 ID。 */
  readonly caseId: string;
  /** 案件所在的組織，已設為這個交易的 app.org_id。 */
  readonly orgId: string;
  /** authorize() 的結果。代操作時 onBehalf 為真，呼叫端必須寫進自己的稽核事件。 */
  readonly grant: AccessGrant;
  /** 目前身分在這個案件有效的關係（第 2 步 authorize() 載入的同一份事實）。 */
  readonly relations: readonly CaseMemberRelation[];
}

export type CaseMemberTx = OrgTx & CaseMemberAccess;

export interface CaseMemberTarget {
  caseId: string;
  action: ActionId;
}

export async function withCaseMemberTx<R>(
  rc: Extract<RequestContext, { kind: 'org' | 'party' }>,
  target: CaseMemberTarget,
  fn: (tx: CaseMemberTx) => Promise<R>,
): Promise<R> {
  const object = { type: 'case', id: target.caseId } as const;

  // 步驟 1 到 3 的脈絡是 party：只設定 app.party_id，組織表一律看不到，除了 self_read 與 member_read 放行的列。
  // 呼叫者是屋主組織的成員時也用 party 脈絡，避免自己的組織脈絡混進來。
  return withTx({ kind: 'party', partyId: rc.partyId }, async (partyTx) => {
    // 1. 成員資格（self_read）
    const membership = await partyTx.query<{ org_id: string }>(
      'SELECT org_id FROM org.case_members WHERE case_id = $1 AND party_id = $2 LIMIT 1',
      [target.caseId, rc.partyId],
    );
    if (membership.rows.length === 0) throw new Forbidden('not_a_member', target.action, object);
    const orgId = membership.rows[0].org_id;

    // 2. authorize()：關係、動作、案件狀態
    bindAccessContext(partyTx, rc);
    const grant = await authorize(partyTx, target.action, object);
    const relations = await relationsOf(partyTx, target.caseId, rc.partyId);

    // 3. 切到案件所在的組織
    await partyTx.query("SELECT set_config('app.org_id', $1, true)", [orgId]);

    // 4. 固定的 repository 方法
    const tx: CaseMemberTx = {
      kind: 'org',
      query: (sql, params) => partyTx.query(sql, params),
      caseId: target.caseId,
      orgId,
      grant,
      relations,
    };
    return fn(tx);
  });
}

async function relationsOf(tx: Tx, caseId: string, partyId: string): Promise<CaseMemberRelation[]> {
  const { rows } = await tx.query<{ relation: CaseMemberRelation }>(
    'SELECT DISTINCT relation FROM org.case_members WHERE case_id = $1 AND party_id = $2 AND valid_period @> now()',
    [caseId, partyId],
  );
  return rows.map((r) => r.relation);
}
