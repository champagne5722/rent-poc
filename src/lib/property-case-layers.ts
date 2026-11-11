import type { StatutoryCaseKind } from './cases/case-kind';

// 物件詳情的案件兩層（MIL-177，ADR-0030 決議 5）：委託管理案件與底下的租賃案件，包租案件與底下的轉租案件。
// 純函式，沒有 I/O。上下層由案件的兩個連結欄位決定：linkedMandateCaseId 連到委託管理案件，linkedMasterLeaseCaseId 連到包租案件。

export interface LayerCase {
  id: string;
  caseKind: StatutoryCaseKind;
  linkedMandateCaseId: string | null;
  linkedMasterLeaseCaseId: string | null;
}

export interface CaseLayer<T extends LayerCase> {
  /** 上層案件。上層案件不在這個物件的案件裡（例如委託管理案件不綁單一物件）時是 null。 */
  parent: T | null;
  /** 上層案件的 ID。parent 是 null 時，畫面用它連到上層案件。 */
  parentId: string;
  /** 上層案件的種類。parent 是 null 時，由連結欄位推出。 */
  parentKind: 'management' | 'master_lease' | StatutoryCaseKind;
  /** 下層案件。沒有時是空陣列。 */
  children: T[];
}

const parentIdOf = (c: LayerCase): string | null => c.linkedMandateCaseId ?? c.linkedMasterLeaseCaseId;

/** 把物件的案件排成兩層。順序沿用傳入的順序：先是在清單裡的上層案件，再是找不到上層的下層案件。 */
export function buildCaseLayers<T extends LayerCase>(cases: readonly T[]): CaseLayer<T>[] {
  const ids = new Set(cases.map((c) => c.id));
  const kids = new Map<string, T[]>();
  for (const c of cases) {
    const parentId = parentIdOf(c);
    if (parentId === null) continue;
    kids.set(parentId, [...(kids.get(parentId) ?? []), c]);
  }
  const layers: CaseLayer<T>[] = [];
  for (const c of cases) {
    if (parentIdOf(c) !== null) continue;
    layers.push({ parent: c, parentId: c.id, parentKind: c.caseKind, children: kids.get(c.id) ?? [] });
  }
  for (const [parentId, children] of kids) {
    if (ids.has(parentId)) continue;
    layers.push({ parent: null, parentId, parentKind: children[0]!.linkedMandateCaseId === parentId ? 'management' : 'master_lease', children });
  }
  return layers;
}

/** 物件詳情「案件」區沒有案件時的說明。已核對的物件已經能建立案件，不再提核對。 */
export function casesEmptyText(verified: boolean): string {
  return verified ? '這個物件還沒有案件。' : '這個物件還沒有案件。物件通過平台文件核對後，就能建立案件。';
}
