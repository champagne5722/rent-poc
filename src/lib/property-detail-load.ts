import { authorize, bindAccessContext, checkAccess, Forbidden } from './authorize';
import { listCaseSummaries, type CaseSummary } from './case-store';
import { requestContext } from './current-request-context';
import { getPropertyOwnership } from './ownership';
import { withTx } from './pg/database';
import { isUlid } from './pg/ulid';
import { getProperty, listSiblingUnits } from './properties';
import { toDbContext } from './request-context';
import type { Property, PropertyOwnership, SiblingUnit } from './types';

// 物件詳情的資料載入（MIL-177、MIL-209）。詳情頁在 server component 呼叫它，client component 只管畫面與操作。
// 讀的資料與原本詳情頁打的三支 GET API 相同：物件、同一個物件下的租賃單位、出租權源文件的核對狀態。
// 另外帶出這個物件的案件，內容與 GET /api/cases?property_id= 相同。

export interface PropertyDetailData {
  property: Property;
  /** 同一個物件下自己組織的租賃單位，含目前這一個。 */
  units: SiblingUnit[];
  /** 出租權源文件的核對狀態與送件紀錄。 */
  ownership: PropertyOwnership;
  /** 這個物件的案件（MIL-209，GET /api/cases?property_id=）。沒有列出案件的權限時是空陣列。 */
  cases: CaseSummary[];
}

export type PropertyDetailLoad =
  | ({ kind: 'ok' } & PropertyDetailData)
  // 格式錯誤的 ID、別的組織的 ID、不存在的 ID、沒有查看權限，對外同一個畫面（P0-02 AC1，ADR-0023 決議 6）
  | { kind: 'not_found' }
  // 不是組織身分
  | { kind: 'forbidden' };

/**
 * 載入一個物件的詳情。沒登入時丟 Unauthenticated，由頁面導向登入。
 * 只給 server component 用；route handler 走 inOrgTx，才能把拒絕轉成 401、403 的回應。
 */
export async function loadPropertyDetail(id: string): Promise<PropertyDetailLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org') return { kind: 'forbidden' };
  if (!isUlid(id)) return { kind: 'not_found' };
  try {
    const read = await withTx(toDbContext(rc), async (tx) => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'property.read', { type: 'property', id });
      const property = await getProperty(tx, id);
      if (!property) return null;
      const units = (await listSiblingUnits(tx, id)) ?? [];
      const ownership = await getPropertyOwnership(tx, id, rc.partyId);
      if (!ownership) return null;
      // 案件是輔助資訊：沒有 case.list 權限時，詳情照常顯示，案件區顯示空狀態
      const cases = (await checkAccess(tx, 'case.list', { type: 'org' })).allowed ? await listCaseSummaries(tx, { propertyId: id }) : [];
      return { property, units, ownership, cases };
    });
    return read ? { kind: 'ok', ...read } : { kind: 'not_found' };
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'not_found' };
    throw error;
  }
}
