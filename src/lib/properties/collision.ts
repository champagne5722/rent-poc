import { newUlid } from '@/lib/pg/ulid';
import type { OrgTx } from '@/lib/pg/with-tx';
import type { AnchorKey } from '@/lib/registry/section-code';

// 登錄物件與修正建號時，registry.assign_anchor_key 的 TypeScript 側（MIL-144、MIL-196）。
//
// 對外只有兩種結果：登錄成立，或鍵已被自己的組織登錄。
// 函式內部區分「鍵沒人用」「撞到別的組織」，這裡刻意把兩者收成同一種結果。
// 呼叫端因此看不到差別，也就寫不出依撞號而不同的回應、狀態或稽核事件（ADR-0028 決議 1）。
// 鍵撞到別的組織時，審核台項目與平台鏈的稽核事件都由函式在資料庫內寫入。

export type KeyClaim =
  /** 登錄成立。鍵有沒有撞到別的組織，這裡看不出來。 */
  | { kind: 'accepted' }
  /** 鍵已被自己的組織登錄。propertyId 是自己既有的物件。 */
  | { kind: 'existing'; propertyId: string }
  /**
   * 物件已通過核對，修正建號改送審核台（MIL-201）。物件的鍵維持原樣。
   * 只取決於呼叫者自己組織的核對結果，與鍵有沒有撞到別的組織無關。
   */
  | { kind: 'rekey_requested' };

interface ClaimRow {
  outcome: 'keyed' | 'collision_queued' | 'own_existing' | 'rekey_queued';
  item_id: string | null;
  property_id: string | null;
}

/**
 * 呼叫 registry.assign_anchor_key。
 * 函式的格式錯誤等例外（SQLSTATE 22023、55000、P0002）原樣丟出，呼叫端必須讓交易回滾。
 */
export async function claimAnchorKey(tx: OrgTx, anchorId: string, key: AnchorKey): Promise<KeyClaim> {
  const { rows } = await tx.query<ClaimRow>('SELECT * FROM registry.assign_anchor_key($1, $2, $3, $4, $5, $6, $7, $8)', [
    anchorId,
    key.cityCode,
    key.townCode,
    key.sectionCode,
    key.buildingNo,
    key.subNo,
    newUlid(),
    newUlid(),
  ]);
  const row = rows[0];
  if (row.outcome === 'own_existing') return { kind: 'existing', propertyId: row.property_id! };
  if (row.outcome === 'rekey_queued') return { kind: 'rekey_requested' };
  return { kind: 'accepted' };
}
