import type { CaseEventRecord } from './case-store/types';
import { BUSINESS_TYPE_LABELS } from './labels';
import { CASE_EVENT_LABELS, CASE_INPUT_LABELS, CASE_STATE_LABELS } from './labels/case-labels';
import type { BusinessType, CaseInputType, CaseState, StatutoryCaseKind } from './cases';
import { statusPresentation } from './status-presentation';

// 案件畫面共用的顯示函式（MIL-115）。純函式，沒有 I/O，清單與詳情都用。

const TAIPEI = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 台灣時區的 YYYY-MM-DD HH:mm。 */
export function formatTaipei(iso: string): string {
  const parts = Object.fromEntries(TAIPEI.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** 租期顯示：兩端都有顯示區間，只有一端顯示那一端，都沒有顯示破折號。 */
export function leasePeriodLabel(start: string | null, end: string | null): string {
  if (start && end) return `${start} 至 ${end}`;
  if (start) return `${start} 起`;
  if (end) return `至 ${end}`;
  return '—';
}

export function monthlyRentLabel(rent: number | null): string {
  return rent === null ? '—' : `$${rent.toLocaleString('zh-TW')}`;
}

/** 案件事件在時間軸上的說明：事件名稱，加上狀態變化或被拒絕的操作。 */
export function eventDescription(event: Pick<CaseEventRecord, 'type' | 'fromState' | 'toState' | 'payload'>): string {
  const base = CASE_EVENT_LABELS[event.type];
  if (event.type === 'input_rejected') {
    const input = String(event.payload.inputType ?? '') as CaseInputType;
    const state = String(event.payload.state ?? '') as CaseState;
    const inputLabel = CASE_INPUT_LABELS[input] ?? '操作';
    const stateLabel = CASE_STATE_LABELS[state] ?? '';
    return stateLabel ? `${base}：${inputLabel}（案件目前是${stateLabel}）` : `${base}：${inputLabel}`;
  }
  if (event.fromState && event.toState && event.fromState !== event.toState) {
    return `${base}（${CASE_STATE_LABELS[event.fromState]} → ${CASE_STATE_LABELS[event.toState]}）`;
  }
  return base;
}

/**
 * 租賃案件的業務類型名稱：自管或代管。其他三種案件沒有業務類型，回 null（ADR-0030 決議 3）。
 * 舊值 `master_lease` 指轉租案件，所以轉租案件不在這裡顯示成「包租」。
 */
export function leaseBusinessTypeLabel(caseKind: StatutoryCaseKind, businessType: BusinessType | null): string | null {
  if (caseKind !== 'lease' || businessType === null) return null;
  return BUSINESS_TYPE_LABELS[businessType];
}

/** 案件種類的畫面名稱，名稱取自狀態呈現表。租賃案件後面加業務類型，例如「租賃案件（自管）」。 */
export function caseKindLabel(caseKind: StatutoryCaseKind, businessType: BusinessType | null): string {
  const name = statusPresentation('caseKind', caseKind).label;
  const businessTypeLabel = leaseBusinessTypeLabel(caseKind, businessType);
  return businessTypeLabel ? `${name}（${businessTypeLabel}）` : name;
}
