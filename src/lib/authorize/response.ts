import { contractNotFound } from '../contracts/route';
import { jsonError } from '../http';
import { propertyNotFound } from '../properties/not-found';
import type { Forbidden } from './forbidden';

// Forbidden 對外的 response（ADR-0023 決議 6，P0-02 AC1）。
//
// 規則：以 ID 指到的物件，拒絕與「資料不存在」是同一個回應，不論原因。
// 本文與 route 自己的 notFound 逐位元相同（`contractNotFound()`、`propertyNotFound()`）。
// 這包含同組織 viewer 的寫入：他看到「不存在」，不會知道是權限不足。
//
// 例外：物件是組織本身（成員管理、稽核匯出、建立物件或合約）時，沒有資料可以裝成不存在，回 403 通用訊息。
// response body 不含原因碼。

export function forbiddenResponse(forbidden: Forbidden): Response {
  switch (forbidden.object.type) {
    case 'contract':
      return contractNotFound();
    case 'property':
      return propertyNotFound();
    case 'org':
      return jsonError(403, forbidden.message);
  }
}
