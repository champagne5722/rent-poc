// 依合約類型產出 PDF（MIL-73）。PDF 版面用 pdf-lib 與字型檔，只有伺服器端引用，
// 所以與 client 端也能引用的 contract-types 分開放。
//
// 新增合約類型的 PDF 時，只在 RENDERERS 加一列（委託管理合約屬 MIL-74）。
// 沒有 PDF 的類型回 null，送簽流程據此回應「尚未支援」。

import type { ContractType } from './labels';
import { PDF_PAGE_SIZE, generateContractPdf } from './pdf';
import type { PrintedPractitioner } from './practitioner-assignment/seats';
import type { ContractFields, LeaseContractFields } from './types';

export interface ContractPdfRenderer<F extends ContractFields = ContractFields> {
  readonly pageSize: { readonly width: number; readonly height: number };
  /** @param practitioners 已指派的執業人員，以席位 rule_id 為鍵。沒有的席位留底線。 */
  render(fields: F, practitioners: Readonly<Record<string, PrintedPractitioner>>): Promise<Uint8Array>;
}

const leaseRenderer: ContractPdfRenderer<LeaseContractFields> = {
  pageSize: PDF_PAGE_SIZE,
  render: (fields, practitioners) => generateContractPdf(fields, practitioners),
};

const RENDERERS: Readonly<Record<ContractType, ContractPdfRenderer | null>> = {
  lease: leaseRenderer,
  management: null,
};

export function contractPdfRenderer(contractType: ContractType): ContractPdfRenderer | null {
  return RENDERERS[contractType];
}
