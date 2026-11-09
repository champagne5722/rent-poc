// 合約範本的版面常數與簽署欄位置推導。
// 這裡只有純數字與純函式（不碰 fs / pdf-lib），所以 client 端的簽署區編輯器也能引用；
// 實際畫 PDF 的 src/lib/pdf.ts 一律吃這裡的常數，避免同一組版面數字在兩邊各寫一份。
import type { ContractPartyRole, SignerRole } from './types';

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

/** 委託標的清單附件頁（MIL-74）的版面參數。三欄寬度合計＝版心寬。 */
export const MANDATE_ANNEX_TITLE = '委託標的清單';
export const MANDATE_ANNEX_COLUMNS = ['租賃單位', '地址', '委託範圍'] as const;
export const MANDATE_ANNEX_COLUMN_WIDTHS = [110, 203.28, 170] as const;

/**
 * 現況確認附件頁（MIL-71）的版面參數。附件排在簽署欄與設備附件之後，獨立一頁。
 * 表格三欄：項目、狀態、備註，寬度合計＝版心寬。備註字數有上限（STATUS_ANNEX_NOTE_MAX），所以表格一定放得進一頁。
 */
export const STATUS_ANNEX_PAGE_TITLE = '現況確認附件';
export const STATUS_ANNEX_COLUMNS = ['項目', '狀態', '備註'] as const;
export const STATUS_ANNEX_COLUMN_WIDTHS = [200, 70, 213.28] as const;

/** 簽署欄（簽名頁）的標題文字。簽署區編輯器與頁面地圖都用它找出簽名頁。 */
export const SIGNATURE_BLOCK_HEADING = '立契約書人';

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
  const [partyA, partyB] = signatureBlockLayout([{ role: 'party_a' }, { role: 'party_b' }]);
  return { party_a: partyA.stampBaseline, party_b: partyB.stampBaseline };
}

/** 簽署欄的印列順序（ADR-0018 決議 14）：固定甲方、乙方、執業人員，與簽署順序無關。 */
export const SIGNATURE_PRINT_ORDER = ['party_a', 'party_b', 'practitioner'] as const satisfies readonly SignerRole[];

/** 一個要印出的簽署席位。`slot` 是規則列的 rule_id（ADR-0021 決議 5），同角色有多個席位時靠它區分。 */
export interface SignatureBlockSeat {
  role: SignerRole;
  slot?: string;
}

/** 一個簽署欄的落點。 */
export interface SignatureBlockSpot extends SignatureBlockSeat {
  /** 該欄「簽章：」的 baseline y（PDF 座標，原點左下）。 */
  stampBaseline: number;
}

/**
 * 簽署欄版面：席位清單進、落點出（ADR-0018 決議 14）。純函式，沒有 I/O。
 *
 * 輸入順序是簽署順序，這裡依 {@link SIGNATURE_PRINT_ORDER} 重排成印列順序。
 * 同一角色的多個席位保留輸入時的先後（例如包租又有經紀人：管理人員在前、經紀人在後）。
 * 每個簽署欄的形狀相同：標題列、兩行資料、「簽章：」加簽名空白，所以落點只看印列的第幾個。
 * 兩方合約（甲方、乙方）的落點與 N 列版面之前完全相同，既有合約的 PDF 不動（ADR-0006）。
 *
 * 這段是把 generateContractPdf 簽署欄的排版順序原樣重走一遍。src/lib/pdf-layout.test.ts
 * 會拿真的產出 PDF 對落點做迴歸。
 */
export function signatureBlockLayout(seats: readonly SignatureBlockSeat[]): SignatureBlockSpot[] {
  const printed = SIGNATURE_PRINT_ORDER.flatMap((role) => seats.filter((seat) => seat.role === role));
  let y = PAGE_H - MARGIN;
  y -= SIGN_BLOCK_TOP_GAP;
  y -= lineAdvance(SIGN_HEADING_SIZE, SIGN_HEADING_GAP_AFTER); // 立契約書人
  return printed.map((seat) => {
    y -= lineAdvance(BODY_SIZE, SIGN_ROW_GAP_AFTER); // 身分列，例如「甲方（出租人）：…」
    y -= lineAdvance(BODY_SIZE, SIGN_ROW_GAP_AFTER); // 第二列，例如「Email：…」
    const stampBaseline = y - BODY_SIZE; // 「簽章：」
    y -= lineAdvance(BODY_SIZE, SIGN_STAMP_BLANK);
    return { ...seat, stampBaseline };
  });
}

/**
 * 現況確認附件頁底部的執業人員簽署欄：固定在頁底，不隨表格長短移動。
 * 版面是兩行資料加「簽章：」與簽名空白，高度與簽署欄的一列相同。
 * 回傳整塊的頂端 y（PDF 座標，原點左下）。表格的底部必須高於它。
 */
export function statusAnnexSignTop(): number {
  return MARGIN + lineAdvance(BODY_SIZE, SIGN_ROW_GAP_AFTER) * 2 + lineAdvance(BODY_SIZE, SIGN_STAMP_BLANK);
}

/** 現況確認附件頁「簽章：」的 baseline y（PDF 座標）。 */
export function statusAnnexStampBaseline(): number {
  return statusAnnexSignTop() - lineAdvance(BODY_SIZE, SIGN_ROW_GAP_AFTER) * 2 - BODY_SIZE;
}

/**
 * 產出的 PDF 的頁面地圖（0-based 頁碼）。簽署區域的 `page` 就是這個頁碼。
 * 簽名頁與附件頁的位置隨本文長度而變，所以由產生 PDF 的函式回報，不用「最後一頁」推測（MIL-162）。
 */
export interface PdfPageMap {
  pageCount: number;
  /** 簽署欄（「立契約書人」）所在的頁。 */
  signaturePage: number;
  /** 現況確認附件所在的頁。沒有附件時為 null。 */
  statusAnnexPage: number | null;
}

function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * 由各頁的文字找出簽名頁：第一個含「立契約書人」的頁。找不到時退回最後一頁（MIL-162）。
 * 簽署區編輯器用 pdf.js 讀出每頁文字後呼叫它。
 */
export function findSignaturePage(pageTexts: readonly string[]): number {
  const found = pageTexts.findIndex((text) => squash(text).includes(SIGNATURE_BLOCK_HEADING));
  return found >= 0 ? found : Math.max(pageTexts.length - 1, 0);
}

/** 由各頁的文字找出現況確認附件頁：標題「附件　現況確認附件」所在的頁。沒有時回 null。 */
export function findStatusAnnexPage(pageTexts: readonly string[]): number | null {
  const found = pageTexts.findIndex((text) => squash(text).includes(`附件${STATUS_ANNEX_PAGE_TITLE}`));
  return found >= 0 ? found : null;
}

/** 由各頁文字推出頁面地圖。編輯器沒有伺服器的地圖時用它。 */
export function pageMapFromTexts(pageTexts: readonly string[]): PdfPageMap {
  return {
    pageCount: pageTexts.length,
    signaturePage: findSignaturePage(pageTexts),
    statusAnnexPage: findStatusAnnexPage(pageTexts),
  };
}
