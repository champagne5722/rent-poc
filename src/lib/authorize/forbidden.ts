import type { ActionId } from '../access';
import type { AuthObject, ForbiddenReason } from './types';

/**
 * 沒有權限，或物件查不到。
 *
 * 訊息固定，不含原因碼。`reason` 只給內部判斷 response 用（見 `response.ts`）與寫日誌。
 * 對外的 response body 不得出現 `reason`（P0-02 AC1，decideAccess README）。
 */
export class Forbidden extends Error {
  readonly reason: ForbiddenReason;
  readonly action: ActionId;
  readonly object: AuthObject;

  constructor(reason: ForbiddenReason, action: ActionId, object: AuthObject) {
    super('沒有權限執行此操作');
    this.name = 'Forbidden';
    this.reason = reason;
    this.action = action;
    this.object = object;
  }
}
