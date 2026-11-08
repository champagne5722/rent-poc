import { buildSignerSequence, routeSignatures, type RoutingFacts, type SeatAssignee } from './signature-routing';
import type { Signer } from './signing-module/provider';
import { SIGNER_ROLE_LABELS, type Contract } from './types';

// 當前簽署人由簽署進度推導（ADR-0010），這裡只組送簽的輸入。
// 簽署序列由簽章分流規則表產生（ADR-0018 決議 3）。陣列順序就是簽署順序。

export type ContractSignersResult = { ok: true; signers: Signer[] } | { ok: false; status: 400; error: string };

const refuse = (error: string): ContractSignersResult => ({ ok: false, status: 400, error });

/**
 * 由分流事實與合約欄位組出送簽的簽署人。
 * 當事人的姓名與 email 取自合約欄位。執業人員的指派屬 MIL-69，目前合約沒有指派欄位，
 * 所以規則要求執業人員的組合會在這裡擋下。
 */
export function prepareContractSigners(contract: Contract, facts: RoutingFacts): ContractSignersResult {
  const route = routeSignatures(facts);
  if (route.kind === 'rejected') return refuse(route.reason);
  if (route.kind === 'not_required') return refuse('這個組合不送簽，由雙方確認');

  const { fields } = contract;
  const assignees: Record<string, SeatAssignee> = {};
  for (const seat of route.plan.seats) {
    if (seat.role === 'party_a') assignees[seat.ruleId] = { name: fields.landlordName, email: fields.landlordEmail };
    if (seat.role === 'party_b') assignees[seat.ruleId] = { name: fields.tenantName, email: fields.tenantEmail };
  }

  const built = buildSignerSequence(route.plan, assignees, contract.signature_fields);
  if (!built.ok) {
    const roles = route.plan.seats.filter((s) => built.missing.includes(s.ruleId)).map((s) => SIGNER_ROLE_LABELS[s.role]);
    return refuse(`請先指派${[...new Set(roles)].join('、')}`);
  }

  const missingField = built.signers.find((s) => s.signatureFields.length === 0);
  if (missingField) return refuse(`請至少為${SIGNER_ROLE_LABELS[missingField.role]}設定一個簽署區域`);
  return { ok: true, signers: built.signers };
}

export function contractDocumentFileName(contract: Contract): string {
  return `租賃合約-${contract.fields.propertyName || contract.id}`;
}
