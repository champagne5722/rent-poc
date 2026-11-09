// 委託管理契約書的 PDF（MIL-74、P0-11）。版面與租賃契約書共用 pdf.ts 的寫入器與簽署欄，
// 頁序是：條文、簽署欄、委託標的清單附件（附件排在簽署欄之後，所以附件多長都不影響簽名框落點）。
// 條文在 management-clauses.ts，是純函式。

import { blank } from './contract-clauses';
import { BODY_SIZE, MANDATE_ANNEX_COLUMNS, MANDATE_ANNEX_COLUMN_WIDTHS, MANDATE_ANNEX_TITLE, ANNEX_TITLE_GAP_AFTER, ANNEX_TITLE_SIZE, MARGIN } from './pdf-layout';
import { TERMS, partyLabels } from './labels';
import { MANDATE_SCOPE_LIST_TEXT, mandateScopeText, type MandateItem } from './mandate-schedule';
import { buildManagementClauses } from './management-clauses';
import { Writer, createPdfWriter, drawSignatureBlock, practitionerBlockLines } from './pdf';
import type { PrintedPractitioner } from './practitioner-assignment/seats';
import { evaluateRouting, partyOnlySeats, printOrder, type SeatView } from './signature-routing';
import type { ManagementContractFields } from './types';

const LABELS = partyLabels('management');

/** 本契約書的簽署席位，印列順序（甲方、乙方、執業人員）。分流條件有問題時退回兩方席位。 */
function printedSeats(fields: ManagementContractFields): SeatView[] {
  const evaluation = evaluateRouting(fields.routing, 'management');
  return printOrder(evaluation.ok ? evaluation.seats : partyOnlySeats('management'));
}

/**
 * 受託人的名稱：已指派執業人員時印執業主體的名稱（合約當事人是公司），
 * 尚未指派時退回乙方欄位的姓名。
 */
function mandataryName(fields: ManagementContractFields, practitioners: Readonly<Record<string, PrintedPractitioner>>): string {
  const entityName = Object.values(practitioners)[0]?.entityName;
  return entityName ?? fields.mandataryName;
}

/** 委託標的清單附件頁：另起一頁，列數多到一頁放不下就續頁並重畫表頭。 */
function drawMandateAnnex(w: Writer, items: readonly MandateItem[]): void {
  const widths = MANDATE_ANNEX_COLUMN_WIDTHS;
  w.addPage();
  w.center(`附件　${MANDATE_ANNEX_TITLE}`, ANNEX_TITLE_SIZE, ANNEX_TITLE_GAP_AFTER);
  w.text(
    `本附件為本契約之一部分，列明${TERMS.partyA}委託${TERMS.partyB}管理之租賃單位及各租賃單位之委託範圍。委託範圍之項目包括${MANDATE_SCOPE_LIST_TEXT}。`,
    BODY_SIZE,
    { gapAfter: 8 },
  );
  w.tableRow(MANDATE_ANNEX_COLUMNS, { head: true, widths });
  for (const item of items) {
    const cells = [item.propertyName, item.propertyAddress, mandateScopeText(item.scopes)];
    if (w.y - w.rowHeight(cells, BODY_SIZE, widths) < MARGIN) {
      w.addPage();
      w.tableRow(MANDATE_ANNEX_COLUMNS, { head: true, widths });
    }
    w.tableRow(cells, { widths });
  }
}

/**
 * @param practitioners 已指派的執業人員，以席位 rule_id 為鍵。沒有的席位留底線。
 * @param mandateItems 委託標的清單。沒有列時不產附件頁。
 */
export async function generateManagementPdf(
  fields: ManagementContractFields,
  practitioners: Readonly<Record<string, PrintedPractitioner>>,
  mandateItems: readonly MandateItem[],
): Promise<Uint8Array> {
  const w = await createPdfWriter();

  w.center('委託管理契約書', 20, 10);
  w.text(
    `${LABELS.partyA}：${blank(fields.mandatorName)}（以下簡稱${TERMS.partyA}）\n${LABELS.partyB}：${blank(
      mandataryName(fields, practitioners),
    )}（以下簡稱${TERMS.partyB}）`,
    BODY_SIZE,
    { gapAfter: 6 },
  );
  w.text('茲因委託管理租賃住宅事宜，雙方合意訂立本契約，約款如下：', BODY_SIZE, { gapAfter: 10 });

  for (const clause of buildManagementClauses(fields)) {
    w.text(clause.title, 12, { gapAfter: 2 });
    w.text(clause.body, BODY_SIZE, { indent: 14, gapAfter: 8 });
  }

  // 簽署欄：另起一頁，落點與租賃合約的簽署欄共用 signatureBlockLayout
  drawSignatureBlock(w, printedSeats(fields), (seat) => {
    if (seat.role === 'party_a') return [`${seat.fullLabel}：${blank(fields.mandatorName)}`, `Email：${blank(fields.mandatorEmail)}`];
    if (seat.role === 'party_b') return [`${seat.fullLabel}：${blank(fields.mandataryName)}`, `Email：${blank(fields.mandataryEmail)}`];
    return practitionerBlockLines(seat, practitioners[seat.ruleId]);
  });

  if (mandateItems.length > 0) drawMandateAnnex(w, mandateItems);

  return w.doc.save();
}
