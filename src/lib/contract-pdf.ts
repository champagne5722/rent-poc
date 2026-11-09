// 依合約類型產出 PDF（MIL-73）。PDF 版面用 pdf-lib 與字型檔，只有伺服器端引用，
// 所以與 client 端也能引用的 contract-types 分開放。
//
// 新增合約類型的 PDF 時，只在 RENDERERS 加一列。沒有 PDF 的類型回 null，預覽與送簽據此回應「尚未支援」。
// 能不能送簽另由類型定義的 sendSupported 決定（委託管理合約有 PDF 預覽，送簽屬 MIL-77）。

import type { ContractType } from './labels';
import type { ContractAttachments } from './contract-types';
import { PDF_PAGE_SIZE, generateContractPdf } from './pdf';
import { generateManagementPdf } from './pdf-management';
import type { PrintedPractitioner } from './practitioner-assignment/seats';
import type { ContractFields, LeaseContractFields, ManagementContractFields } from './types';

export interface ContractPdfRenderer<F extends ContractFields = ContractFields> {
  readonly pageSize: { readonly width: number; readonly height: number };
  /**
   * @param practitioners 已指派的執業人員，以席位 rule_id 為鍵。沒有的席位留底線。
   * @param attachments 另存於子表的內容。委託管理合約的附件頁需要委託標的清單，租賃合約不看。
   */
  render(
    fields: F,
    practitioners: Readonly<Record<string, PrintedPractitioner>>,
    attachments?: ContractAttachments,
  ): Promise<Uint8Array>;
}

const leaseRenderer: ContractPdfRenderer<LeaseContractFields> = {
  pageSize: PDF_PAGE_SIZE,
  render: (fields, practitioners) => generateContractPdf(fields, practitioners),
};

const managementRenderer: ContractPdfRenderer<ManagementContractFields> = {
  pageSize: PDF_PAGE_SIZE,
  render: (fields, practitioners, attachments) =>
    generateManagementPdf(fields, practitioners, attachments?.mandateItems ?? []),
};

const RENDERERS: Readonly<Record<ContractType, ContractPdfRenderer | null>> = {
  lease: leaseRenderer,
  management: managementRenderer,
};

export function contractPdfRenderer(contractType: ContractType): ContractPdfRenderer | null {
  return RENDERERS[contractType];
}
