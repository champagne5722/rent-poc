import { requestContext } from '../current-request-context';
import { isUlid } from '../pg/ulid';
import { getOwnershipReviewDetail, type OwnershipReviewDetail } from './desk';
import { operatorRuns } from './operator';

// 審核台出租權源項目詳情的資料載入（MIL-201 畫面段）。詳情頁在 server component 呼叫它，client component 只管畫面與操作。
// 讀的資料與 GET /api/desk/ownership/[id] 相同。

export type OwnershipReviewLoad =
  | { kind: 'ok'; detail: OwnershipReviewDetail }
  // 格式錯誤的 ID 與不存在的項目，對外同一個畫面
  | { kind: 'not_found' }
  // 不是平台營運者身分
  | { kind: 'forbidden' };

/**
 * 載入一個出租權源審核項目。沒登入時丟 Unauthenticated，由頁面導向登入。
 * 只給 server component 用；route handler 走 requireOwnershipOperator，才能把拒絕轉成 401、403 的回應。
 */
export async function loadOwnershipReview(id: string): Promise<OwnershipReviewLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'operator') return { kind: 'forbidden' };
  if (!isUlid(id)) return { kind: 'not_found' };
  const detail = await getOwnershipReviewDetail(operatorRuns(rc), id, new Date());
  if (!detail) return { kind: 'not_found' };
  return { kind: 'ok', detail };
}
