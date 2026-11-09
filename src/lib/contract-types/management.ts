// 委託管理合約的類型定義（MIL-73）。
// 目前只有共用基底與兩方當事人，讓共用流程能取得簽署人與清單欄位。
// 委託標的清單、委託範圍、委託期間、報酬、範本與送簽屬 MIL-74、MIL-77。

import { TERMS, partyLabels } from '../labels';
import { OPTIONAL_CLAUSE_LIBRARIES, TEMPLATES } from '../template-registry';
import type { ContractPartyRole, ManagementContractFields } from '../types';
import type {
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

function missingParties(f: ManagementContractFields): string[] {
  const missing: string[] = [];
  const [mandatorName, mandatorEmail] = PARTY_FIELD_LABELS.party_a;
  const [mandataryName, mandataryEmail] = PARTY_FIELD_LABELS.party_b;
  if (!f.mandatorName.trim()) missing.push(mandatorName);
  if (!EMAIL_PATTERN.test(f.mandatorEmail)) missing.push(mandatorEmail);
  if (!f.mandataryName.trim()) missing.push(mandataryName);
  if (!EMAIL_PATTERN.test(f.mandataryEmail)) missing.push(mandataryEmail);
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
  missingFields: missingParties,
  missingFieldsForSend: missingParties,

  initialFields({ routing }: InitialFieldsInput): ManagementContractFields {
    return {
      ...(routing ? { routing } : {}),
      mandatorName: '',
      mandatorEmail: '',
      mandataryName: '',
      mandataryEmail: '',
      extra: '',
    };
  },

  listSummary(fields): ContractListSummary {
    return {
      propertyName: null,
      rent: null,
      partyB: { name: fields.mandataryName, email: fields.mandataryEmail },
      period: null,
    };
  },
};
