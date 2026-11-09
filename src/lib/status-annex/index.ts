// 現況確認附件（MIL-71、P0-12 AC3、ADR-0018 決議 6 與 8）。純資料與純函式，沒有 fs，client 端的 wizard 也能引用。
//
// 附件是包租租賃合約的獨立一頁，與合約同一份 PDF、同一個簽署任務。執業人員必須在該頁有簽署區域。
// 何時必附由簽章分流規則表決定：只要簽署序列有席位要求 `status_annex` 頁，就必附。這裡不另寫一套條件。
//
// 儲存：內容收在 `LeaseContractFields.statusAnnex`（合約欄位快照），不另開資料表。理由見 README。

import type { ContractType } from '../labels';
import { evaluateRouting } from '../signature-routing';
import type { ContractStatus } from '../types';
import {
  STATUS_ANNEX_ITEMS,
  STATUS_ANNEX_NOTE_MAX,
  STATUS_ANNEX_STATUS_LABELS,
  STATUS_ANNEX_UNFILLED_LABEL,
  STATUS_ANNEX_VERSION,
} from './items';
import { STATUS_ANNEX_STATUSES, type StatusAnnex, type StatusAnnexRow } from './types';

export {
  STATUS_ANNEX_ITEMS,
  STATUS_ANNEX_NOTE_MAX,
  STATUS_ANNEX_STATUS_LABELS,
  STATUS_ANNEX_UNFILLED_LABEL,
  STATUS_ANNEX_VERSION,
  type StatusAnnexItemDef,
} from './items';
export { STATUS_ANNEX_STATUSES, type StatusAnnex, type StatusAnnexRow, type StatusAnnexStatus } from './types';

/** 附件頁與編輯區用的名稱。法定文件名是現況確認書（GLOSSARY）。 */
export const STATUS_ANNEX_TITLE = '現況確認附件';
export const STATUS_ANNEX_LEGAL_NAME = '現況確認書';

/** 預設內容：每一項都尚未填狀態，標籤與版本在此快照。 */
export function defaultStatusAnnex(): StatusAnnex {
  return {
    version: STATUS_ANNEX_VERSION,
    rows: STATUS_ANNEX_ITEMS.map((item) => ({ id: item.id, label: item.label, status: null, note: '' })),
  };
}

/** 完整性檢查，回傳全部問題。沒有內容視為全部未填。送簽前的必填檢核用它。 */
export function statusAnnexIssues(annex: StatusAnnex | undefined): string[] {
  const rows = (annex ?? defaultStatusAnnex()).rows;
  const issues: string[] = [];
  const unfilled = rows.filter((r) => r.status === null).length;
  if (unfilled > 0) issues.push(`現況確認附件尚有 ${unfilled} 項未填狀態`);
  for (const row of rows) {
    if (row.status === 'defect' && row.note.trim() === '') {
      issues.push(`現況確認附件「${row.label}」有瑕疵，請填備註說明`);
    }
  }
  return issues;
}

function rowInputError(row: unknown): string | null {
  if (!row || typeof row !== 'object') return '現況確認附件的列格式不正確';
  const { id, label, status, note } = row as Record<string, unknown>;
  if (typeof id !== 'string' || id === '' || typeof label !== 'string') return '現況確認附件的列缺少項目';
  if (status !== null && !(STATUS_ANNEX_STATUSES as readonly unknown[]).includes(status)) {
    return `現況確認附件「${label}」的狀態不正確`;
  }
  if (typeof note !== 'string') return `現況確認附件「${label}」的備註格式不正確`;
  if (note.length > STATUS_ANNEX_NOTE_MAX) return `現況確認附件「${label}」的備註不得超過 ${STATUS_ANNEX_NOTE_MAX} 字`;
  return null;
}

/** 存草稿時檢查 `fields.statusAnnex` 的形狀。沒有帶（undefined）或形狀正確回 null。 */
export function statusAnnexInputError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object') return '現況確認附件的格式不正確';
  const { version, rows } = value as Record<string, unknown>;
  if (typeof version !== 'number' || !Array.isArray(rows)) return '現況確認附件的格式不正確';
  if (rows.length > 50) return '現況確認附件的項目過多';
  for (const row of rows) {
    const error = rowInputError(row);
    if (error) return error;
  }
  return null;
}

/**
 * 這份合約必不必附現況確認附件。只問簽章分流規則表：簽署序列有席位要求 `status_annex` 頁就必附。
 * 只有租賃合約有這個附件。分流條件沒有或不合法時不附。
 */
export function statusAnnexRequired(routing: unknown, contractType: ContractType): boolean {
  if (contractType !== 'lease') return false;
  const evaluation = evaluateRouting(routing, contractType);
  return evaluation.ok && evaluation.plan.seats.some((seat) => seat.requiredFieldPages.includes('status_annex'));
}

/**
 * 這份合約的 PDF 要印哪一份現況確認附件。不必附回傳 null。
 * - 草稿：必附時印已存的內容，還沒有內容就印預設清單。
 * - 送簽之後：只印已凍結的內容。送簽前就存在的舊包租合約沒有內容，所以不印，PDF 與送簽時相同。
 */
export function statusAnnexOf(
  status: ContractStatus,
  contractType: ContractType,
  fields: { routing?: unknown; statusAnnex?: StatusAnnex },
): StatusAnnex | null {
  if (!statusAnnexRequired(fields.routing, contractType)) return null;
  if (status === 'draft') return fields.statusAnnex ?? defaultStatusAnnex();
  return fields.statusAnnex ?? null;
}

function rowSummary(row: StatusAnnexRow): string {
  if (row.status === null) return `${row.label}：${STATUS_ANNEX_UNFILLED_LABEL}`;
  const note = row.note.trim() === '' ? '' : `（${row.note.trim()}）`;
  return `${row.label}：${STATUS_ANNEX_STATUS_LABELS[row.status]}${note}`;
}

/** 唯讀摘要，一列一行，確認頁與詳情頁用。 */
export function statusAnnexSummary(annex: StatusAnnex): string[] {
  return annex.rows.map(rowSummary);
}

/** 附件頁缺少執業人員簽名框的原因。伺服器的送簽前檢查與 wizard 用同一句，確認頁才不會重複列出。 */
export function statusAnnexSignatureMissingMessage(seatLabel: string): string {
  return `請在${STATUS_ANNEX_TITLE}頁為${seatLabel}放置簽名框`;
}
