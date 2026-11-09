import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import fs from 'fs';
import path from 'path';
import type { EquipmentAnnexRow, LeaseContractFields } from './types';
import { REPAIR_RESPONSIBILITY_LABELS, SIGNER_ROLE_LABELS } from './types';
import { TERMS, partyLabels } from './labels';

// 條款全文與條號集中在 contract-clauses.ts：wizard 也要顯示同一組條號與勾選條款。
import { blank, buildContractClauses, usesEquipmentAnnex } from './contract-clauses';
import { contractEquipmentAnnex } from './equipment';
import type { PrintedPractitioner } from './practitioner-assignment/seats';
import { PARTY_ONLY_SEATS, evaluateRouting, printOrder, type SeatView } from './signature-routing';
import { drawStatusAnnex } from './pdf-status-annex';
import type { StatusAnnex } from './status-annex';
// 版面常數集中在 pdf-layout.ts：簽署區編輯器要用同一組數字推簽名欄的預設落點。
import {
  ANNEX_CELL_PAD_X,
  ANNEX_CELL_PAD_Y,
  ANNEX_COLUMNS,
  ANNEX_COLUMN_WIDTHS,
  ANNEX_TITLE,
  ANNEX_TITLE_GAP_AFTER,
  ANNEX_TITLE_SIZE,
  BODY_SIZE,
  LINE_GAP,
  MARGIN,
  PAGE_H,
  PAGE_W,
  SIGN_BLOCK_TOP_GAP,
  SIGN_HEADING_GAP_AFTER,
  SIGN_HEADING_SIZE,
  SIGN_ROW_GAP_AFTER,
  SIGN_STAMP_BLANK,
  SIGNATURE_BLOCK_HEADING,
  type PdfPageMap,
} from './pdf-layout';

// 兩方租賃合約的稱謂從標籤對照表取（MIL-122）。
const LEASE = partyLabels('lease');

let fontBytesCache: Buffer | null = null;
export function loadFontBytes(): Buffer {
  if (!fontBytesCache) {
    // 用 TTF 而非 OTF：pdf-lib 對 CFF（OTF）做 subset 會缺字（踩坑記錄見整合筆記）
    fontBytesCache = fs.readFileSync(path.join(process.cwd(), 'assets/fonts/NotoSansTC-Regular.ttf'));
  }
  return fontBytesCache;
}

export class Writer {
  doc: PDFDocument;
  font: PDFFont;
  page!: PDFPage;
  y = 0;

  constructor(doc: PDFDocument, font: PDFFont) {
    this.doc = doc;
    this.font = font;
    this.addPage();
  }

  addPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }

  ensure(height: number) {
    if (this.y - height < MARGIN) this.addPage();
  }

  // 以逐字量測斷行（中文為主的內文，逐字換行即可）
  wrap(text: string, size: number, maxWidth: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const ch of text) {
      if (ch === '\n') {
        lines.push(line);
        line = '';
        continue;
      }
      const test = line + ch;
      if (this.font.widthOfTextAtSize(test, size) > maxWidth && line !== '') {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    lines.push(line);
    return lines;
  }

  text(text: string, size = BODY_SIZE, opts: { indent?: number; gapAfter?: number } = {}) {
    const indent = opts.indent ?? 0;
    const maxWidth = PAGE_W - MARGIN * 2 - indent;
    for (const line of this.wrap(text, size, maxWidth)) {
      this.ensure(size + LINE_GAP);
      this.page.drawText(line, {
        x: MARGIN + indent,
        y: this.y - size,
        size,
        font: this.font,
        color: rgb(0.1, 0.1, 0.1),
      });
      this.y -= size + LINE_GAP;
    }
    this.y -= opts.gapAfter ?? 0;
  }

  /** 表格一列的高度：每格逐字斷行後取最高的一格。欄寬預設是設備附件的四欄。 */
  rowHeight(cells: readonly string[], size = BODY_SIZE, widths: readonly number[] = ANNEX_COLUMN_WIDTHS): number {
    const maxLines = Math.max(
      ...cells.map((cell, i) => this.wrap(cell, size, widths[i] - ANNEX_CELL_PAD_X * 2).length)
    );
    return maxLines * (size + LINE_GAP) - LINE_GAP + ANNEX_CELL_PAD_Y * 2;
  }

  /** 畫一列表格（含格線），列高由內容決定；呼叫端負責換頁。 */
  tableRow(cells: readonly string[], opts: { head?: boolean; size?: number; widths?: readonly number[] } = {}) {
    const size = opts.size ?? BODY_SIZE;
    const widths = opts.widths ?? ANNEX_COLUMN_WIDTHS;
    const height = this.rowHeight(cells, size, widths);
    const bottom = this.y - height;
    let x = MARGIN;
    cells.forEach((cell, i) => {
      const width = widths[i];
      this.page.drawRectangle({
        x,
        y: bottom,
        width,
        height,
        borderWidth: 0.5,
        borderColor: rgb(0.6, 0.6, 0.6),
        color: opts.head ? rgb(0.94, 0.94, 0.94) : undefined,
      });
      let textY = this.y - ANNEX_CELL_PAD_Y - size;
      for (const line of this.wrap(cell, size, width - ANNEX_CELL_PAD_X * 2)) {
        this.page.drawText(line, {
          x: x + ANNEX_CELL_PAD_X,
          y: textY,
          size,
          font: this.font,
          color: rgb(0.1, 0.1, 0.1),
        });
        textY -= size + LINE_GAP;
      }
      x += width;
    });
    this.y = bottom;
  }

  center(text: string, size: number, gapAfter = 0) {
    this.ensure(size + LINE_GAP);
    const w = this.font.widthOfTextAtSize(text, size);
    this.page.drawText(text, {
      x: (PAGE_W - w) / 2,
      y: this.y - size,
      size,
      font: this.font,
      color: rgb(0.1, 0.1, 0.1),
    });
    this.y -= size + LINE_GAP + gapAfter;
  }
}

