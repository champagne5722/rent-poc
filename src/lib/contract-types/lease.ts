// 租賃合約的類型定義（MIL-73）。欄位檢核、建立草稿與當事人取值都是原本散在 wizard、
// POST /api/contracts 與送簽流程的租賃邏輯，搬到這裡，行為不變。

import { bindTemplate, upgradedTemplateBinding } from '../clause-library';
import { contractEquipmentAnnex, toEquipmentAnnex } from '../equipment';
import { TERMS, partyLabels } from '../labels';
import { statusAnnexIssues, statusAnnexRequired } from '../status-annex';
import { OPTIONAL_CLAUSE_LIBRARIES, TEMPLATES } from '../template-registry';
import type { ContractPartyRole, ContractTemplate, LeaseContractFields, LeaseTermsFields, OptionalClause } from '../types';
import type { ContractListSummary, ContractTypeDefinition, InitialFieldsInput, LeasePartyFields, PartyIdentity } from './types';

const LABELS = partyLabels('lease');
const EMAIL_PATTERN = /.+@.+\..+/;

// 乙方先簽（ADR-0003）：確認頁對出租人說明送簽後的預期。確認頁的說明現在由簽署序列產生（MIL-72），
// 這個常數是原本寫死的文字，測試用它確認自管租賃合約產生的說明沒有改。
export const TENANT_FIRST_NOTICE = `送簽後由${LABELS.partyBFull}先簽，${TERMS.partyB}完成後才輪到${LABELS.partyAFull}簽署，雙方都簽完合約才成立。`;

const PARTY_FIELD_LABELS: Record<ContractPartyRole, readonly [string, string]> = {
  party_a: [`${TERMS.partyA}姓名`, `${TERMS.partyA} Email`],
  party_b: [`${TERMS.partyB}姓名`, `${TERMS.partyB} Email`],
};

/**
 * 第②步的必填欄位檢核，回傳缺漏欄位的標籤。
 * 必填集合與送簽的後端驗證（missingFieldsForSend）一致，額外多擋租期方向顛倒。
 */
export function leaseMissingFields(fields: LeaseContractFields): string[] {
  const missing: string[] = [];
  if (!fields.landlordName.trim()) missing.push('甲方姓名');
  if (!EMAIL_PATTERN.test(fields.landlordEmail)) missing.push('甲方 Email');
  if (!fields.tenantName.trim()) missing.push('乙方姓名');
  if (!EMAIL_PATTERN.test(fields.tenantEmail)) missing.push('乙方 Email');
  if (fields.rent == null) missing.push('月租金');
  if (!fields.startDate) missing.push('租期起日');
  if (!fields.endDate) missing.push('租期迄日');
  else if (fields.startDate && fields.endDate < fields.startDate) {
    missing.push('租期迄日（不得早於起日）');
  }
  return [...missing, ...statusAnnexMissing(fields)];
}

/** 包租租賃合約必附現況確認附件（MIL-71），附件沒填完時列入缺漏。其他組合不檢查。 */
function statusAnnexMissing(fields: LeaseContractFields): string[] {
  return statusAnnexRequired(fields.routing, 'lease') ? statusAnnexIssues(fields.statusAnnex) : [];
}

/** 送簽前伺服器端的必填欄位檢核。標籤與 wizard 的檢核不同，維持原本的回應文字。 */
export function leaseMissingFieldsForSend(f: LeaseContractFields): string[] {
  const missing: string[] = [];
  if (!f.landlordName.trim()) missing.push('甲方姓名');
  if (!EMAIL_PATTERN.test(f.landlordEmail)) missing.push('甲方 Email');
  if (!f.tenantName.trim()) missing.push('乙方姓名');
  if (!EMAIL_PATTERN.test(f.tenantEmail)) missing.push('乙方 Email');
  if (!f.startDate || !f.endDate) missing.push('租期起迄');
  if (f.rent == null) missing.push('租金');
  return [...missing, ...statusAnnexMissing(f)];
}

