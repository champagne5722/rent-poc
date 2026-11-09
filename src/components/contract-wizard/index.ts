// 建約 wizard 的合約類型畫面登錄（MIL-73）。
// 新增合約類型的建約畫面時，寫一份 WizardTypeUi 加進 WIZARD_UI。
// 委託管理合約的建約畫面屬 MIL-74，在那之前沒有畫面，wizard 會說明尚未支援。

import type { ContractType } from '@/lib/labels';
import { leaseWizardUi } from './lease/LeaseWizardUi';
import type { WizardTypeUi } from './types';

export type { FieldsStepProps, PropertyStepProps, SummaryContext, WizardTypeUi } from './types';
export { TemplateNotice } from './TemplateNotice';

const WIZARD_UI: Readonly<Record<ContractType, WizardTypeUi | null>> = {
  lease: leaseWizardUi,
  management: null,
};

export function wizardUiFor(contractType: ContractType): WizardTypeUi | null {
  return WIZARD_UI[contractType];
}
