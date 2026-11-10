import { isUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';

// 收款帳戶持有人的候選清單（MIL-187）。
// 持有人是 party，選項來自兩處：本組織的成員，與本組織案件上目前有效的成員。
// - 範圍只到呼叫者自己的組織。org_id 條件寫在查詢裡，不只靠 case_members 的 RLS。
// - 只回顯示名稱與 party ID。email、證號與其他個資不回傳。
// - 別的組織的 party、不存在的 party 與格式錯誤的 ID，對呼叫端沒有差別：都不在清單內。
// 這份清單只決定「選單列誰」與「寫入時哪些 party 可以當持有人」。已存在的帳戶沿用原持有人，不重新檢查（見 repository）。

export interface HolderCandidate {
  partyId: string;
  displayName: string;
}

// 兩個來源合併後去重。UNION 會去掉完全相同的列，同一個 party 不論有幾個關係都只出現一次
const CANDIDATES_SQL = `
  SELECT p.id AS party_id, p.display_name
    FROM control.parties p
   WHERE p.id IN (
     SELECT u.party_id
       FROM control.org_memberships m
       JOIN control.users u ON u.id = m.user_id
      WHERE m.org_id = current_setting('app.org_id', true)
     UNION
     SELECT cm.party_id
       FROM org.case_members cm
      WHERE cm.org_id = current_setting('app.org_id', true)
        AND cm.valid_period @> now()
   )`;

/** 依顯示名稱排序，名稱相同時依 party ID，讓清單的順序固定。 */
export async function listHolderCandidates(tx: OrgTx): Promise<HolderCandidate[]> {
  const { rows } = await tx.query<{ party_id: string; display_name: string }>(
    `${CANDIDATES_SQL} ORDER BY p.display_name, p.id`,
  );
  return rows.map((r) => ({ partyId: r.party_id, displayName: r.display_name }));
}

/** 這個 party 能不能當持有人。格式錯誤的 ID 不查資料庫，直接回 false。 */
export async function isHolderCandidate(tx: OrgTx, partyId: string): Promise<boolean> {
  if (!isUlid(partyId)) return false;
  const { rows } = await tx.query(`${CANDIDATES_SQL} AND p.id = $1`, [partyId]);
  return rows.length > 0;
}
