import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import fs from 'fs';
import path from 'path';
import type { ContractFields, EquipmentAnnexRow } from './types';
import { REPAIR_RESPONSIBILITY_LABELS } from './types';
// 條款全文與條號集中在 contract-clauses.ts：wizard 也要顯示同一組條號與勾選條款。
import { blank, buildContractClauses, usesEquipmentAnnex } from './contract-clauses';
import { contractEquipmentAnnex } from './equipment';
import { partyLabels } from './labels';
import { evaluateRouting, printOrder, type SeatView } from './signature-routing';
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
} from './pdf-layout';

let fontBytesCache: Buffer | null = null;
function loadFontBytes(): Buffer {
  if (!fontBytesCache) {
    // 用 TTF 而非 OTF：pdf-lib 對 CFF（OTF）做 subset 會缺字（踩坑記錄見整合筆記）
    fontBytesCache = fs.readFileSync(path.join(process.cwd(), 'assets/fonts/NotoSansTC-Regular.ttf'));
  }
  return fontBytesCache;
}

class Writer {
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

  /** 表格一列的高度：每格逐字斷行後取最高的一格。 */
  rowHeight(cells: readonly string[], size = BODY_SIZE): number {
    const maxLines = Math.max(
      ...cells.map((cell, i) => this.wrap(cell, size, ANNEX_COLUMN_WIDTHS[i] - ANNEX_CELL_PAD_X * 2).length)
    );
    return maxLines * (size + LINE_GAP) - LINE_GAP + ANNEX_CELL_PAD_Y * 2;
  }

  /** 畫一列表格（含格線），列高由內容決定；呼叫端負責換頁。 */
  tableRow(cells: readonly string[], opts: { head?: boolean; size?: number } = {}) {
    const size = opts.size ?? BODY_SIZE;
    const height = this.rowHeight(cells, size);
    const bottom = this.y - height;
    let x = MARGIN;
    cells.forEach((cell, i) => {
      const width = ANNEX_COLUMN_WIDTHS[i];
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

const LEASE_LABELS = partyLabels('lease');

/** 沒有可用簽署序列時（規則未定義、形狀不對）退回的兩方版面，與 N 列版面之前相同。 */
const PARTY_ONLY_SEATS: readonly SeatView[] = [
  { ruleId: 'party_a', role: 'party_a', label: '甲方', fullLabel: LEASE_LABELS.partyAFull },
  { ruleId: 'party_b', role: 'party_b', label: '乙方', fullLabel: LEASE_LABELS.partyBFull },
];

/** 依簽署序列取要印的席位，順序是印列順序（甲方、乙方、執業人員），與簽署順序無關。 */
function printedSeats(fields: ContractFields): SeatView[] {
  const evaluation = evaluateRouting(fields.routing);
  return printOrder(evaluation.ok ? evaluation.seats : PARTY_ONLY_SEATS);
}

/**
 * 一個簽署欄「簽章：」之前的兩行資料。
 * 當事人印稱謂、姓名與 Email。執業人員印姓名與法定稱謂、執業主體，不印證號（ADR-0018 決議 14）。
 * 執業人員尚未指派時姓名與執業主體留底線。指派執業人員屬 MIL-69，那時把姓名與執業主體傳進來。
 */
function signatureBlockLines(seat: SeatView, fields: ContractFields): [string, string] {
  if (seat.role === 'party_a') {
    return [`${seat.fullLabel}：${blank(fields.landlordName)}`, `Email：${blank(fields.landlordEmail)}`];
  }
  if (seat.role === 'party_b') {
    return [`${seat.fullLabel}：${blank(fields.tenantName)}`, `Email：${blank(fields.tenantEmail)}`];
  }
  const title = seat.practitionerTitle ? `（${seat.practitionerTitle}）` : '';
  return [`執業人員：${blank(null)}${title}`, `執業主體：${blank(null)}`];
}

export async function generateContractPdf(fields: ContractFields): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(loadFontBytes(), { subset: false });
  const w = new Writer(doc, font);

  w.center('房屋租賃契約書', 20, 10);
  w.text(
    `出租人：${blank(fields.landlordName)}（以下簡稱甲方）\n承租人：${blank(
      fields.tenantName
    )}（以下簡稱乙方）`,
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
  w.addPage();
  w.y -= SIGN_BLOCK_TOP_GAP;
  w.text('立契約書人', SIGN_HEADING_SIZE, { gapAfter: SIGN_HEADING_GAP_AFTER });
  for (const seat of printedSeats(fields)) {
    for (const line of signatureBlockLines(seat, fields)) {
      w.text(line, BODY_SIZE, { gapAfter: SIGN_ROW_GAP_AFTER });
    }
    w.text('簽章：', BODY_SIZE, { gapAfter: SIGN_STAMP_BLANK });
  }
  w.text(`中華民國　簽約日期以電子簽署完成日為準`, BODY_SIZE);

  // 設備附件頁排在簽署欄之後（內政部慣例：附件在本文與簽章之後），所以附件多長都不影響簽名框落點；
  // 沒有設備附件列就不產這一頁（主約條文同步寫「本房屋無附屬設備」）。
  // 範本 v1 的合約仍把設備列在本文，沒有附件頁。
  const annex = usesEquipmentAnnex(fields) ? contractEquipmentAnnex(fields) : [];
  if (annex.length > 0) drawEquipmentAnnex(w, annex);

  return doc.save();
}

export const PDF_PAGE_SIZE = { width: PAGE_W, height: PAGE_H };
