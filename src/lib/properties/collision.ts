import { appendAudit } from '@/lib/audit';
import { newUlid } from '@/lib/pg/ulid';
import type { OrgTx } from '@/lib/pg/with-tx';
import type { AnchorKey } from '@/lib/registry/section-code';

// 撞號（MIL-144，ADR-0025 決議 7、9）。登錄的鍵撞到別的組織已登錄的鍵時，物件照樣建立並送審核台。
// 這個檔案是 registry.assign_anchor_key 的 TypeScript 側：呼叫、解讀結果，並處理「撞號必須留下稽核」的交易邊界。
//
// 回應的規則：回應、錯誤訊息與稽核事件都不含對方組織的名稱、統編、人員、物件與 ID。
// 這裡拿得到的 ID 只有呼叫者自己的物件 ID 與審核單號，registry 函式本來就不回傳別的。

/** 撞到別的組織時，回應固定寫這一句（P0-07 AC1）。 */
export const COLLISION_QUEUED_MESSAGE = '此產權已在平台登錄，已送審核';

/** 24 小時內的撞號回應用完額度。訊息請使用者聯絡平台（ADR-0025 決議 9）。 */
export const COLLISION_LIMIT_MESSAGE = '24 小時內遇到已登錄產權的次數已達上限，請聯絡平台處理。';

/** 頻率限制的時間窗，小時。實際的計算在資料庫函式，這個值只寫進稽核事件。 */
export const COLLISION_WINDOW_HOURS = 24;

export type KeyClaim =
  /** 鍵沒人用，錨點轉已建號。 */
  | { kind: 'keyed' }
  /** 撞到別的組織。錨點維持待驗證，reviewTicket 是審核單號。 */
  | { kind: 'review_queued'; reviewTicket: string }
  /** 撞到自己組織的鍵。propertyId 是自己既有的物件。 */
  | { kind: 'existing'; propertyId: string }
  /** 24 小時內的撞號回應已達上限。資料庫什麼都沒寫。 */
  | { kind: 'rate_limited' };

interface ClaimRow {
  outcome: 'keyed' | 'collision_queued' | 'own_existing' | 'rate_limited';
  item_id: string | null;
  property_id: string | null;
}

/**
 * 呼叫 registry.assign_anchor_key。
 * 函式的格式錯誤等例外（SQLSTATE 22023、55000、P0002）原樣丟出，呼叫端必須讓交易回滾。
 * 撞號不是例外，是回傳值，呼叫端自己決定要不要回滾。
 */
export async function claimAnchorKey(tx: OrgTx, anchorId: string, key: AnchorKey): Promise<KeyClaim> {
  const { rows } = await tx.query<ClaimRow>('SELECT * FROM registry.assign_anchor_key($1, $2, $3, $4, $5, $6, $7)', [
    anchorId,
    key.cityCode,
    key.townCode,
    key.sectionCode,
    key.buildingNo,
    key.subNo,
    newUlid(),
  ]);
  const row = rows[0];
  switch (row.outcome) {
    case 'keyed':
      return { kind: 'keyed' };
    case 'collision_queued':
      return { kind: 'review_queued', reviewTicket: row.item_id! };
    case 'own_existing':
      return { kind: 'existing', propertyId: row.property_id! };
    case 'rate_limited':
      return { kind: 'rate_limited' };
  }
}

/** 撞號已送審核台，在宣稱方組織的鏈留一筆。payload 只放自己的租賃單位 ID 與審核單號。 */
export async function auditCollisionQueued(tx: OrgTx, propertyId: string, rentalUnitId: string, reviewTicket: string): Promise<void> {
  await appendAudit(tx, {
    action: 'property.anchor_collision',
    object: { type: 'property', id: propertyId },
    payload: { rental_unit_id: rentalUnitId, review_item_id: reviewTicket },
  });
}

/**
 * 超過上限：通知平台營運者並留稽核事件。必須在呼叫端回滾自己的半成品（savepoint）之後呼叫，
 * 這樣審核台項目與稽核事件才會跟著交易提交，而不是跟著失敗的建立一起消失。
 * 通知用審核台項目：notify() 只寫呼叫者交易所屬組織的站內通知，營運者身分沒有可讀的通知清單。
 */
export async function recordCollisionLimitHit(tx: OrgTx): Promise<void> {
  await tx.query('SELECT registry.record_collision_limit_hit($1)', [newUlid()]);
  await appendAudit(tx, {
    action: 'property.anchor_collision_limited',
    payload: { window_hours: COLLISION_WINDOW_HOURS },
  });
}
