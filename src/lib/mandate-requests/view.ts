// 申請畫面（MIL-206 畫面段）的純函式：文字、選項與「下一步」的內容。沒有 I/O，前端與伺服器端都能匯入。
// 狀態一律用資料段回傳的 status（讀取時已依期限判定）。這裡不算日期，不自己判斷失效。
// 業者端的文字不得顯示或暗示連結有沒有被打開：待屋主確認時，三種情況的文字相同。

import type { StatusTone } from '../status-presentation';
import type {
  MandateRequestDraft,
  MandateRequestKind,
  OwnerMandateRequest,
  PracticeMandateRequest,
  PropertyGroup,
} from '../types';
import { MANDATE_REQUEST_KINDS } from '../types';
import { formatTaipeiDateTime } from '../ownership/format';
import { KIND_LABEL } from './messages';
import { LICENSE_KIND_OF } from './status';
import { unitShortText } from '../properties/unit-display';

/** 業別的法定稱謂（GLOSSARY「法定稱謂」）。連結頁的「已驗證的業別」用它。 */
export const LICENSE_KIND_TITLE: Readonly<Record<string, string>> = {
  management: '租賃住宅代管業者',
  master_lease: '租賃住宅包租業者',
  brokerage: '不動產經紀業者',
};

/** 業別代碼轉成稱謂。不認得的代碼原樣顯示，不吞掉。 */
export function licenseKindTitles(kinds: readonly string[]): string[] {
  return kinds.map((kind) => LICENSE_KIND_TITLE[kind] ?? kind);
}

/**
 * 已驗證的業別能產生哪些種類的申請。委託管理申請對代管業，住宅包租申請對包租業。
 * 順序固定依 MANDATE_REQUEST_KINDS。沒有任何已驗證的對應業別時回空陣列。
 */
export function requestKindsFor(verifiedLicenseKinds: readonly string[]): MandateRequestKind[] {
  return MANDATE_REQUEST_KINDS.filter((kind) => verifiedLicenseKinds.includes(LICENSE_KIND_OF[kind]));
}

export function kindOptions(kinds: readonly MandateRequestKind[]): Array<{ value: MandateRequestKind; label: string }> {
  return kinds.map((kind) => ({ value: kind, label: KIND_LABEL[kind] }));
}

/** 連結的完整網址。origin 由瀏覽器的 location 提供，linkPath 是 API 回的 /request/<碼>。 */
export function requestLinkUrl(origin: string, linkPath: string): string {
  return `${origin.replace(/\/+$/, '')}${linkPath}`;
}

/** 代填資料的建號文字。沒有建號回 null。 */
export function draftBuildingText(draft: MandateRequestDraft | null | undefined): string | null {
  const key = draft?.anchor?.key;
  if (!key || !key.buildingNo) return null;
  return key.subNo ? `建號 ${key.buildingNo}-${key.subNo}` : `建號 ${key.buildingNo}`;
}

/** 業者列表用的代填摘要：物件名稱與地址。沒有代填資料回 emptyText，預設「未代填」。 */
export function draftSummaryText(draft: MandateRequestDraft | null | undefined, emptyText = '未代填'): string {
  if (!draft) return emptyText;
  return draft.address ? `${draft.name}，${draft.address}` : draft.name;
}

export interface NextStepView {
  headline: string;
  /** 負責人。 */
  owner: string;
  detail?: string;
  tone: StatusTone;
}

const deadlineText = (deadline: string | null): string | undefined => (deadline ? `連結有效到 ${formatTaipeiDateTime(deadline)}。` : undefined);

