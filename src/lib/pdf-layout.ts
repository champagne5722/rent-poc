// 合約範本的版面常數與簽署欄位置推導。
// 這裡只有純數字與純函式（不碰 fs / pdf-lib），所以 client 端的簽署區編輯器也能引用；
// 實際畫 PDF 的 src/lib/pdf.ts 一律吃這裡的常數，避免同一組版面數字在兩邊各寫一份。

/** A4（PDF points），原點左下、y 向上。 */
export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const MARGIN = 56;
export const BODY_SIZE = 11;
export const LINE_GAP = 7;

/** 簽署欄（「立契約書人」以下）的排版參數，對應 generateContractPdf 尾段。 */
export const SIGN_BLOCK_TOP_GAP = 12;
export const SIGN_HEADING_SIZE = 13;
export const SIGN_HEADING_GAP_AFTER = 6;
export const SIGN_ROW_GAP_AFTER = 2;
/** 「簽章：」之後預留給簽名的空白高度，也就是簽名框的預設高度。 */
export const SIGN_STAMP_BLANK = 44;

/** 一行文字往下推進的距離（字級＋行距＋段後空白）。 */
function lineAdvance(size: number, gapAfter = 0): number {
  return size + LINE_GAP + gapAfter;
}

/**
 * 甲乙兩個「簽章：」的 baseline y（PDF 座標）。
 *
 * 這段是把 generateContractPdf 尾段的排版順序原樣重走一遍：簽署欄一律另起一頁，所以起點
 * 固定是 `PAGE_H - MARGIN`，勾幾條選用條款、其他約定事項寫多長都不影響這兩個數字。
 * src/lib/pdf-layout.test.ts 會拿真的產出 PDF 對這兩個數字做迴歸。
 */
export function signatureStampBaselines(): { landlord: number; tenant: number } {
  let y = PAGE_H - MARGIN;
  y -= SIGN_BLOCK_TOP_GAP;
  y -= lineAdvance(SIGN_HEADING_SIZE, SIGN_HEADING_GAP_AFTER); // 立契約書人
  y -= lineAdvance(BODY_SIZE, SIGN_ROW_GAP_AFTER); // 甲方（出租人）：…
  y -= lineAdvance(BODY_SIZE, SIGN_ROW_GAP_AFTER); // Email：…
  const landlord = y - BODY_SIZE; // 甲方「簽章：」
  y -= lineAdvance(BODY_SIZE, SIGN_STAMP_BLANK);
  y -= lineAdvance(BODY_SIZE, SIGN_ROW_GAP_AFTER); // 乙方（承租人）：…
  y -= lineAdvance(BODY_SIZE, SIGN_ROW_GAP_AFTER); // Email：…
  const tenant = y - BODY_SIZE; // 乙方「簽章：」
  return { landlord, tenant };
}
