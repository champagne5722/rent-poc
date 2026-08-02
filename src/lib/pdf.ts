import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import fs from 'fs';
import path from 'path';
import type { ContractFields } from './types';
// 條款全文與條號集中在 contract-clauses.ts：wizard 也要顯示同一組條號與勾選條款。
import { blank, buildContractClauses } from './contract-clauses';
// 版面常數集中在 pdf-layout.ts：簽署區編輯器要用同一組數字推簽名欄的預設落點。
import {
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

  // 簽署欄：僅印出雙方基本資料與簽章提示文字；
  // 實際簽名位置由房東在簽署區域編輯器拖放決定（見 docs/adr/0004）。
  // 這段的排版順序被 pdf-layout.ts 的 signatureStampBaselines() 重走一遍以推出預設落點，改這裡要一起改。
  // 一律另起一頁：選用條款勾幾條會改變條款區長度，簽署欄若跟著浮動，預設落點就對不上了。
  w.addPage();
  w.y -= SIGN_BLOCK_TOP_GAP;
  w.text('立契約書人', SIGN_HEADING_SIZE, { gapAfter: SIGN_HEADING_GAP_AFTER });
  w.text(`甲方（出租人）：${blank(fields.landlordName)}`, BODY_SIZE, { gapAfter: SIGN_ROW_GAP_AFTER });
  w.text(`Email：${blank(fields.landlordEmail)}`, BODY_SIZE, { gapAfter: SIGN_ROW_GAP_AFTER });
  w.text('簽章：', BODY_SIZE, { gapAfter: SIGN_STAMP_BLANK });
  w.text(`乙方（承租人）：${blank(fields.tenantName)}`, BODY_SIZE, { gapAfter: SIGN_ROW_GAP_AFTER });
  w.text(`Email：${blank(fields.tenantEmail)}`, BODY_SIZE, { gapAfter: SIGN_ROW_GAP_AFTER });
  w.text('簽章：', BODY_SIZE, { gapAfter: SIGN_STAMP_BLANK });
  w.text(`中華民國　簽約日期以電子簽署完成日為準`, BODY_SIZE);

  return doc.save();
}

export const PDF_PAGE_SIZE = { width: PAGE_W, height: PAGE_H };
