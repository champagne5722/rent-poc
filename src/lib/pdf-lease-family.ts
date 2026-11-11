// 住宅包租契約書與住宅轉租契約書的 PDF（MIL-199、ADR-0030 決議 6、7）。
// 版面與租賃契約書共用 pdf.ts 的寫入器與簽署欄，頁序是：條文、簽署欄、現況確認附件（只有轉租合約）。
// 附件排在簽署欄之後，所以附件多長都不影響簽名框落點。條文在 master-lease-clauses.ts 與 sublease-clauses.ts，是純函式。
// 文件上顯示法定稱謂，不印「甲方」「乙方」（ADR-0030 決議 7）。

import { blank } from './contract-clauses';
import { partyLabels } from './labels';
import { buildMasterLeaseClauses } from './master-lease-clauses';
import { BODY_SIZE, type PdfPageMap } from './pdf-layout';
import { drawStatusAnnex } from './pdf-status-annex';
import { createPdfWriter, drawSignatureBlock, practitionerBlockLines } from './pdf';
import type { PrintedPractitioner } from './practitioner-assignment/seats';
import { evaluateRouting, partyOnlySeats, printOrder, type SeatView } from './signature-routing';
import type { StatusAnnex } from './status-annex';
import { SIGNER_ROLE_LABELS } from './types';
import { buildSubleaseClauses } from './sublease-clauses';
import type { MasterLeaseContractFields, SubleaseContractFields } from './types';

type LeaseFamilyPdfType = 'master_lease' | 'sublease';

const TITLES: Record<LeaseFamilyPdfType, { title: string; matter: string }> = {
  master_lease: { title: '住宅包租契約書', matter: '住宅包租事宜' },
  sublease: { title: '住宅轉租契約書', matter: '住宅轉租事宜' },
};

/** 規則列沒有指定附件頁簽章席位時（不該發生）用的席位，只提供稱謂文字。 */
const UNSPECIFIED_PRACTITIONER_SEAT: SeatView = {
  ruleId: '',
  role: 'practitioner',
  label: SIGNER_ROLE_LABELS.practitioner,
  fullLabel: SIGNER_ROLE_LABELS.practitioner,
};

/** 另存於合約欄位以外的內容。現況確認附件存在轉租合約的欄位，由呼叫端決定要不要印（statusAnnexOf）。 */
export interface LeaseFamilyPdfAttachments {
  statusAnnex?: StatusAnnex | null;
}

type LeaseFamilyFields = MasterLeaseContractFields | SubleaseContractFields;

/** 簽署序列的席位，印列順序。分流條件有問題時退回兩方席位。 */
function printedSeats(type: LeaseFamilyPdfType, fields: LeaseFamilyFields): SeatView[] {
  const evaluation = evaluateRouting(fields.routing, type);
  return printOrder(evaluation.ok ? evaluation.seats : partyOnlySeats(type));
}

async function generate(
  type: LeaseFamilyPdfType,
  fields: LeaseFamilyFields,
  practitioners: Readonly<Record<string, PrintedPractitioner>>,
  attachments: LeaseFamilyPdfAttachments,
): Promise<{ pdf: Uint8Array; pages: PdfPageMap }> {
  const labels = partyLabels(type);
  const clauses = type === 'master_lease' ? buildMasterLeaseClauses(fields) : buildSubleaseClauses(fields as SubleaseContractFields);
  const w = await createPdfWriter();

  w.center(TITLES[type].title, 20, 10);
  w.text(
    `${labels.partyA}：${blank(fields.landlordName)}（以下簡稱${labels.partyA}）\n${labels.partyB}：${blank(
      fields.tenantName,
    )}（以下簡稱${labels.partyB}）`,
    BODY_SIZE,
    { gapAfter: 6 },
  );
  w.text(`茲因${TITLES[type].matter}，雙方合意訂立本契約，約款如下：`, BODY_SIZE, { gapAfter: 10 });

  for (const clause of clauses) {
    w.text(clause.title, 12, { gapAfter: 2 });
    w.text(clause.body, BODY_SIZE, { indent: 14, gapAfter: 8 });
  }

  // 簽署欄：另起一頁，落點與租賃合約的簽署欄共用 signatureBlockLayout
  const seats = printedSeats(type, fields);
  drawSignatureBlock(w, seats, (seat) => {
    if (seat.role === 'party_a') return [`${labels.partyA}：${blank(fields.landlordName)}`, `Email：${blank(fields.landlordEmail)}`];
    if (seat.role === 'party_b') return [`${labels.partyB}：${blank(fields.tenantName)}`, `Email：${blank(fields.tenantEmail)}`];
    return practitionerBlockLines(seat, practitioners[seat.ruleId]);
  });
  const signaturePage = w.doc.getPageCount() - 1;

  // 現況確認附件（附件一）只跟轉租合約。包租合約不加（ADR-0030 決議 6）
  let statusAnnexPage: number | null = null;
  if (type === 'sublease' && attachments.statusAnnex) {
    const signer = seats.find((seat) => seat.requiresStatusAnnex);
    drawStatusAnnex(
      w,
      attachments.statusAnnex,
      signer ? practitionerBlockLines(signer, practitioners[signer.ruleId]) : practitionerBlockLines(UNSPECIFIED_PRACTITIONER_SEAT, undefined),
    );
    statusAnnexPage = w.doc.getPageCount() - 1;
  }

  const pdf = await w.doc.save();
  return { pdf, pages: { pageCount: w.doc.getPageCount(), signaturePage, statusAnnexPage } };
}

export function generateMasterLeasePdfWithPages(
  fields: MasterLeaseContractFields,
  practitioners: Readonly<Record<string, PrintedPractitioner>> = {},
): Promise<{ pdf: Uint8Array; pages: PdfPageMap }> {
  return generate('master_lease', fields, practitioners, {});
}

export function generateSubleasePdfWithPages(
  fields: SubleaseContractFields,
  practitioners: Readonly<Record<string, PrintedPractitioner>> = {},
  attachments: LeaseFamilyPdfAttachments = {},
): Promise<{ pdf: Uint8Array; pages: PdfPageMap }> {
  return generate('sublease', fields, practitioners, attachments);
}