export const leaseDefinition: ContractTypeDefinition<LeaseContractFields> = {
  type: 'lease',
  documentName: '租賃合約',
  labels: LABELS,
  templates: TEMPLATES.lease,
  optionalClauses: OPTIONAL_CLAUSE_LIBRARIES.lease,

  party(fields: LeasePartyFields, role): PartyIdentity {
    return role === 'party_a'
      ? { name: fields.landlordName, email: fields.landlordEmail }
      : { name: fields.tenantName, email: fields.tenantEmail };
  },

  withParty(fields, role, person) {
    return role === 'party_a'
      ? { ...fields, landlordName: person.name, landlordEmail: person.email }
      : { ...fields, tenantName: person.name, tenantEmail: person.email };
  },

  partyFieldLabels: (role) => PARTY_FIELD_LABELS[role],
  missingFields: leaseMissingFields,
  missingFieldsForSend: leaseMissingFieldsForSend,
  sendSupported: true,
  requiresProperty: true,

  // 從物件建立草稿：物件資料在此帶入成快照，之後與物件脫鉤（見 docs/domain-model.md）；
  // 範本版本也在此綁定，選用條款在 wizard 第①步勾選後才寫進快照（ADR-0005）
  initialFields({ property, routing }: InitialFieldsInput): LeaseContractFields {
    if (!property) throw new Error('租賃合約需要物件');
    return {
      ...(routing ? { routing } : {}),
      landlordName: '',
      landlordEmail: '',
      tenantName: '',
      tenantEmail: '',
      propertyName: property.name,
      propertyAddress: property.address,
      propertyType: property.type,
      propertySize: property.size,
      // 設備附件（ADR-0008）：物件的設備清單帶入成附件列，修繕責任預設出租人，之後逐約調整
      equipmentAnnex: toEquipmentAnnex(property.equipment),
      rent: property.default_rent,
      deposit: property.default_rent != null ? property.default_rent * 2 : null,
      startDate: '',
      endDate: '',
      payDay: 5,
      extra: '',
      ...bindTemplate(),
    };
  },

  listSummary(fields): ContractListSummary {
    return {
      propertyName: fields.propertyName || null,
      rent: fields.rent,
      partyB: { name: fields.tenantName, email: fields.tenantEmail },
      period: fields.startDate && fields.endDate ? [fields.startDate, fields.endDate] : null,
    };
  },
};

/** 第②步表單真正編輯的欄位；日期在 UI 端轉成 YYYY-MM-DD 字串後才進來。 */
export type EditableFieldValues = Partial<
  Pick<
    LeaseContractFields,
    | 'landlordName'
    | 'landlordEmail'
    | 'tenantName'
    | 'tenantEmail'
    | 'rent'
    | 'deposit'
    | 'startDate'
    | 'endDate'
    | 'payDay'
    | 'extra'
  >
>;

/**
 * 把第②步表單的值併回草稿欄位快照。
 * 底稿是草稿當下的完整欄位：物件快照、範本綁定與第①步勾選的條款快照都原樣留著，
 * 只有表單管的那幾個欄位被覆蓋；沒填的正規化成空字串或 null，不讓 undefined 進資料庫。
 */
export function mergeEditableFields<F extends LeaseTermsFields>(base: F, values: EditableFieldValues): F {
  return {
    ...base,
    landlordName: values.landlordName ?? '',
    landlordEmail: values.landlordEmail ?? '',
    tenantName: values.tenantName ?? '',
    tenantEmail: values.tenantEmail ?? '',
    rent: values.rent ?? null,
    deposit: values.deposit ?? null,
    startDate: values.startDate ?? '',
    endDate: values.endDate ?? '',
    payDay: values.payDay ?? null,
    extra: values.extra ?? '',
  };
}

/**
 * 草稿升版重建（ADR-0005）：綁上平台最新範本版本、已勾條款重取最新條文，
 * 並把 v1 只有壓平字串的設備欄位轉成範本 v2 的設備附件列（ADR-0008）。
 * 回傳新物件，原草稿欄位不被就地改寫。
 */
export function upgradeDraftFields(
  fields: LeaseContractFields,
  options: { template?: ContractTemplate; library?: readonly OptionalClause[] } = {},
): LeaseContractFields {
  return {
    ...fields,
    ...upgradedTemplateBinding(fields, options),
    equipmentAnnex: contractEquipmentAnnex(fields),
    // 轉出附件列後舊欄位就沒有用途了；undefined 在 JSON.stringify 時會被丟掉
    equipment: undefined,
  };
}
