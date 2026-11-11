import { authorize, bindAccessContext, Forbidden } from './authorize';
import { requestContext } from './current-request-context';
import { withTx } from './pg/database';
import { listPropertyGroups, listVocabulary } from './properties';
import { toDbContext } from './request-context';
import type { EquipmentVocabularyItem, PropertyGroup } from './types';

// 物件列表的資料載入（MIL-177）。列表頁在 server component 呼叫它，client component 只管篩選與表單。
// 讀的資料與原本列表頁打的兩支 GET API 相同：依物件分組的列表（GET /api/properties?group=object）與設備詞彙庫。

export type PropertyListLoad =
  | { kind: 'ok'; groups: PropertyGroup[]; vocabulary: EquipmentVocabularyItem[] }
  // 不是組織身分，或身分沒有查看物件的權限
  | { kind: 'forbidden' };

/**
 * 載入目前組織的物件列表。沒登入時丟 Unauthenticated，由頁面導向登入。
 * 只給 server component 用；route handler 走 inOrgTx，才能把拒絕轉成 401、403 的回應。
 */
export async function loadPropertyList(): Promise<PropertyListLoad> {
  const rc = await requestContext();
  if (rc.kind !== 'org') return { kind: 'forbidden' };
  try {
    return await withTx(toDbContext(rc), async (tx) => {
      bindAccessContext(tx, rc);
      await authorize(tx, 'property.read', { type: 'org' });
      return { kind: 'ok' as const, groups: await listPropertyGroups(tx), vocabulary: await listVocabulary(tx) };
    });
  } catch (error) {
    if (error instanceof Forbidden) return { kind: 'forbidden' };
    throw error;
  }
}
