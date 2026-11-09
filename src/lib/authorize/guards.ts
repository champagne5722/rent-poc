import { authorize } from './authorize';
import type { AccessGrant } from './types';
import type { Tx } from '../pg/with-tx';

// 還沒有 route 的功能，先備好權限檢查（MIL-108）。

/**
 * 稽核紀錄匯出的權限檢查，只限 admin（P0-23 AC6）。
 * 匯出 route 在交易內第一個呼叫它。route 另外負責：只查目前組織的鏈（`chain_id` 取自脈絡，
 * 不收參數），以及不匯出別的組織的紀錄。
 */
export function authorizeAuditExport(t: Tx): Promise<AccessGrant> {
  return authorize(t, 'audit.export', { type: 'org' });
}
