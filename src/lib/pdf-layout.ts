// 合約範本的版面常數與簽署欄位置推導。
// 這裡只有純數字與純函式（不碰 fs / pdf-lib），所以 client 端的簽署區編輯器也能引用；
// 實際畫 PDF 的 src/lib/pdf.ts 一律吃這裡的常數，避免同一組版面數字在兩邊各寫一份。
import type { ContractPartyRole } from './types';

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

/**
 * 設備附件頁（ADR-0008）的版面參數。附件排在簽署欄之後（內政部慣例：附件在本文與簽章之後），
 * 所以附件多長都不會動到上面的簽署欄落點。
 */
export const ANNEX_TITLE = '附屬設備清單';
export const ANNEX_TITLE_SIZE = 15;
export const ANNEX_TITLE_GAP_AFTER = 8;
export const ANNEX_COLUMNS = ['項目', '數量', '修繕責任', '備註'] as const;
/** 四欄寬度合計＝版心寬（PAGE_W - MARGIN * 2）。 */
export const ANNEX_COLUMN_WIDTHS = [170, 55, 80, 178.28] as const;
export const ANNEX_CELL_PAD_X = 6;
export const ANNEX_CELL_PAD_Y = 5;

/** 一行文字往下推進的距離（字級＋行距＋段後空白）。 */
function lineAdvance(size: number, gapAfter = 0): number {
  return size + LINE_GAP + gapAfter;
}

/**
 * 甲乙兩個「簽章：」的 baseline y（PDF 座標），以簽署角色為鍵。
 *
 * 這段是把 generateContractPdf 尾段的排版順序原樣重走一遍：簽署欄一律另起一頁，所以起點
 * 固定是 `PAGE_H - MARGIN`，勾幾條選用條款、其他約定事項寫多長都不影響這兩個數字。
 * src/lib/pdf-layout.test.ts 會拿真的產出 PDF 對這兩個數字做迴歸。
 */
export function signatureStampBaselines(): Record<ContractPartyRole, number> {
  let y = PAGE_H - MARGIN;
  y -= SIGN_BLOCK_TOP_GAP;
  y -= lineAdvance(SIGN_HEADING_SIZE, SIGN_HEADING_GAP_AFTER); // 立契約書人
  y -= lineAdvance(BODY_SIZE, SIGN_ROW_GAP_AFTER); // 甲方（出租人）：…
  y -= lineAdvance(BODY_SIZE, SIGN_ROW_GAP_AFTER); // Email：…
  const partyA = y - BODY_SIZE; // 甲方「簽章：」
  y -= lineAdvance(BODY_SIZE, SIGN_STAMP_BLANK);
  y -= lineAdvance(BODY_SIZE, SIGN_ROW_GAP_AFTER); // 乙方（承租人）：…
  y -= lineAdvance(BODY_SIZE, SIGN_ROW_GAP_AFTER); // Email：…
  const partyB = y - BODY_SIZE; // 乙方「簽章：」
  return { party_a: partyA, party_b: partyB };
}
