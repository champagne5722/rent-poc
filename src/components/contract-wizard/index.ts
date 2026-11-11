// 建約 wizard 的合約類型畫面登錄（MIL-73）。
// 新增合約類型的建約畫面時，寫一份 WizardTypeUi 加進 WIZARD_UI。

import type { ContractType } from '@/lib/labels';
import { leaseWizardUi, masterLeaseWizardUi, subleaseWizardUi } from './lease/LeaseWizardUi';
import { managementWizardUi } from './management/ManagementWizardUi';
import type { WizardTypeUi } from './types';

export type { FieldsStepProps, PropertyStepProps, SummaryContext, WizardTypeUi } from './types';
export { TemplateNotice } from './TemplateNotice';

const WIZARD_UI: Readonly<Record<ContractType, WizardTypeUi | null>> = {
  lease: leaseWizardUi,
  management: managementWizardUi,
  // 包租與轉租合約沿用租賃合約的畫面，版面不變（MIL-199）
  master_lease: masterLeaseWizardUi,
  sublease: subleaseWizardUi,
};

export function wizardUiFor(contractType: ContractType): WizardTypeUi | null {
  return WIZARD_UI[contractType];
}
