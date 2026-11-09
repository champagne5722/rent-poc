// 現況確認附件頁的畫法（MIL-71）。版面常數在 pdf-layout.ts。
// 另起一頁：標題、說明、三欄表格（項目、狀態、備註），頁底固定一個執業人員簽署欄。
// 簽署欄的位置不隨表格長短移動，所以簽署區編輯器能用固定的預設落點（signature-layout.ts）。

import { TERMS } from './labels';
import {
  ANNEX_TITLE_GAP_AFTER,
  ANNEX_TITLE_SIZE,
  BODY_SIZE,
  SIGN_ROW_GAP_AFTER,
  STATUS_ANNEX_COLUMNS,
  STATUS_ANNEX_COLUMN_WIDTHS,
  STATUS_ANNEX_PAGE_TITLE,
  statusAnnexSignTop,
} from './pdf-layout';
import type { Writer } from './pdf';
import { STATUS_ANNEX_STATUS_LABELS, STATUS_ANNEX_UNFILLED_LABEL, STATUS_ANNEX_LEGAL_NAME, type StatusAnnex } from './status-annex';

/**
 * @param signerLines 頁底簽署欄「簽章：」之前的兩行資料：執業人員的姓名與法定稱謂、執業主體。
 */
export function drawStatusAnnex(w: Writer, annex: StatusAnnex, signerLines: readonly [string, string]): void {
  const widths = STATUS_ANNEX_COLUMN_WIDTHS;
  w.addPage();
  w.center(`附件　${STATUS_ANNEX_PAGE_TITLE}`, ANNEX_TITLE_SIZE, ANNEX_TITLE_GAP_AFTER);
  w.text(
    `本附件為本契約之一部分，即${STATUS_ANNEX_LEGAL_NAME}，記載租賃住宅交屋時之現況，由${TERMS.partyA}填寫，經${TERMS.partyB}同意，並由執業人員簽章。`,
    BODY_SIZE,
    { gapAfter: 8 },
  );
  w.tableRow(STATUS_ANNEX_COLUMNS, { head: true, widths });
  for (const row of annex.rows) {
    const status = row.status === null ? STATUS_ANNEX_UNFILLED_LABEL : STATUS_ANNEX_STATUS_LABELS[row.status];
    w.tableRow([row.label, status, row.note.trim() || '—'], { widths });
  }

  // 頁底固定的執業人員簽署欄
  w.y = statusAnnexSignTop();
  for (const line of signerLines) w.text(line, BODY_SIZE, { gapAfter: SIGN_ROW_GAP_AFTER });
  w.text('簽章：', BODY_SIZE);
}
