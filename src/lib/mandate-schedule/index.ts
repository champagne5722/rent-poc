// 委託標的清單與委託範圍（MIL-74、P0-11、GLOSSARY「委託標的清單」「委託範圍」）。
// 這個檔案只有純資料與純函式，沒有 fs，client 端的 wizard 也能引用。資料表與 repository 在 tables.ts、repository.ts。
//
// 委託標的清單是委託管理合約的附件，逐列記錄租賃單位與委託範圍。B 線完成前，租賃單位從物件多選，
// 並快照名稱與地址，之後與物件脫鉤。ID 一律是字串：B 線的產權錨點（ADR-0013）不是本機資料表的數字 ID。

/** 委託範圍的四項（P0-11）。順序固定，文字與畫面都依這個順序。 */
export const MANDATE_SCOPES = ['rent_collection', 'deposit_management', 'repair', 'handover'] as const;
export type MandateScope = (typeof MANDATE_SCOPES)[number];

export const MANDATE_SCOPE_LABELS: Record<MandateScope, string> = {
  rent_collection: '收租',
  deposit_management: '押金管理',
  repair: '修繕',
  handover: '點交',
};

/** 四項委託範圍依固定順序排成文字：收租、押金管理、修繕、點交。條文與附件頁共用。 */
export const MANDATE_SCOPE_LIST_TEXT = MANDATE_SCOPES.map((s) => MANDATE_SCOPE_LABELS[s]).join('、');

/** 清單的一列：一個租賃單位與授權受託人的事項。名稱與地址是建立當下的快照。 */
export interface MandateItem {
  propertyId: string;
  propertyName: string;
  propertyAddress: string;
  scopes: MandateScope[];
}

/** 範圍依固定順序排列，去掉重複。 */
export function normalizeScopes(scopes: readonly MandateScope[]): MandateScope[] {
  return MANDATE_SCOPES.filter((s) => scopes.includes(s));
}

/** 把勾選的範圍依固定順序排成文字，例如「收租、點交」。 */
export function mandateScopeText(scopes: readonly MandateScope[]): string {
  const labels = normalizeScopes(scopes).map((s) => MANDATE_SCOPE_LABELS[s]);
  return labels.length ? labels.join('、') : '（未勾選）';
}

/** 從物件建立清單列。名稱與地址在此快照，預設沒有勾選範圍。 */
export function mandateItemFromProperty(
  property: { id: number | string; name: string; address: string },
  scopes: readonly MandateScope[] = [],
): MandateItem {
  return {
    propertyId: String(property.id),
    propertyName: property.name,
    propertyAddress: property.address,
    scopes: normalizeScopes(scopes),
  };
}

/** 清單的檢核，回傳全部問題。清單要有至少一列、每列至少勾一項範圍、同一個租賃單位只能一列。 */
export function mandateItemsIssues(items: readonly MandateItem[]): string[] {
  if (items.length === 0) return ['委託標的清單至少要有一個租賃單位'];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.propertyId)) {
      issues.push(`${item.propertyName}在清單中重複`);
      continue;
    }
    seen.add(item.propertyId);
    if (item.scopes.length === 0) issues.push(`${item.propertyName}尚未勾選委託範圍`);
  }
  return issues;
}

/**
 * 某個租賃單位的委託範圍，依固定順序。不在清單內的租賃單位回空陣列。
 * 供 C 線在代管案件限制受託人的動作（P0-11 AC4）。D 線不限制受託人的動作。
 */
export function mandateScopesOf(items: readonly MandateItem[], propertyId: string): MandateScope[] {
  const item = items.find((i) => i.propertyId === propertyId);
  return item ? normalizeScopes(item.scopes) : [];
}

export function isScopeMandated(items: readonly MandateItem[], propertyId: string, scope: MandateScope): boolean {
  return mandateScopesOf(items, propertyId).includes(scope);
}

/** 請求裡的一列選擇：租賃單位編號與勾選的範圍。名稱與地址由伺服器取，不信任請求帶來的快照。 */
export interface MandateSelection {
  propertyId: string;
  scopes: MandateScope[];
}

/** 解析請求本文 `{ items: [{ propertyId, scopes }] }`。格式不對回 null。 */
export function parseMandateSelection(body: unknown): MandateSelection[] | null {
  const list = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) return null;
  const parsed: MandateSelection[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return null;
    const { propertyId, scopes } = item as Record<string, unknown>;
    if (typeof propertyId !== 'string' && typeof propertyId !== 'number') return null;
    const id = String(propertyId);
    if (!id) return null;
    if (!Array.isArray(scopes) || !scopes.every((s) => (MANDATE_SCOPES as readonly unknown[]).includes(s))) return null;
    parsed.push({ propertyId: id, scopes: normalizeScopes(scopes as MandateScope[]) });
  }
  return parsed;
}

export type ResolveMandateResult = { ok: true; items: MandateItem[] } | { ok: false; error: string };

/**
 * 把選擇換成清單。已存的列沿用原本的名稱與地址快照（快照建立後不隨物件改動），
 * 只有新加的列才向 `lookup` 取物件當下的名稱與地址。列的順序照選擇的順序。
 */
export function resolveMandateItems(
  selection: readonly MandateSelection[],
  stored: readonly MandateItem[],
  lookup: (propertyId: string) => { name: string; address: string } | null,
): ResolveMandateResult {
  const seen = new Set<string>();
  const items: MandateItem[] = [];
  for (const pick of selection) {
    if (seen.has(pick.propertyId)) return { ok: false, error: '同一個租賃單位只能選一次' };
    seen.add(pick.propertyId);
    const existing = stored.find((i) => i.propertyId === pick.propertyId);
    if (existing) {
      items.push({ ...existing, scopes: normalizeScopes(pick.scopes) });
      continue;
    }
    const property = lookup(pick.propertyId);
    if (!property) return { ok: false, error: `找不到物件 ${pick.propertyId}` };
    items.push(mandateItemFromProperty({ id: pick.propertyId, ...property }, pick.scopes));
  }
  return { ok: true, items };
}