/** 業者的申請詳情頂端的「下一步」。待屋主確認時，不論有沒有人打開連結，文字都相同。 */
export function practiceNextStep(request: PracticeMandateRequest): NextStepView {
  switch (request.status) {
    case 'pending_owner':
      return { headline: '等屋主確認並送出申請', owner: '屋主', detail: deadlineText(request.deadline), tone: 'progress' };
    case 'pending_practice':
      return {
        headline: '屋主已送出申請',
        owner: '你的組織',
        detail: request.unit_count === null ? undefined : `申請含 ${request.unit_count} 個租賃單位。`,
        tone: 'progress',
      };
    case 'accepted':
      return { headline: '申請已接受', owner: '你的組織', tone: 'success' };
    case 'declined':
      return { headline: '申請未接受，不需要處理', owner: '無', tone: 'neutral' };
    case 'withdrawn':
      return { headline: '屋主已收回申請，不需要處理', owner: '無', tone: 'neutral' };
    case 'ended':
      return { headline: '申請已結束，不需要處理', owner: '無', tone: 'neutral' };
    case 'completed':
      return { headline: '申請已完成，不需要處理', owner: '無', tone: 'success' };
    case 'expired':
      return { headline: '申請已失效。需要時重新產生連結', owner: '你的組織', tone: 'warning' };
  }
}

/** 屋主的申請詳情頂端的「下一步」。 */
export function ownerNextStep(request: OwnerMandateRequest): NextStepView {
  switch (request.status) {
    case 'pending_owner':
      return {
        headline: '確認並送出申請',
        owner: '你',
        detail: '送出前，業者看不到你選的租賃單位。送出後，業者接受前你能收回。',
        tone: 'progress',
      };
    case 'pending_practice':
      return { headline: '等業者接受', owner: '業者', detail: '業者接受前，你能收回申請。', tone: 'progress' };
    case 'accepted':
      return { headline: '業者已接受申請', owner: '業者', tone: 'success' };
    case 'declined':
      return { headline: '業者沒有接受申請', owner: '無', tone: 'neutral' };
    case 'withdrawn':
      return { headline: '你已收回申請，不需要處理', owner: '無', tone: 'neutral' };
    case 'ended':
      return { headline: '申請已結束，不需要處理', owner: '無', tone: 'neutral' };
    case 'completed':
      return { headline: '申請已完成，不需要處理', owner: '無', tone: 'success' };
    case 'expired':
      return { headline: '申請已失效。請向業者索取新的連結', owner: '你', tone: 'warning' };
  }
}

/** 屋主能確認並送出：申請還在待屋主確認。 */
export function ownerCanSubmit(request: Pick<OwnerMandateRequest, 'status'>): boolean {
  return request.status === 'pending_owner';
}

/** 屋主能收回：已送出、業者還沒接受。尚未送出的申請沒有收回的按鈕（驗收 13）。 */
export function ownerCanWithdraw(request: Pick<OwnerMandateRequest, 'status'>): boolean {
  return request.status === 'pending_practice';
}

/** 屋主要先確認代填資料：有代填資料，而且還沒確認。 */
export function ownerMustConfirmDraft(request: Pick<OwnerMandateRequest, 'status' | 'draft' | 'confirmed_unit_id'>): boolean {
  return request.status === 'pending_owner' && request.draft !== null && request.confirmed_unit_id === null;
}

export interface UnitOption {
  /** 租賃單位 ID，送出申請時列在 unit_ids。 */
  unitId: string;
  name: string;
  /** 「整戶」或「分租 301」。 */
  kindText: string;
  address: string;
  displayCode: string | null;
}

/** 屋主能交出的租賃單位：自己登錄、沒封存的。 */
export function unitOptions(groups: readonly PropertyGroup[]): UnitOption[] {
  const options: UnitOption[] = [];
  for (const group of groups) {
    for (const unit of group.units) {
      if (unit.archived_at !== null || !unit.unit || unit.unit.status !== 'active') continue;
      options.push({
        unitId: unit.rental_unit_id,
        name: unit.name,
        kindText: unitShortText(unit.unit),
        address: group.address,
        displayCode: unit.unit.display_code,
      });
    }
  }
  return options;
}

/** 屋主送出申請時一次最多的租賃單位數。與 submit route 的 MAX_UNITS 相同。 */
export const MAX_UNITS_PER_REQUEST = 100;
