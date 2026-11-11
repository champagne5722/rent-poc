// 轉租合約的類型定義（MIL-199、ADR-0030 決議 6、7）。
// 包租業者（包租業，甲方）把承租的租賃單位轉租給承租人（乙方），法定文件名是住宅轉租契約。
// 條文依內政部公告（sublease-clauses.ts）。現況確認附件跟著轉租合約，內容存在 `statusAnnex`，
// 必附與否看簽章分流規則表（簽署序列有席位要求附件頁就必附）。簽署序列看案件種類 sublease。

import { partyLabels } from '../labels';
import { statusAnnexIssues, statusAnnexRequired } from '../status-annex';
import { OPTIONAL_CLAUSE_LIBRARIES, TEMPLATES } from '../template-registry';
import type { ContractPartyRole, SubleaseContractFields } from '../types';
import {
  leaseFamilyInitialFields,
  leaseFamilyListSummary,
  leaseFamilyMissingFields,
  leaseFamilyParty,
  leaseFamilyWithParty,
} from './lease-family';
import type { ContractTypeDefinition, InitialFieldsInput } from './types';

const LABELS = partyLabels('sublease');

const PARTY_FIELD_LABELS: Record<ContractPartyRole, readonly [string, string]> = {
  party_a: [`${LABELS.partyA}姓名`, `${LABELS.partyA} Email`],
  party_b: [`${LABELS.partyB}姓名`, `${LABELS.partyB} Email`],
};

/** 轉租期間不得逾包租契約的租賃期間。包租契約的期間有填時才檢核。 */
function masterLeaseTermIssues(f: SubleaseContractFields): string[] {
  const issues: string[] = [];
  if (f.masterLeaseStart && f.startDate && f.startDate < f.masterLeaseStart) issues.push('租期起日（不得早於包租契約之租賃期間）');
  if (f.masterLeaseEnd && f.endDate && f.endDate > f.masterLeaseEnd) issues.push('租期迄日（不得逾包租契約之租賃期間）');
  return issues;
}

function missingSubleaseFields(f: SubleaseContractFields): string[] {
  const missing = leaseFamilyMissingFields(f, { partyA: PARTY_FIELD_LABELS.party_a, partyB: PARTY_FIELD_LABELS.party_b });
  missing.push(...masterLeaseTermIssues(f));
  // 現況確認附件必附時，附件沒填完列入缺漏（MIL-71）
  if (statusAnnexRequired(f.routing, 'sublease')) missing.push(...statusAnnexIssues(f.statusAnnex));
  return missing;
}

export const subleaseDefinition: ContractTypeDefinition<SubleaseContractFields> = {
  type: 'sublease',
  documentName: '轉租合約',
  labels: LABELS,
  templates: TEMPLATES.sublease,
  optionalClauses: OPTIONAL_CLAUSE_LIBRARIES.sublease,

  party: leaseFamilyParty,
  withParty: leaseFamilyWithParty,
  partyFieldLabels: (role) => PARTY_FIELD_LABELS[role],
  missingFields: missingSubleaseFields,
  missingFieldsForSend: missingSubleaseFields,
  sendSupported: true,
  requiresProperty: true,

  initialFields: (input: InitialFieldsInput): SubleaseContractFields => leaseFamilyInitialFields('sublease', input),

  listSummary: leaseFamilyListSummary,
};
