import { contractTypeDefinition, listSummaryOf, partyOf } from './contract-types';
import {
  buildSignerSequence,
  fieldsOfSeat,
  routeSignatures,
  type RoutingFacts,
  type SeatAssignee,
  type SeatIdentity,
} from './signature-routing';
import type { Signer } from './signing-module/provider';
import { SIGNER_ROLE_LABELS, type Contract } from './types';

// 當前簽署人由簽署進度推導（ADR-0010），這裡只組送簽的輸入。
// 簽署序列由簽章分流規則表產生（ADR-0018 決議 3）。陣列順序就是簽署順序。

export type ContractSignersResult = { ok: true; signers: Signer[] } | { ok: false; status: 400; error: string };

const refuse = (error: string): ContractSignersResult => ({ ok: false, status: 400, error });

/**
 * 由分流事實與合約欄位組出送簽的簽署人。
 * 當事人的姓名與 email 取自合約欄位。執業人員的姓名與 email 由呼叫端傳入（取自登錄，MIL-69），
 * 沒有傳入的執業人員席位會在這裡擋下。資格檢查在送簽前檢查（send-preconditions），這裡不重複。
 *
 * 同一人兼任時合併成一位簽署人（ADR-0018 決議 9）。合併靠 `identities` 判定，沒有傳的席位不合併。
 *
 * @param practitioners 以席位的 rule_id 為鍵。
 * @param identities 席位簽署人的身分，以席位的 rule_id 為鍵。取自送簽前評估（evaluateSend）。
 */
export function prepareContractSigners(
  contract: Contract,
  facts: RoutingFacts,
  practitioners: Readonly<Record<string, SeatAssignee>> = {},
  identities: Readonly<Record<string, SeatIdentity | undefined>> = {}
): ContractSignersResult {
  const route = routeSignatures(facts);
  if (route.kind === 'rejected') return refuse(route.reason);
  if (route.kind === 'not_required') return refuse('這個組合不送簽，由雙方確認');

  const assignees: Record<string, SeatAssignee> = { ...practitioners };
  for (const seat of route.plan.seats) {
    if (seat.role === 'party_a' || seat.role === 'party_b') assignees[seat.ruleId] = partyOf(contract, seat.role);
    const identity = identities[seat.ruleId];
    if (identity && assignees[seat.ruleId]) assignees[seat.ruleId] = { ...assignees[seat.ruleId], identity };
  }

  const built = buildSignerSequence(route.plan, assignees, contract.signature_fields);
  if (!built.ok) {
    const roles = route.plan.seats.filter((s) => built.missing.includes(s.ruleId)).map((s) => SIGNER_ROLE_LABELS[s.role]);
    return refuse(`請先指派${[...new Set(roles)].join('、')}`);
  }

  // 每個席位都要有簽署區域。合併後一位簽署人對應多個席位，所以逐席位檢查，不逐簽署人
  const missingSeat = route.plan.seats.find((seat) => fieldsOfSeat(route.plan, seat.ruleId, contract.signature_fields).length === 0);
  if (missingSeat) return refuse(`請至少為${SIGNER_ROLE_LABELS[missingSeat.role]}設定一個簽署區域`);
  return { ok: true, signers: built.signers };
}

export function contractDocumentFileName(contract: Contract): string {
  return `${contractTypeDefinition(contract.contract_type).documentName}-${listSummaryOf(contract).propertyName || contract.id}`;
}
