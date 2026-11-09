import type { AccessDenyReason, AccessVia } from '../access';

// authorize() 的型別（MIL-108，ADR-0023 決議 6）。

/**
 * 被操作的物件。
 *
 * - `org`：組織本身。成員管理、稽核匯出、建立物件或合約（還沒有物件 ID）。
 * - `property`、`contract`：以 ID 指到的一筆資料。ID 不存在，或屬於別的組織，結果相同。
 *
 * MIL-115 建案件表後，`contract` 會帶出所屬案件，並新增 `{ type: 'case' }`。
 */
export type AuthObject = { type: 'org' } | { type: 'property'; id: string } | { type: 'contract'; id: string };

/** 拒絕原因。`decideAccess` 的原因碼，加上物件查不到。只給內部與日誌用，不得進 response body。 */
export type ForbiddenReason = AccessDenyReason | 'object_not_found';

/** 允許時的結果。`onBehalf` 為真時，呼叫端必須把它寫進稽核事件的 payload（ADR-0023 決議 7）。 */
export interface AccessGrant {
  via: AccessVia;
  onBehalf: boolean;
}
