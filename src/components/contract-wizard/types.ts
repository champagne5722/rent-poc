// 建約 wizard 的合約類型畫面介面（MIL-73）。
// 共用的 ContractWizard 管步驟、儲存、簽署區與送簽，不判斷合約類型。
// 每種合約類型提供自己的第①步、第②步、確認頁摘要與表單轉換，登錄在 ./index.ts。
// 元件用方法簽名宣告，登錄表才能把各類型的畫面放進同一個型別。

import type { ReactNode } from 'react';
import type { DescriptionsProps, FormInstance } from 'antd';
import type { PartyLabels } from '@/lib/labels';
import type { MandateItem } from '@/lib/mandate-schedule';
import type { ContractFields, ContractPartyRole } from '@/lib/types';

export interface PropertyStepProps<F extends ContractFields = ContractFields> {
  fields: F;
  /** 分流條件面板（共用，ADR-0021），放在物件說明與範本之間。 */
  routingPanel: ReactNode;
  saving: boolean;
  /** 只改記憶體裡的草稿，按「下一步」時隨草稿存回。 */
  onFieldsChange(next: F): void;
  /** 改欄位並立刻存檔，成功時顯示 `successMessage`。 */
  onCommitFields(next: F, successMessage: string): Promise<void>;
}

export interface FieldsStepProps<F extends ContractFields = ContractFields> {
  form: FormInstance;
  fields: F;
  labels: PartyLabels;
  /** 當事人是執業主體的角色。這幾方的姓名與 Email 由當事人簽署人帶入，不開放手填。 */
  lockedPartyRoles: readonly ContractPartyRole[];
  /** 執業人員指派區（共用，簽署序列有執業人員席位時才有），放在雙方資訊與其他欄位之間。 */
  practitionerSlot: ReactNode;
  onFieldsChange(next: F): void;
  /** 委託標的清單（委託管理合約，MIL-74）。其他合約類型不看。清單改動隨草稿一起存。 */
  mandateItems: readonly MandateItem[];
  onMandateItemsChange(next: MandateItem[]): void;
}

export interface SummaryContext {
  labels: PartyLabels;
  contractId: number;
  /** 委託管理合約的委託標的清單。其他合約類型不看。 */
  mandateItems: readonly MandateItem[];
}

export interface WizardTypeUi<F extends ContractFields = ContractFields> {
  /** 這個類型的草稿有委託標的清單：wizard 載入時讀、按下一步時一併存。 */
  readonly hasMandateItems?: boolean;
  PropertyStep(props: PropertyStepProps<F>): ReactNode;
  FieldsStep(props: FieldsStepProps<F>): ReactNode;
  /** 確認頁在簽署順序說明之下的提醒，例如押金警告。 */
  ConfirmNotices(props: { fields: F }): ReactNode;
  /** 確認頁摘要的合約類型部分。執業人員、簽署序列與簽署區由共用流程接在後面。 */
  summaryItems(fields: F, context: SummaryContext): NonNullable<DescriptionsProps['items']>;
  /** 載入草稿時填進第②步表單的值。 */
  formValuesOf(fields: F): Record<string, unknown>;
  /** 把第②步表單當下的值併回欄位快照。 */
  mergeFormValues(base: F, values: Record<string, unknown>): F;
  /** 選定當事人簽署人後，填進表單的那一方姓名與 Email。 */
  partyFormValues(role: ContractPartyRole, person: { name: string; email: string }): Record<string, string>;
}
