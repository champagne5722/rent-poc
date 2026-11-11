// 合約類型登錄與依類型取用的入口（MIL-73、ADR-0021 決議 2）。
//
// 共用流程（建約 wizard、送簽、清單）只呼叫這裡的函式，傳入合約的 `contract_type` 與欄位，
// 不判斷具體類型。新增合約類型時：在 labels 的 ContractType 加值、寫一份定義、加進 DEFINITIONS，
// 型別系統會指出還沒處理的地方（DEFINITIONS 是 Record，漏一個就編譯不過）。

import type { ContractType } from '../labels';
import type { ContractFields, ContractPartyRole } from '../types';
import { leaseDefinition } from './lease';
import { managementDefinition } from './management';
import { masterLeaseDefinition } from './master-lease';
import { subleaseDefinition } from './sublease';
import type {
  ContractAttachments,
  ContractListSummary,
  ContractTypeDefinition,
  InitialFieldsInput,
  PartyFields,
  PartyIdentity,
} from './types';

export type {
  ContractAttachments,
  ContractListSummary,
  ContractTypeDefinition,
  InitialFieldsInput,
  PartyFields,
  PartyIdentity,
} from './types';
export {
  TENANT_FIRST_NOTICE,
  leaseMissingFields,
  leaseMissingFieldsForSend,
  mergeEditableFields,
  upgradeDraftFields,
  type EditableFieldValues,
} from './lease';
export { mergeManagementFields, type ManagementEditableValues } from './management';
export { caseKindForContractType, contractTypeForCaseKind, routingSnapshotFor } from './case-kind';

/** 沒有帶合約類型時的預設：舊資料與沒有類型欄位前建立的合約一律是租賃合約（ADR-0021 決議 2）。 */
export const DEFAULT_CONTRACT_TYPE: ContractType = 'lease';

const DEFINITIONS: Readonly<Record<ContractType, ContractTypeDefinition>> = {
  lease: leaseDefinition,
  management: managementDefinition,
  master_lease: masterLeaseDefinition,
  sublease: subleaseDefinition,
};

export const CONTRACT_TYPES = Object.keys(DEFINITIONS) as ContractType[];

export function contractTypeDefinition(type: ContractType): ContractTypeDefinition {
  return DEFINITIONS[type];
}

/** 合約或 wizard 草稿：類型加上那個類型的欄位。`Contract` 符合這個形狀。 */
export interface TypedFields {
  contract_type: ContractType;
  fields: ContractFields;
}

export function partyOf(contract: TypedFields, role: ContractPartyRole): PartyIdentity {
  return contractTypeDefinition(contract.contract_type).party(contract.fields, role);
}

/**
 * 只有當事人欄位時取當事人（送簽前評估的輸入就是這幾個欄位）。
 * 傳入的欄位必須是 `contractType` 那個類型的形狀，登錄表只知道類型，不再驗證欄位。
 */
export function partyOfFields(contractType: ContractType, fields: PartyFields, role: ContractPartyRole): PartyIdentity {
  return contractTypeDefinition(contractType).party(fields as ContractFields, role);
}

export function withParty(contract: TypedFields, role: ContractPartyRole, person: PartyIdentity): ContractFields {
  return contractTypeDefinition(contract.contract_type).withParty(contract.fields, role, person);
}

export function missingFieldsOf(contract: TypedFields, attachments?: ContractAttachments): string[] {
  return contractTypeDefinition(contract.contract_type).missingFields(contract.fields, attachments);
}

export function missingFieldsForSendOf(contract: TypedFields, attachments?: ContractAttachments): string[] {
  return contractTypeDefinition(contract.contract_type).missingFieldsForSend(contract.fields, attachments);
}

export function initialFieldsFor(type: ContractType, input: InitialFieldsInput): ContractFields {
  return contractTypeDefinition(type).initialFields(input);
}

export function listSummaryOf(contract: TypedFields): ContractListSummary {
  return contractTypeDefinition(contract.contract_type).listSummary(contract.fields);
}

export function partyFieldLabels(type: ContractType, role: ContractPartyRole): readonly [string, string] {
  return contractTypeDefinition(type).partyFieldLabels(role);
}
