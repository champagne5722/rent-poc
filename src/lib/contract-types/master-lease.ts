// 包租合約的類型定義（MIL-199、ADR-0030 決議 6）。
// 屋主（出租人，甲方）把租賃單位出租給包租業者（包租業，乙方）並同意它轉租，法定文件名是住宅包租契約。
// 條文依內政部公告（master-lease-clauses.ts）。不附現況確認附件。簽署序列看案件種類 master_lease（簽章分流規則表不動）。

import { partyLabels } from '../labels';
import { OPTIONAL_CLAUSE_LIBRARIES, TEMPLATES } from '../template-registry';
import type { ContractPartyRole, MasterLeaseContractFields } from '../types';
import {
  leaseFamilyInitialFields,
  leaseFamilyListSummary,
  leaseFamilyMissingFields,
  leaseFamilyParty,
  leaseFamilyWithParty,
} from './lease-family';
import type { ContractTypeDefinition, InitialFieldsInput } from './types';

const LABELS = partyLabels('master_lease');

const PARTY_FIELD_LABELS: Record<ContractPartyRole, readonly [string, string]> = {
  party_a: [`${LABELS.partyA}姓名`, `${LABELS.partyA} Email`],
  party_b: [`${LABELS.partyB}姓名`, `${LABELS.partyB} Email`],
};

function missingMasterLeaseFields(f: MasterLeaseContractFields): string[] {
  return leaseFamilyMissingFields(f, { partyA: PARTY_FIELD_LABELS.party_a, partyB: PARTY_FIELD_LABELS.party_b });
}

export const masterLeaseDefinition: ContractTypeDefinition<MasterLeaseContractFields> = {
  type: 'master_lease',
  documentName: '包租合約',
  labels: LABELS,
  templates: TEMPLATES.master_lease,
  optionalClauses: OPTIONAL_CLAUSE_LIBRARIES.master_lease,

  party: leaseFamilyParty,
  withParty: leaseFamilyWithParty,
  partyFieldLabels: (role) => PARTY_FIELD_LABELS[role],
  missingFields: missingMasterLeaseFields,
  missingFieldsForSend: missingMasterLeaseFields,
  sendSupported: true,
  requiresProperty: true,

  initialFields: (input: InitialFieldsInput): MasterLeaseContractFields => leaseFamilyInitialFields('master_lease', input),

  listSummary: leaseFamilyListSummary,
};
