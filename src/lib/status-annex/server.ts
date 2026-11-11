// 現況確認附件在伺服器端的接點（MIL-71）。引用 PDF 產出函式（fs、pdf-lib），所以只有伺服器能引用，
// 與 client 也能引用的 index.ts 分開放。

import { contractPdfRenderer } from '../contract-pdf';
import type { PdfPageMap } from '../pdf-layout';
import { checkStatusAnnexSignatureFields, type SendBlockReason } from '../send-preconditions';
import { routingFactsOf } from '../signature-routing';
import type { Contract } from '../types';
import { statusAnnexOf, statusAnnexRequired } from './index';

/**
 * 這份合約的 PDF 頁面地圖。簽署區域的 `page` 是 PDF 的頁碼，所以附件頁在哪一頁要由實際產出的 PDF 回報。
 * 不必附現況確認附件的合約回傳 undefined：沒有附件頁要檢查，也不必為此多產一次 PDF。
 * 頁數不受執業人員姓名影響，所以用空的指派產出。
 */
export async function statusAnnexPageMap(contract: Contract): Promise<PdfPageMap | undefined> {
  // 現況確認附件只有租賃合約（舊資料的轉租案件）與轉租合約有（ADR-0030 決議 6）
  const type = contract.contract_type;
  if ((type !== 'lease' && type !== 'sublease') || !statusAnnexRequired(contract.fields.routing, type)) return undefined;
  const renderer = contractPdfRenderer(type);
  if (!renderer) return undefined;
  const statusAnnex = statusAnnexOf(contract.status, type, contract.fields);
  return (await renderer.renderWithPages(contract.fields, {}, { statusAnnex })).pages;
}

/** 附件頁缺少簽署區域的送簽前原因。不必附附件的合約、分流條件有問題的合約回空陣列（那些原因另有檢查列出）。 */
export async function statusAnnexSendReasons(contract: Contract): Promise<SendBlockReason[]> {
  const pages = await statusAnnexPageMap(contract);
  if (!pages) return [];
  const routing = routingFactsOf(contract.contract_type, contract.fields.routing);
  if (!routing.ok) return [];
  return checkStatusAnnexSignatureFields(routing.facts, contract.signature_fields, pages);
}
