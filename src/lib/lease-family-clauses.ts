// 住宅包租契約與住宅轉租契約條文的共用小函式（MIL-199）。
// 只有純函式與字串，沒有 fs，client 端的 wizard 也能引用。

import { blank, clauseNumeral, fmtMoney, type ContractClause } from './contract-clauses';
import { contractEquipmentAnnex } from './equipment';
import { LEASE_FEE_ITEM_LABELS, type ResolvedLeaseFamilyTerms } from './lease-family-terms';
import type { ContractType } from './labels';
import { LEASE_FEE_ITEMS } from './types';
import type { EquipmentAnnexSnapshot, LeaseFeeItem, LeaseManagerContact, LeasePartyContact } from './types';

/**
 * 範本的一條條文。`notice` 是它對應的公告點次，例如「應約定事項第三點」。
 * 條號與公告的點次一一對應：第 N 條就是公告的第 N 點，公告內的「第 X 點」引用在條文裡改寫成「第 X 條」。
 */
export interface NoticeClause extends ContractClause {
  notice: string;
}

/** 公告原文的一個點次：點次、標題，用在涵蓋測試與條文對照表。 */
export interface NoticePoint {
  point: number;
  title: string;
}

/**
 * 「其他約定事項」在範本裡是第幾條，建約畫面的欄位標籤用。
 * 包租合約收在第二十一條（公告「其他約定」），轉租合約收在第二十二條。租賃合約的條號隨選用條款變動，不在這裡。
 */
export const LEASE_FAMILY_EXTRA_CLAUSE_LABELS: Readonly<Partial<Record<ContractType, string>>> = {
  master_lease: '第二十一條',
  sublease: '第二十二條',
};

export interface ClauseSpec {
  title: string;
  body: string;
}

/** 依公告點次順序編號。`kind` 是公告段落的名稱，例如「應約定事項」。 */
export function numberClauses(specs: readonly ClauseSpec[], kind: string): NoticeClause[] {
  return specs.map((spec, index) => ({
    title: `第${clauseNumeral(index + 1)}條　${spec.title}`,
    body: spec.body,
    notice: `${kind}第${clauseNumeral(index + 1)}點`,
  }));
}

/** 段落之間用換行分開，PDF 寫入器依換行斷行。 */
export function paragraphs(...parts: string[]): string {
  return parts.join('\n');
}

/** 「（一）…」「（二）…」形式的款。 */
export function items(entries: readonly string[]): string {
  return entries.map((entry, index) => `（${clauseNumeral(index + 1)}）${entry}`).join('\n');
}

export function chooseText<T extends string>(value: T, labels: Readonly<Record<T, string>>): string {
  return labels[value];
}

/** 租賃附屬設備的條文：有設備列出名稱與數量，沒有寫「無」。 */
export function equipmentText(snapshot: EquipmentAnnexSnapshot): string {
  const rows = contractEquipmentAnnex(snapshot);
  if (rows.length === 0) return '無附屬設備。';
  return `有附屬設備，項目如下：${rows.map((row) => `${row.name}×${row.quantity}`).join('、')}。`;
}

/** 租賃標的標示：地址、物件名稱、型態與面積。 */
export function propertyMarkText(f: {
  propertyAddress: string;
  propertyName: string;
  propertyType: string;
  propertySize: number | null;
}): string {
  return `${blank(f.propertyAddress)}（${blank(f.propertyName)}），型態為${blank(f.propertyType)}${
    f.propertySize != null ? `，面積約 ${f.propertySize} 坪` : ''
  }`;
}

export function rentPaymentText(terms: ResolvedLeaseFamilyTerms): string {
  if (terms.rentPaymentMethod === 'cash') return '現金繳付。';
  if (terms.rentPaymentMethod === 'transfer') return `轉帳繳付，金融機構、戶名與帳號：${blank(terms.rentPaymentNote)}。`;
  return `其他：${blank(terms.rentPaymentNote)}。`;
}

/** 租賃期間相關費用的條文。`titles` 是甲方與乙方在這份合約的法定稱謂。 */
export function feeLines(
  terms: ResolvedLeaseFamilyTerms,
  titles: { partyA: string; partyB: string },
  options: { tenantBearsLimits: boolean },
): string[] {
  const payer = (item: LeaseFeeItem) => `由${terms.feePayers[item] === 'party_a' ? titles.partyA : titles.partyB}負擔`;
  const lines: string[] = [];
  for (const item of LEASE_FEE_ITEMS) {
    let line = `${LEASE_FEE_ITEM_LABELS[item]}：${payer(item)}。`;
    if (item === 'management') {
      line += `租賃住宅每月${terms.managementFeeMonthly != null ? fmtMoney(terms.managementFeeMonthly) : '＿＿＿＿'}，停車位每月${
        terms.parkingFeeMonthly != null ? fmtMoney(terms.parkingFeeMonthly) : '＿＿＿＿'
      }。`;
      if (options.tenantBearsLimits && terms.feePayers.management === 'party_b') {
        line += '租賃期間因不可歸責於雙方當事人之事由，致本費用增加者，承租人就增加部分之金額，以負擔百分之十為限；如本費用減少者，承租人負擔減少後之金額。';
      }
    }
    if (item === 'electricity' && options.tenantBearsLimits && terms.feePayers.electricity === 'party_b') {
      line +=
        terms.electricityBilling === 'per_kwh'
          ? '以用電度數計費者，每度電費不得超過該租賃標的電費單「當期每度平均電價」；如公共設施電費未向台灣電力股份有限公司申辦分攤併入租賃標的電費內者，包租業不得額外收取。'
          : '非以用電度數計費者，包租業所收取之每期電費總金額，不得超過該租賃標的電費單之每期電費總額。';
    }
    lines.push(line);
  }
  lines.push(`其他費用及其支付方式：${blank(terms.otherFeesNote)}。`);
  return lines;
}

/**
 * 一方當事人的基本資料一行。個人印姓名、戶籍地址、通訊地址與聯絡電話，公司印名稱、代表人、統一編號、登記證字號、營業地址與聯絡電話。
 * 另加電子郵件信箱，履行契約的通知得以它為之（公告「履行本契約之通知」）。
 */
export function partyContactLine(
  label: string,
  party: { name: string; email: string },
  contact: LeasePartyContact,
  company: boolean,
): string {
  const parts = company
    ? [
        `公司名稱：${blank(party.name)}`,
        `代表人姓名：${blank(contact.representative)}`,
        `統一編號：${blank(contact.taxId)}`,
        `登記證字號：${blank(contact.licenseNo)}`,
        `營業地址：${blank(contact.registeredAddress)}`,
        `聯絡電話：${blank(contact.phone)}`,
        `電子郵件信箱：${blank(party.email)}`,
      ]
    : [
        `姓名（名稱）：${blank(party.name)}`,
        `戶籍地址：${blank(contact.registeredAddress)}`,
        `通訊地址：${blank(contact.mailingAddress)}`,
        `聯絡電話：${blank(contact.phone)}`,
        `電子郵件信箱：${blank(party.email)}`,
      ];
  return `${label}${parts.join('，')}`;
}

export function managerContactLine(label: string, manager: LeaseManagerContact): string {
  return `${label}姓名：${blank(manager.name)}，證書字號：${blank(manager.certificateNo)}，通訊地址：${blank(
    manager.mailingAddress,
  )}，聯絡電話：${blank(manager.phone)}，電子郵件信箱：${blank(manager.email)}`;
}
