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

/** 代填資料的建號，帶分號時一起顯示，例如 12345-000。沒有建號回 null。畫面自己加「建號」的標籤。 */
export function draftBuildingNo(draft: MandateRequestDraft | null | undefined): string | null {
  const key = draft?.anchor?.key;
  if (!key || !key.buildingNo) return null;
  return key.subNo ? `${key.buildingNo}-${key.subNo}` : key.buildingNo;
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

const MONTH_DAY = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' });

/** 「M月D日」，臺北時間。無法解析回「—」。 */
export function formatMonthDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const p = Object.fromEntries(MONTH_DAY.formatToParts(date).map((part) => [part.type, part.value]));
  return `${Number(p.month)}月${Number(p.day)}日`;
}

/**
 * 業者的申請列表與詳情的期限文字。期限由資料段的 deadlineOf 算好放在 request.deadline，這裡只換成文字，不自己算日期。
 * 待業者接受是「M月D日前回覆」，已接受是「M月D日前送出合約」，已失效是「已失效」。
 * 待屋主確認維持完整的連結失效時間。沒有期限的狀態回 null。
 */
export function practiceDeadlineText(request: Pick<PracticeMandateRequest, 'status' | 'deadline'>): string | null {
  if (request.status === 'expired') return '已失效';
  if (!request.deadline) return null;
  switch (request.status) {
    case 'pending_practice':
      return `${formatMonthDay(request.deadline)}前回覆`;
    case 'accepted':
      return `${formatMonthDay(request.deadline)}前送出合約`;
    case 'pending_owner':
      return formatTaipeiDateTime(request.deadline);
    default:
      return null;
  }
}

/** 接受之後，業者的畫面不得出現任何物件的資料，包含租賃單位的數量。接受之前的數量照舊顯示。 */
export function practiceMayShowUnits(request: Pick<PracticeMandateRequest, 'accepted_at'>): boolean {
  return request.accepted_at === null;
}

/** 詳情與列表上，結束或未接受的是哪一方，業者視角。 */
export function practiceClosedByText(request: Pick<PracticeMandateRequest, 'status' | 'closed_by'>): string | null {
  if (request.status !== 'ended') return null;
  return request.closed_by === 'practice' ? '你的組織已結束申請' : '屋主已結束申請';
}

/** 屋主視角：已結束的是哪一方。 */
export function ownerClosedByText(request: Pick<OwnerMandateRequest, 'status' | 'closed_by'>): string | null {
  if (request.status !== 'ended') return null;
  return request.closed_by === 'practice' ? '業者已結束申請' : '你已結束申請';
}

/** 非組織管理員看到的說明。 */
export const ONLY_ADMIN_RESPOND_TEXT = '只有組織管理員能回覆申請。';
export const ONLY_ADMIN_END_TEXT = '只有組織管理員能結束申請。';
/** 沒有合格的管理人員時，接受鍵旁邊的說明。 */
export const NO_MANAGER_HINT = '貴公司目前沒有通過核對的租賃住宅管理人員，不能接受申請。請先到執業主體頁完成人員的核對。';
/** 不接受的確認文字：寫明屋主只看到「未接受」，沒有原因。待法務確認。 */
export const DECLINE_CONFIRM_TEXT = '按下後，屋主只會看到「未接受」。你不需要填原因，屋主也看不到原因。這份申請不能恢復。';
export const PRACTICE_END_CONFIRM_TEXT = '結束後，屋主會收到通知，申請不能恢復。你不需要填原因。';
export const OWNER_END_CONFIRM_TEXT = '結束後，業者會收到通知。申請不能恢復，需要時請向業者索取新的連結。你不需要填原因。';
export const STATE_CHANGED_TEXT = '申請的狀態已改變';

/**
 * 接受、不接受、結束失敗時要顯示的文字。
 * not_pending 一律「申請的狀態已改變」，畫面要重新載入。其他錯誤碼顯示伺服端的固定訊息，不自己改字。
 */
export function decisionErrorText(code: string | undefined, serverMessage: string | undefined, fallback: string): string {
  if (code === 'not_pending') return STATE_CHANGED_TEXT;
  return serverMessage ?? fallback;
}

/** 這個錯誤之後要重新載入申請：狀態已改變，或資格已改變。 */
export function decisionErrorReloads(code: string | undefined): boolean {
  return code === 'not_pending' || code === 'not_found';
}

/** 業者的申請詳情頂端的「下一步」。待屋主確認時，不論有沒有人打開連結，文字都相同。 */
export function practiceNextStep(request: PracticeMandateRequest): NextStepView {
  switch (request.status) {
    case 'pending_owner':
      return { headline: '等屋主確認並送出申請', owner: '屋主', detail: deadlineText(request.deadline), tone: 'progress' };
    case 'pending_practice': {
      const parts = [
        request.unit_count === null ? null : `申請含 ${request.unit_count} 個租賃單位。`,
        request.deadline ? `請在 ${formatMonthDay(request.deadline)}前回覆，逾期申請失效。` : null,
      ].filter((part): part is string => part !== null);
      return { headline: '屋主已送出申請，等你回覆', owner: '你的組織', detail: parts.length > 0 ? parts.join('') : undefined, tone: 'progress' };
    }
    case 'accepted':
      return {
        headline: '申請已接受',
        owner: '你的組織',
        detail: request.deadline ? `下一步是擬定契約。請在 ${formatMonthDay(request.deadline)}前送出合約，逾期申請失效。` : '下一步是擬定契約。',
        tone: 'success',
      };
    case 'declined':
      return { headline: '申請未接受，不需要處理', owner: '無', tone: 'neutral' };
    case 'withdrawn':
      return { headline: '屋主已收回申請，不需要處理', owner: '無', tone: 'neutral' };
    case 'ended':
      return { headline: `${practiceClosedByText(request) ?? '申請已結束'}，不需要處理`, owner: '無', tone: 'neutral' };
    case 'completed':
      return { headline: '申請已完成，不需要處理', owner: '無', tone: 'success' };
    case 'expired':
      return { headline: '申請已失效。需要時重新產生連結', owner: '你的組織', tone: 'warning' };
  }
}

/** 屋主的申請詳情頂端的「下一步」。未接受只寫「未接受」，不寫任何原因或說明。 */
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
      return { headline: '業者已接受申請', owner: '業者', detail: '合約完成前，你能結束申請。', tone: 'success' };
    case 'declined':
      return { headline: '未接受', owner: '無', tone: 'neutral' };
    case 'withdrawn':
      return { headline: '你已收回申請，不需要處理', owner: '無', tone: 'neutral' };
    case 'ended':
      return { headline: `${ownerClosedByText(request) ?? '申請已結束'}，不需要處理`, owner: '無', tone: 'neutral' };
    case 'completed':
      return { headline: '申請已完成，不需要處理', owner: '無', tone: 'success' };
    case 'expired':
      return { headline: '申請已失效。請向業者索取新的連結', owner: '你', tone: 'warning' };
  }
}

/** 業者能回覆（接受、不接受）：待業者接受。 */
export function practiceCanRespond(request: Pick<PracticeMandateRequest, 'status'>): boolean {
  return request.status === 'pending_practice';
}

/** 雙方能結束：已接受，還沒失效。 */
export function canEndRequest(request: Pick<PracticeMandateRequest | OwnerMandateRequest, 'status'>): boolean {
  return request.status === 'accepted';
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
