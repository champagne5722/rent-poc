// 住宅包租契約與住宅轉租契約的選項型約定（MIL-199）：預設值與條文用的小函式。
//
// 公告的應約定事項與應記載事項有許多「□…□…」選項，逐約的選擇存在 `fields.terms`（LeaseFamilyTerms）。
// 沒填的選項用這裡的預設值。預設值都是第一版的假設，待法務確認（MIL-62），改預設值時同步改測試。
// 只有純函式與常數，沒有 fs，client 端的 wizard 也能引用。

import { blank } from './contract-clauses';
import { LEASE_FEE_ITEMS } from './types';
import type {
  LeaseFamilyTerms,
  LeaseFeeItem,
  LeaseManagerContact,
  LeasePartyContact,
} from './types';

/** 費用項目的條文名稱，順序照公告。 */
export const LEASE_FEE_ITEM_LABELS: Readonly<Record<LeaseFeeItem, string>> = {
  management: '管理費',
  water: '水費',
  electricity: '電費',
  gas: '瓦斯費',
  internet: '網路費',
};

/** 所有選項都有值的形狀。 */
export interface ResolvedLeaseFamilyTerms {
  scope: 'whole' | 'part';
  scopeNote: string;
  titleNote: string;
  rentPaymentMethod: 'cash' | 'transfer' | 'other';
  rentPaymentNote: string;
  feePayers: Readonly<Record<LeaseFeeItem, 'party_a' | 'party_b'>>;
  managementFeeMonthly: number | null;
  parkingFeeMonthly: number | null;
  otherFeesNote: string;
  electricityBilling: 'per_kwh' | 'per_period';
  otherUse: 'allowed' | 'not_allowed';
  renovation: 'allowed' | 'not_allowed';
  renovationCostPayer: 'party_a' | 'party_b';
  restoreOnReturn: 'restore' | 'as_is';
  earlyTermination: 'allowed' | 'not_allowed';
  notarization: 'agreed' | 'not_agreed';
  repairScopeNote: string;
  partyA: LeasePartyContact;
  partyB: LeasePartyContact;
  manager: LeaseManagerContact;
}

/**
 * 預設值（待法務確認）：
 * - 管理費由甲方負擔，水電瓦斯網路由乙方負擔。
 * - 租金轉帳繳付，電費依度數計費。
 * - 不同意其他方式供他人居住、不同意室內裝修、裝修費用由乙方負擔、返還時回復原狀。
 * - 租期屆滿前雙方不得終止租約（公告第十三點與第十四點以外的法定終止事由仍適用）。
 * - 不辦理公證。
 */
export const DEFAULT_LEASE_FAMILY_TERMS = {
  scope: 'whole',
  rentPaymentMethod: 'transfer',
  feePayers: { management: 'party_a', water: 'party_b', electricity: 'party_b', gas: 'party_b', internet: 'party_b' },
  electricityBilling: 'per_kwh',
  otherUse: 'not_allowed',
  renovation: 'not_allowed',
  renovationCostPayer: 'party_b',
  restoreOnReturn: 'restore',
  earlyTermination: 'not_allowed',
  notarization: 'not_agreed',
} as const;

export function resolveLeaseFamilyTerms(terms: LeaseFamilyTerms | undefined): ResolvedLeaseFamilyTerms {
  const t = terms ?? {};
  const feePayers = { ...DEFAULT_LEASE_FAMILY_TERMS.feePayers, ...t.feePayers } as Record<LeaseFeeItem, 'party_a' | 'party_b'>;
  return {
    scope: t.scope ?? DEFAULT_LEASE_FAMILY_TERMS.scope,
    scopeNote: t.scopeNote ?? '',
    titleNote: t.titleNote ?? '',
    rentPaymentMethod: t.rentPaymentMethod ?? DEFAULT_LEASE_FAMILY_TERMS.rentPaymentMethod,
    rentPaymentNote: t.rentPaymentNote ?? '',
    feePayers,
    managementFeeMonthly: t.managementFeeMonthly ?? null,
    parkingFeeMonthly: t.parkingFeeMonthly ?? null,
    otherFeesNote: t.otherFeesNote ?? '',
    electricityBilling: t.electricityBilling ?? DEFAULT_LEASE_FAMILY_TERMS.electricityBilling,
    otherUse: t.otherUse ?? DEFAULT_LEASE_FAMILY_TERMS.otherUse,
    renovation: t.renovation ?? DEFAULT_LEASE_FAMILY_TERMS.renovation,
    renovationCostPayer: t.renovationCostPayer ?? DEFAULT_LEASE_FAMILY_TERMS.renovationCostPayer,
    restoreOnReturn: t.restoreOnReturn ?? DEFAULT_LEASE_FAMILY_TERMS.restoreOnReturn,
    earlyTermination: t.earlyTermination ?? DEFAULT_LEASE_FAMILY_TERMS.earlyTermination,
    notarization: t.notarization ?? DEFAULT_LEASE_FAMILY_TERMS.notarization,
    repairScopeNote: t.repairScopeNote ?? '',
    partyA: t.partyA ?? {},
    partyB: t.partyB ?? {},
    manager: t.manager ?? {},
  };
}

/** 租賃期間的天數（含起訖日）。日期沒填或不合法回 null。 */
export function leaseTermDays(startDate: string, endDate: string): number | null {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round((end - start) / 86_400_000) + 1;
}

/** 公告：租賃期間不得少於三十日。 */
export const MIN_LEASE_TERM_DAYS = 30;

/** 公告：押金最高不得超過二個月租金之總額。押金或租金沒填時回 true（由必填檢核處理）。 */
export function depositWithinLimit(rent: number | null, deposit: number | null): boolean {
  if (rent == null || deposit == null) return true;
  return deposit <= rent * 2;
}

/** 押金相當於幾個月租金的文字。租金不是正數或押金沒填時留底線。 */
export function depositMonthsText(rent: number | null, deposit: number | null): string {
  if (rent == null || rent <= 0 || deposit == null) return '＿＿';
  const months = deposit / rent;
  return Number.isInteger(months) ? String(months) : months.toFixed(1);
}

/** 當事人資料的一個欄位：有填印值，沒填留底線。 */
export function contactField(label: string, value: string | undefined): string {
  return `${label}：${blank(value)}`;
}

export { LEASE_FEE_ITEMS };
