// 委託管理契約書的條文（MIL-74、P0-11）。
//
// 範本 v1 是簡化示意條文，沒有選用條款，法務審閱旗標為未審閱（MIL-48）。
// 條文的假設都待法務確認（MIL-62）：八條的內容、提前終止的通知期間（三十日）、報酬約定的兩種形式。
// 只有純函式與字串（不碰 fs / pdf-lib），所以 client 端的 wizard 也能引用，PDF 與確認頁吃同一份。
// 委託標的與委託範圍的明細在附件（委託標的清單），條文只引用，不列舉。

import { TERMS, partyLabels } from './labels';
import { MANDATE_SCOPE_LIST_TEXT } from './mandate-schedule';
import { clauseNumeral, fmtDate, fmtMoney, type ContractClause } from './contract-clauses';
import type { ManagementContractFields } from './types';

const LABELS = partyLabels('management');
const BLANK = '＿＿＿＿';

/** 委託期間的文字，例如「自 2027 年 01 月 01 日起至 2027 年 12 月 31 日止」。沒填的日期留底線。 */
export function termText(fields: Pick<ManagementContractFields, 'termStart' | 'termEnd'>): string {
  return `自 ${fmtDate(fields.termStart)}起至 ${fmtDate(fields.termEnd)}止`;
}

/** 報酬約定的文字。形式或數值沒填時留底線，不猜預設值。 */
export function feeText(fields: Pick<ManagementContractFields, 'feeMode' | 'feeValue'>): string {
  if (fields.feeMode == null || fields.feeValue == null) return BLANK;
  return fields.feeMode === 'monthly_fixed'
    ? `每月固定${fmtMoney(fields.feeValue)}`
    : `各委託標的每月租金之百分之 ${fields.feeValue}`;
}

/** 條文：標題已含條號。欄位進、條文出。 */
export function buildManagementClauses(fields: ManagementContractFields): ContractClause[] {
  const body: Array<[string, string]> = [
    [
      '委託標的',
      `${LABELS.partyAFull}委託${LABELS.partyBFull}管理附件「委託標的清單」所列之租賃單位（以下簡稱委託標的），${TERMS.partyB}同意受託。`,
    ],
    [
      '委託範圍',
      `${TERMS.partyB}之受託事項，以附件「委託標的清單」就各委託標的所勾選之委託範圍為限，委託範圍之項目包括${MANDATE_SCOPE_LIST_TEXT}。未列於委託範圍之事項，${TERMS.partyB}非經${TERMS.partyA}書面同意，不得為之。`,
    ],
    ['委託期間', `本契約之委託期間${termText(fields)}。`],
    [
      '報酬',
      `${TERMS.partyA}應給付${TERMS.partyB}之報酬，約定為${feeText(fields)}。報酬之給付日期及方式，由雙方另行約定。`,
    ],
    [
      '受託人之義務',
      `${TERMS.partyB}應以善良管理人之注意，處理受託事務，並遵守租賃住宅市場發展及管理條例及相關法令之規定。`,
    ],
    [
      '專任管理人員',
      `${TERMS.partyB}應指派專任管理人員，就本契約依法令應由專任管理人員簽章之事項辦理簽章。`,
    ],
    ['處理報告', `${TERMS.partyB}應依${TERMS.partyA}之請求，報告受託事務之處理情形。`],
    [
      '契約終止',
      `委託期間屆滿，本契約即行終止。委託期間內，任一方欲提前終止本契約者，應於三十日前以書面通知他方。`,
    ],
  ];
  return body.map(([title, text], index) => ({
    title: `第${clauseNumeral(index + 1)}條　${title}`,
    body: text,
  }));
}
