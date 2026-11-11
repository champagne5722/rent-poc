// 從物件建立案件的入口（MIL-209、MIL-205，ADR-0029 決議 1、ADR-0030）。純函式，沒有 I/O，client 與 server 都能引用。
// 三處入口（物件詳情、租賃單位列、物件列表的每一列）與建約精靈共用這裡的網址、文字與錯誤去向。

import { isPropertyCaseKind, PROPERTY_CASE_KINDS } from './cases';
import { PROPERTY_NOT_VERIFIED_CODE } from './ownership/gate';
import { isUlid } from './pg/ulid';
import { statusPresentation } from './status-presentation';
import type { PropertyCaseKind } from './types';

/** 建約精靈的入口路徑。參數是 `property` 與 `kind`。 */
export const NEW_CASE_PATH = '/contracts/new';
/** 入口參數不合法、物件看不到時的去向。 */
export const PROPERTY_LIST_HREF = '/properties';
/** 執業主體頁。業別與專任管理人員都在這裡處理。 */
const PRACTICE_PAGE_HREF = '/practice';

/** 精靈的入口參數。`property` 是租賃單位的物件 ID，`kind` 是案件種類。 */
export interface NewCaseParams {
  propertyId: string;
  kind: PropertyCaseKind;
}

/**
 * 委託管理合約的暫時入口（MIL-209 決定 6）。委託管理合約不綁單一物件，從物件建立屬於 MIL-212。
 * 在那之前保留原本的建立方式：精靈用 `kind=management` 且不帶 `property`，建立草稿走舊路徑。
 */
export const MANAGEMENT_ENTRY_HREF = `${NEW_CASE_PATH}?kind=management`;

/** 組出精靈的入口網址。 */
export function newCaseHref(propertyId: string, kind: PropertyCaseKind): string {
  const query = new URLSearchParams({ property: propertyId, kind });
  return `${NEW_CASE_PATH}?${query.toString()}`;
}

type RawParam = string | string[] | undefined;

const firstOf = (value: RawParam): string | undefined => (Array.isArray(value) ? value[0] : value);

/**
 * 解析精靈的入口參數。沒帶、格式錯誤、案件種類不認得都回 null，呼叫端導到物件列表。
 * 委託管理案件不綁單一物件，不走這個入口（它的案件種類不在 `PROPERTY_CASE_KINDS`）。
 * 物件看不看得到由伺服端判斷，這裡只檢查格式。
 */
export function parseNewCaseParams(raw: { property?: RawParam; kind?: RawParam }): NewCaseParams | null {
  const propertyId = firstOf(raw.property);
  const kind = firstOf(raw.kind);
  if (!isUlid(propertyId) || !isPropertyCaseKind(kind)) return null;
  return { propertyId, kind };
}

/** 是委託管理合約的暫時入口：`kind=management` 而且沒有 `property`。帶了 `property` 的組合不合法，導到物件列表。 */
export function isManagementEntry(raw: { property?: RawParam; kind?: RawParam }): boolean {
  return firstOf(raw.kind) === 'management' && firstOf(raw.property) === undefined;
}

/** 入口按鈕的文字，案件種類的名稱取自狀態呈現表。例：「建立租賃案件」。 */
export function createCaseLabel(kind: PropertyCaseKind): string {
  return `建立${statusPresentation('caseKind', kind).label}`;
}

/** 入口依固定順序列出能建的案件種類。順序與 `GET /api/properties/[id]` 相同。 */
export function orderedCaseKinds(kinds: readonly PropertyCaseKind[]): PropertyCaseKind[] {
  return PROPERTY_CASE_KINDS.filter((kind) => kinds.includes(kind));
}

export interface CreationBlockedNext {
  href: string;
  label: string;
}

/**
 * 伺服端建立案件回 409 時的下一步。畫面顯示伺服端的原因文字，並用這裡的連結告訴使用者去哪裡處理。
 * 畫面不顯示錯誤碼本身。沒有碼、不認得的碼，都回到這個物件的詳情，詳情的「下一步」寫出現況。
 */
export function creationBlockedNext(code: string | undefined, propertyId: string): CreationBlockedNext {
  switch (code) {
    case PROPERTY_NOT_VERIFIED_CODE:
      return { href: `${PROPERTY_LIST_HREF}/${propertyId}`, label: '查看物件的核對狀態' };
    case 'practice_entity_not_verified':
      return { href: PRACTICE_PAGE_HREF, label: '前往執業主體頁' };
    case 'no_signable_manager':
      return { href: PRACTICE_PAGE_HREF, label: '前往執業人員頁' };
    case 'host_org_not_allowed':
      return { href: PROPERTY_LIST_HREF, label: '返回物件列表' };
    default:
      return { href: `${PROPERTY_LIST_HREF}/${propertyId}`, label: '查看物件' };
  }
}
