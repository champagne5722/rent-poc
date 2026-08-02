// 合約條款區的全文與條號（規格 §12、ADR-0005）。
//
// 條款文字寫死於範本（參考台灣住宅租賃定型化契約精神簡化），房東只編輯欄位；
// 逐約彈性＝可編輯欄位＋勾選的選用條款＋自由文字的「其他約定事項」。
// 這裡只有純函式與字串（不碰 fs / pdf-lib），所以 client 端的 wizard 也能引用：
// src/lib/pdf.ts 排 PDF 條款區、wizard 顯示條號與確認頁摘要，都吃這一份，避免兩邊條號各算各的。

import { clauseSnapshots } from './clause-library';
import type { ContractFields, TemplateBinding } from './types';

export interface ContractClause {
  /** 已含條號，例如「第八條　寵物飼養」。 */
  title: string;
  body: string;
}

/** 勾選的選用條款插在這幾條之後、「其他約定事項」之前。 */
const LEADING_CLAUSE_COUNT = 7;

const CN_DIGITS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;

/** 條號的中文數字；範本九條＋選用條款最多五條，十九以內夠用。 */
export function clauseNumeral(n: number): string {
  if (n < 10) return CN_DIGITS[n - 1];
  if (n === 10) return '十';
  return `十${CN_DIGITS[n - 11]}`;
}

function fmtMoney(n: number | null): string {
  return n == null ? '＿＿＿＿' : `新臺幣 ${n.toLocaleString('zh-TW')} 元整`;
}

function fmtDate(d: string): string {
  if (!d) return '＿＿年＿＿月＿＿日';
  const [y, m, day] = d.split('-');
  return `${y} 年 ${m} 月 ${day} 日`;
}

/** 空欄位在合約上留底線，不留空白 */
export function blank(s: string | null | undefined): string {
  return s && s.trim() ? s : '＿＿＿＿＿＿';
}

function leadingClauses(f: ContractFields): ContractClause[] {
  return [
    {
      title: '租賃標的',
      body: `甲方將其所有之房屋（下稱本房屋）出租予乙方使用。本房屋座落於：${blank(
        f.propertyAddress
      )}（${blank(f.propertyName)}），型態為${blank(f.propertyType)}${
        f.propertySize != null ? `，面積約 ${f.propertySize} 坪` : ''
      }。`,
    },
    {
      title: '租賃期間',
      body: `租賃期間自 ${fmtDate(f.startDate)} 起至 ${fmtDate(f.endDate)} 止。`,
    },
    {
      title: '租金約定',
      body: `每月租金為 ${fmtMoney(f.rent)}。乙方應於每月${
        f.payDay != null ? ` ${f.payDay} ` : '＿＿'
      }日前給付，不得藉任何理由拖延或拒絕。`,
    },
    {
      title: '押金',
      body: `押金為 ${fmtMoney(
        f.deposit
      )}。乙方應於簽訂本契約時一次支付予甲方。租期屆滿或租賃契約終止時，乙方返還房屋且無欠繳費用及損害賠償情事者，甲方應無息返還押金。`,
    },
    {
      title: '附屬設備',
      body:
        f.equipment.length > 0
          ? `本房屋現有附屬設備如下：${f.equipment.join('、')}。乙方應以善良管理人之注意義務使用，如因可歸責於乙方之事由致損壞，應負修繕或賠償責任。`
          : '本房屋無附屬設備。',
    },
    {
      title: '使用約定',
      body: '乙方應以善良管理人之注意義務保管使用本房屋，不得供非法使用或存放危險物品，未經甲方書面同意不得將本房屋全部或一部轉租、出借予他人使用。',
    },
    {
      title: '契約終止與返還',
      body: '租期屆滿時，本契約即行終止，乙方應即日將本房屋回復原狀返還甲方，不得藉詞推諉或主張任何權利。',
    },
  ];
}

function trailingClauses(f: ContractFields): ContractClause[] {
  return [
    {
      title: '其他約定事項',
      body: f.extra && f.extra.trim() ? f.extra.trim() : '無。',
    },
    {
      title: '契約份數與效力',
      body: '本契約以電子文件方式作成並經雙方電子簽署後生效，雙方各自留存電子檔，效力與書面契約相同。',
    },
  ];
}

/**
 * 合約條款區的完整條文（含條號）。
 * 選用條款一律用合約自己的快照，不回頭查平台條款庫；勾了幾條，後面的條號就往後推幾號。
 */
export function buildContractClauses(fields: ContractFields): ContractClause[] {
  const optional = clauseSnapshots(fields).map((clause) => ({ title: clause.title, body: clause.body }));
  return [...leadingClauses(fields), ...optional, ...trailingClauses(fields)].map((clause, index) => ({
    title: `第${clauseNumeral(index + 1)}條　${clause.title}`,
    body: clause.body,
  }));
}

/** 「其他約定事項」現在是第幾條（wizard 的欄位標籤要跟著勾選數量走）。 */
export function extraClauseLabel(binding: TemplateBinding): string {
  return `第${clauseNumeral(LEADING_CLAUSE_COUNT + clauseSnapshots(binding).length + 1)}條`;
}
