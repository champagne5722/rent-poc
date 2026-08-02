import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import fs from 'fs';
import path from 'path';
import type { ContractFields } from './types';
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

function fmtMoney(n: number | null): string {
  return n == null ? '＿＿＿＿' : `新臺幣 ${n.toLocaleString('zh-TW')} 元整`;
}

function fmtDate(d: string): string {
  if (!d) return '＿＿年＿＿月＿＿日';
  const [y, m, day] = d.split('-');
  return `${y} 年 ${m} 月 ${day} 日`;
}

function blank(s: string | null | undefined): string {
  return s && s.trim() ? s : '＿＿＿＿＿＿';
}

// 條款文字寫死於此範本（參考台灣住宅租賃定型化契約精神簡化）；
// 自由編輯條款明確不在 PoC 範圍，見 docs/adr/0004。
function buildClauses(f: ContractFields): { title: string; body: string }[] {
  return [
    {
      title: '第一條　租賃標的',
      body: `甲方將其所有之房屋（下稱本房屋）出租予乙方使用。本房屋座落於：${blank(
        f.propertyAddress
      )}（${blank(f.propertyName)}），型態為${blank(f.propertyType)}${
        f.propertySize != null ? `，面積約 ${f.propertySize} 坪` : ''
      }。`,
    },
    {
      title: '第二條　租賃期間',
      body: `租賃期間自 ${fmtDate(f.startDate)} 起至 ${fmtDate(f.endDate)} 止。`,
    },
    {
      title: '第三條　租金約定',
      body: `每月租金為 ${fmtMoney(f.rent)}。乙方應於每月${
        f.payDay != null ? ` ${f.payDay} ` : '＿＿'
      }日前給付，不得藉任何理由拖延或拒絕。`,
    },
    {
      title: '第四條　押金',
      body: `押金為 ${fmtMoney(
        f.deposit
      )}。乙方應於簽訂本契約時一次支付予甲方。租期屆滿或租賃契約終止時，乙方返還房屋且無欠繳費用及損害賠償情事者，甲方應無息返還押金。`,
    },
    {
      title: '第五條　附屬設備',
      body:
        f.equipment.length > 0
          ? `本房屋現有附屬設備如下：${f.equipment.join('、')}。乙方應以善良管理人之注意義務使用，如因可歸責於乙方之事由致損壞，應負修繕或賠償責任。`
          : '本房屋無附屬設備。',
    },
    {
      title: '第六條　使用約定',
      body: '乙方應以善良管理人之注意義務保管使用本房屋，不得供非法使用或存放危險物品，未經甲方書面同意不得將本房屋全部或一部轉租、出借予他人使用。',
    },
    {
      title: '第七條　契約終止與返還',
      body: '租期屆滿時，本契約即行終止，乙方應即日將本房屋回復原狀返還甲方，不得藉詞推諉或主張任何權利。',
    },
    {
      title: '第八條　其他約定事項',
      body: f.extra && f.extra.trim() ? f.extra.trim() : '無。',
    },
    {
      title: '第九條　契約份數與效力',
      body: '本契約以電子文件方式作成並經雙方電子簽署後生效，雙方各自留存電子檔，效力與書面契約相同。',
    },
  ];
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

  for (const clause of buildClauses(fields)) {
    w.text(clause.title, 12, { gapAfter: 2 });
    w.text(clause.body, BODY_SIZE, { indent: 14, gapAfter: 8 });
  }

  // 簽署欄：僅印出雙方基本資料與簽章提示文字；
  // 實際簽名位置由房東在簽署區域編輯器拖放決定（見 docs/adr/0004）。
  // 這段的排版順序被 pdf-layout.ts 的 signatureStampBaselines() 重走一遍以推出預設落點，改這裡要一起改。
  w.ensure(180);
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