/** 建一份空白 PDF 與寫入器（內嵌 Noto Sans TC）。寫入器建好時已有第一頁。 */
export async function createPdfWriter(): Promise<Writer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(loadFontBytes(), { subset: false });
  return new Writer(doc, font);
}

/**
 * 設備附件頁（ADR-0008）：另起一頁，表格欄位＝項目／數量／修繕責任／備註。
 * 列數多到一頁放不下就續頁並重畫表頭。
 */
function drawEquipmentAnnex(w: Writer, rows: EquipmentAnnexRow[]): void {
  w.addPage();
  w.center(`附件　${ANNEX_TITLE}`, ANNEX_TITLE_SIZE, ANNEX_TITLE_GAP_AFTER);
  w.text('本附件為本契約之一部分，所列設備由甲方於交屋時點交予乙方使用。', BODY_SIZE, { gapAfter: 8 });
  w.tableRow(ANNEX_COLUMNS, { head: true });
  for (const row of rows) {
    const cells = [row.name, String(row.quantity), REPAIR_RESPONSIBILITY_LABELS[row.repair], row.note || '—'];
    if (w.y - w.rowHeight(cells) < MARGIN) {
      w.addPage();
      w.tableRow(ANNEX_COLUMNS, { head: true });
    }
    w.tableRow(cells);
  }
}

/** 規則列沒有指定附件頁簽章席位時（不該發生）用的席位，只提供稱謂文字。 */
const UNSPECIFIED_PRACTITIONER_SEAT: SeatView = {
  ruleId: '',
  role: 'practitioner',
  label: SIGNER_ROLE_LABELS.practitioner,
  fullLabel: SIGNER_ROLE_LABELS.practitioner,
};

/** 依簽署序列取要印的席位，順序是印列順序（甲方、乙方、執業人員），與簽署順序無關。 */
function printedSeats(fields: LeaseContractFields): SeatView[] {
  const evaluation = evaluateRouting(fields.routing);
  return printOrder(evaluation.ok ? evaluation.seats : PARTY_ONLY_SEATS);
}

/**
 * 執業人員簽署欄「簽章：」之前的兩行資料：姓名與法定稱謂、執業主體，不印證號（ADR-0018 決議 14）。
 * 尚未指派時姓名與執業主體留底線。已指派時印登錄的姓名、法定稱謂與執業主體（MIL-69）。
 */
export function practitionerBlockLines(seat: SeatView, practitioner: PrintedPractitioner | undefined): [string, string] {
  const titleText = practitioner?.title ?? seat.practitionerTitle;
  const title = titleText ? `（${titleText}）` : '';
  return [
    `${SIGNER_ROLE_LABELS.practitioner}：${blank(practitioner?.name)}${title}`,
    `執業主體：${blank(practitioner?.entityName)}`,
  ];
}

/**
 * 畫簽署欄（「立契約書人」以下）：另起一頁，依印列順序每個席位三行（兩行資料、一行簽章）。
 * 排版順序被 pdf-layout.ts 的 signatureBlockLayout() 重走一遍以推出預設落點，改這裡要一起改。
 * 租賃合約與委託管理合約共用，差別只在當事人兩行的內容（`linesOf` 回傳）。
 */
export function drawSignatureBlock(w: Writer, seats: readonly SeatView[], linesOf: (seat: SeatView) => [string, string]): void {
  w.addPage();
  w.y -= SIGN_BLOCK_TOP_GAP;
  w.text(SIGNATURE_BLOCK_HEADING, SIGN_HEADING_SIZE, { gapAfter: SIGN_HEADING_GAP_AFTER });
  for (const seat of seats) {
    for (const line of linesOf(seat)) {
      w.text(line, BODY_SIZE, { gapAfter: SIGN_ROW_GAP_AFTER });
    }
    w.text('簽章：', BODY_SIZE, { gapAfter: SIGN_STAMP_BLANK });
  }
  w.text(`中華民國　簽約日期以電子簽署完成日為準`, BODY_SIZE);
}

/**
 * 一個簽署欄「簽章：」之前的兩行資料。
 * 當事人印稱謂、姓名與 Email。執業人員印姓名與法定稱謂、執業主體，不印證號（ADR-0018 決議 14）。
 * 執業人員尚未指派時姓名與執業主體留底線。已指派時印登錄的姓名、法定稱謂與執業主體（MIL-69）。
 */
