import { PLATFORM_ORG_ID } from '../auth/config';
import { requestContext } from '../current-request-context';
import { withTx } from '../pg/database';
import { isUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { getCredentialReview, isCredentialItemType, type CredentialReview } from '../practitioners/desk';
import { getReviewDetail, listQueue, type QueueItem, type ReviewDetail } from './desk';
import { deskTicket } from './ticket';

// 審核台佇列與項目詳情的資料載入（MIL-180）。頁面在 server component 呼叫它，client component 只管畫面與操作。
// 讀的資料與 GET /api/desk/queue、/api/desk/items/[id]、/api/desk/credentials/[id] 相同。
// 只給 server component 用；route handler 走 inOperatorTx，才能把拒絕轉成 401、403 的回應。

export type DeskQueueLoad =
  | { kind: 'ok'; open: QueueItem[]; resolved: QueueItem[] }
  // 不是平台營運者身分
  | { kind: 'forbidden' };

export type DeskItemLoad =
  // 業別核對與統編認領
  | { kind: 'review'; detail: ReviewDetail; nowIso: string }
  // 證書、任職與同意書
  | { kind: 'credential'; detail: ReviewDetail; review: CredentialReview; nowIso: string }
  // 撞號與撞號超限。nowIso 是載入當下的時間，等待時間算到這一刻，server 與瀏覽器的畫面才一致（review 與 credential 同理）
  | { kind: 'collision'; detail: ReviewDetail; nowIso: string }
  // 出租權源項目有自己的核對畫面
  | { kind: 'ownership'; id: string }
  // 格式錯誤的 ID 與不存在的項目，對外同一個畫面
  | { kind: 'not_found' }
  | { kind: 'forbidden' };

const COLLISION_ITEM_TYPES = ['anchor_collision', 'anchor_collision_limit'];

/** 在營運者脈絡開交易。沒登入時丟 Unauthenticated，由頁面導向登入；不是營運者身分回 null。 */
async function inOperator<T>(ticketId: string, fn: (tx: OrgTx) => Promise<T>): Promise<T | null> {
  const rc = await requestContext();
  if (rc.kind !== 'operator') return null;
  return withTx({ kind: 'operator', operatorId: rc.userId, orgId: PLATFORM_ORG_ID, ticketId }, (tx) => fn(tx as OrgTx));
}

/** 載入待核對與已結案兩份佇列。篩選在 client 端切換，不需要再打 API。 */
export async function loadDeskQueue(): Promise<DeskQueueLoad> {
  const now = new Date();
  const loaded = await inOperator(deskTicket('queue'), async (tx) => ({
    open: await listQueue(tx, 'open', now),
    resolved: await listQueue(tx, 'resolved', now),
  }));
  return loaded ? { kind: 'ok', ...loaded } : { kind: 'forbidden' };
}

/** 載入一個審核項目，依類型回傳對應畫面需要的資料。 */
export async function loadDeskItem(id: string): Promise<DeskItemLoad> {
  if (!isUlid(id)) {
    // 仍要先檢查身分：非營運者看到的是權限說明，不是「找不到」
    const rc = await requestContext();
    return rc.kind === 'operator' ? { kind: 'not_found' } : { kind: 'forbidden' };
  }
  const loaded = await inOperator<DeskItemLoad>(deskTicket('item', id), async (tx) => {
    const detail = await getReviewDetail(tx, id);
    if (!detail) return { kind: 'not_found' };
    const type = detail.item.type;
    if (type === 'leasing_authority') return { kind: 'ownership', id };
    if (isCredentialItemType(type)) {
      const review = await getCredentialReview(tx, id);
      return review ? { kind: 'credential', detail, review, nowIso: new Date().toISOString() } : { kind: 'not_found' };
    }
    if (COLLISION_ITEM_TYPES.includes(type)) return { kind: 'collision', detail, nowIso: new Date().toISOString() };
    return { kind: 'review', detail, nowIso: new Date().toISOString() };
  });
  return loaded ?? { kind: 'forbidden' };
}
