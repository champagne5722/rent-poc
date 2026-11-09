// 委託管理合約的類型定義（MIL-73、MIL-74）。
// 欄位是兩方當事人、委託期間與報酬約定。委託標的清單與委託範圍存在子表（src/lib/mandate-schedule），
// 受託人的執業主體與專任管理人員存在指派表，兩者都不在欄位裡。送簽屬 MIL-77。

import { TERMS, partyLabels } from '../labels';
import { mandateItemsIssues } from '../mandate-schedule';
import { currentTemplate, OPTIONAL_CLAUSE_LIBRARIES, TEMPLATES } from '../template-registry';
import type { ContractPartyRole, ManagementContractFields } from '../types';
import type {
  ContractAttachments,
  ContractListSummary,
  ContractTypeDefinition,
  InitialFieldsInput,
  ManagementPartyFields,
  PartyIdentity,
} from './types';

const LABELS = partyLabels('management');
const EMAIL_PATTERN = /.+@.+\..+/;

const PARTY_FIELD_LABELS: Record<ContractPartyRole, readonly [string, string]> = {
  party_a: [`${TERMS.mandator}姓名`, `${TERMS.mandator} Email`],
  party_b: [`${TERMS.mandatary}姓名`, `${TERMS.mandatary} Email`],
};

/** 報酬約定的檢核。百分比限 0 到 100，固定金額不得為負。 */
function missingFee(f: ManagementContractFields): string[] {
  if (f.feeMode == null) return ['報酬約定'];
  if (f.feeValue == null) return ['報酬金額'];
  if (f.feeMode === 'rent_percentage' && (f.feeValue < 0 || f.feeValue > 100)) {
    return ['報酬金額（百分比要在 0 到 100 之間）'];
  }
  if (f.feeValue < 0) return ['報酬金額（不得為負）'];
  return [];
}

/** wizard 與送簽共用的必填檢核。沒有帶委託標的清單（呼叫端沒載入）時不檢查清單。 */
function missingManagementFields(f: ManagementContractFields, attachments?: ContractAttachments): string[] {
  const missing: string[] = [];
  const [mandatorName, mandatorEmail] = PARTY_FIELD_LABELS.party_a;
  const [mandataryName, mandataryEmail] = PARTY_FIELD_LABELS.party_b;
  if (!f.mandatorName.trim()) missing.push(mandatorName);
  if (!EMAIL_PATTERN.test(f.mandatorEmail)) missing.push(mandatorEmail);
  if (!f.mandataryName.trim()) missing.push(mandataryName);
  if (!EMAIL_PATTERN.test(f.mandataryEmail)) missing.push(mandataryEmail);
  if (!f.termStart) missing.push('委託期間起日');
  if (!f.termEnd) missing.push('委託期間迄日');
  else if (f.termStart && f.termEnd < f.termStart) missing.push('委託期間迄日（不得早於起日）');
  missing.push(...missingFee(f));
  if (attachments?.mandateItems && mandateItemsIssues(attachments.mandateItems).length > 0) {
    missing.push('委託標的清單');
  }
  return missing;
}

export const managementDefinition: ContractTypeDefinition<ManagementContractFields> = {
  type: 'management',
  documentName: '委託管理合約',
  labels: LABELS,
  templates: TEMPLATES.management,
  optionalClauses: OPTIONAL_CLAUSE_LIBRARIES.management,

  party(fields: ManagementPartyFields, role): PartyIdentity {
    return role === 'party_a'
      ? { name: fields.mandatorName, email: fields.mandatorEmail }
      : { name: fields.mandataryName, email: fields.mandataryEmail };
  },

  withParty(fields, role, person) {
    return role === 'party_a'
      ? { ...fields, mandatorName: person.name, mandatorEmail: person.email }
      : { ...fields, mandataryName: person.name, mandataryEmail: person.email };
  },

  partyFieldLabels: (role) => PARTY_FIELD_LABELS[role],
  missingFields: missingManagementFields,
  missingFieldsForSend: missingManagementFields,
  // 送簽屬 MIL-77。MIL-77 完成後改成 true，並補上詳情頁與簽署模組的委託管理合約訂閱者
  sendSupported: false,
  requiresProperty: false,
  draftNotice: {
    title: '委託管理合約不綁單一物件',
    description: `${TERMS.mandator}與${TERMS.mandatary}簽一份合約，可涵蓋多個租賃單位。建立草稿後，在「填寫欄位」步驟選受託人、委託期間、報酬約定，並從物件加入委託標的清單。`,
  },

  // 建立草稿：綁定範本最新版本。沒有選用條款，租賃單位在委託標的清單，不在欄位快照
  initialFields({ routing }: InitialFieldsInput): ManagementContractFields {
    const template = currentTemplate('management');
    return {
      ...(routing ? { routing } : {}),
      mandatorName: '',
      mandatorEmail: '',
      mandataryName: '',
      mandataryEmail: '',
      termStart: '',
      termEnd: '',
      feeMode: null,
      feeValue: null,
      extra: '',
      ...(template ? { templateId: template.id, templateVersion: template.version, clauses: [] } : {}),
    };
  },

  listSummary(fields): ContractListSummary {
    return {
      propertyName: null,
      rent: null,
      partyB: { name: fields.mandataryName, email: fields.mandataryEmail },
      period: fields.termStart && fields.termEnd ? [fields.termStart, fields.termEnd] : null,
    };
  },
};

/** 第②步表單真正編輯的欄位；日期在 UI 端轉成 YYYY-MM-DD 字串後才進來。受託人兩欄由當事人簽署人帶入，表單不一定有。 */
export type ManagementEditableValues = Partial<
  Pick<
    ManagementContractFields,
    | 'mandatorName'
    | 'mandatorEmail'
    | 'mandataryName'
    | 'mandataryEmail'
    | 'termStart'
    | 'termEnd'
    | 'feeMode'
    | 'feeValue'
  >
>;

/**
 * 把第②步表單的值併回草稿欄位快照。底稿是草稿當下的完整欄位，範本綁定與分流條件原樣留著。
 * 沒填的正規化成空字串或 null。受託人兩欄沒給時沿用底稿，因為這兩欄在選定當事人簽署人時就已寫進底稿。
 */
export function mergeManagementFields(
  base: ManagementContractFields,
  values: ManagementEditableValues,
): ManagementContractFields {
  return {
    ...base,
    mandatorName: values.mandatorName ?? '',
    mandatorEmail: values.mandatorEmail ?? '',
    mandataryName: values.mandataryName ?? base.mandataryName,
    mandataryEmail: values.mandataryEmail ?? base.mandataryEmail,
    termStart: values.termStart ?? '',
    termEnd: values.termEnd ?? '',
    feeMode: values.feeMode ?? null,
    feeValue: values.feeValue ?? null,
  };
}
