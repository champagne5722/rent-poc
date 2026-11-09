import { contractNotFound } from '../contracts/route';
import { jsonError } from '../http';
import { propertyNotFound } from '../properties/not-found';
import type { Forbidden } from './forbidden';

// Forbidden 對外的 response（P0-02 AC1）。
//
// 規則：呼叫者看不到的東西，回得和「不存在」逐位元相同；呼叫者看得到、只是不能做，回 403。
// - 物件查不到（含別的組織的、承租人看不到的），回該物件類型的 404，本文與路由自己的 notFound 相同。
// - 其餘（viewer 寫入、角色不夠、狀態不允許），呼叫者已經能讀到這個物件，回 403 通用訊息。
// response body 不含原因碼。

/** 查不到物件的原因。這些原因回 404。 */
const HIDDEN_REASONS: ReadonlySet<string> = new Set(['object_not_found', 'not_a_member']);

export function forbiddenResponse(forbidden: Forbidden): Response {
  if (HIDDEN_REASONS.has(forbidden.reason)) {
    if (forbidden.object.type === 'contract') return contractNotFound();
    if (forbidden.object.type === 'property') return propertyNotFound();
  }
  return jsonError(403, forbidden.message);
}