function signatureBlockLines(
  seat: SeatView,
  fields: LeaseContractFields,
  practitioner: PrintedPractitioner | undefined
): [string, string] {
  if (seat.role === 'party_a') {
    return [`${seat.fullLabel}：${blank(fields.landlordName)}`, `Email：${blank(fields.landlordEmail)}`];
  }
  if (seat.role === 'party_b') {
    return [`${seat.fullLabel}：${blank(fields.tenantName)}`, `Email：${blank(fields.tenantEmail)}`];
  }
  return practitionerBlockLines(seat, practitioner);
}

/** 另存於合約欄位以外的內容。現況確認附件存在合約欄位，由呼叫端決定要不要印（statusAnnexOf）。 */
export interface LeasePdfAttachments {
  /** 要印的現況確認附件。null 或沒有帶代表不印附件頁。 */
  statusAnnex?: StatusAnnex | null;
}

/**
 * 產出租賃契約書，同時回報頁面地圖（簽名頁與現況確認附件頁的頁碼）。
 * 頁序：本文、簽署欄、設備附件、現況確認附件。附件都排在簽署欄之後，所以不影響簽署欄落點。
 *
 * @param practitioners 已指派的執業人員，以席位 rule_id 為鍵。沒有的席位留底線。兩方合約不需要。
 */
export async function generateContractPdfWithPages(
  fields: LeaseContractFields,
  practitioners: Readonly<Record<string, PrintedPractitioner>> = {},
  attachments: LeasePdfAttachments = {}
): Promise<{ pdf: Uint8Array; pages: PdfPageMap }> {
  const w = await createPdfWriter();

  w.center('房屋租賃契約書', 20, 10);
  w.text(
    `${LEASE.partyA}：${blank(fields.landlordName)}（以下簡稱${TERMS.partyA}）\n${LEASE.partyB}：${blank(
      fields.tenantName
    )}（以下簡稱${TERMS.partyB}）`,
    BODY_SIZE,
    { gapAfter: 6 }
  );
  w.text('茲因房屋租賃事宜，雙方合意訂立本契約，約款如下：', BODY_SIZE, { gapAfter: 10 });

  // 條款區：範本條款＋建約時勾選的選用條款快照，條號連號（見 contract-clauses.ts）
  for (const clause of buildContractClauses(fields)) {
    w.text(clause.title, 12, { gapAfter: 2 });
    w.text(clause.body, BODY_SIZE, { indent: 14, gapAfter: 8 });
  }

  // 簽署欄：依簽署序列的席位印 N 列（ADR-0018 決議 14），只印身分資料與簽章提示文字；
  // 實際簽名位置由房東在簽署區域編輯器拖放決定（見 docs/adr/0004）。
  // 這段的排版順序被 pdf-layout.ts 的 signatureBlockLayout() 重走一遍以推出預設落點，改這裡要一起改。
  // 一律另起一頁：選用條款勾幾條會改變條款區長度，簽署欄若跟著浮動，預設落點就對不上了。
  const seats = printedSeats(fields);
  drawSignatureBlock(w, seats, (seat) => signatureBlockLines(seat, fields, practitioners[seat.ruleId]));
  const signaturePage = w.doc.getPageCount() - 1;

  // 設備附件頁排在簽署欄之後（內政部慣例：附件在本文與簽章之後），所以附件多長都不影響簽名框落點；
  // 沒有設備附件列就不產這一頁（主約條文同步寫「本房屋無附屬設備」）。
  // 範本 v1 的合約仍把設備列在本文，沒有附件頁。
  const annex = usesEquipmentAnnex(fields) ? contractEquipmentAnnex(fields) : [];
  if (annex.length > 0) drawEquipmentAnnex(w, annex);

  // 現況確認附件（MIL-71）排在設備附件之後，獨立一頁。頁底的簽署欄是規則列要求在附件頁簽章的席位。
  let statusAnnexPage: number | null = null;
  if (attachments.statusAnnex) {
    const signer = seats.find((seat) => seat.requiresStatusAnnex);
    drawStatusAnnex(
      w,
      attachments.statusAnnex,
      signer ? practitionerBlockLines(signer, practitioners[signer.ruleId]) : practitionerBlockLines(UNSPECIFIED_PRACTITIONER_SEAT, undefined)
    );
    statusAnnexPage = w.doc.getPageCount() - 1;
  }

  const pdf = await w.doc.save();
  return { pdf, pages: { pageCount: w.doc.getPageCount(), signaturePage, statusAnnexPage } };
}

/** 不含頁面地圖的簡寫，租賃契約書的既有呼叫端用。 */
export async function generateContractPdf(
  fields: LeaseContractFields,
  practitioners: Readonly<Record<string, PrintedPractitioner>> = {},
  attachments: LeasePdfAttachments = {}
): Promise<Uint8Array> {
  return (await generateContractPdfWithPages(fields, practitioners, attachments)).pdf;
}

export const PDF_PAGE_SIZE = { width: PAGE_W, height: PAGE_H };
