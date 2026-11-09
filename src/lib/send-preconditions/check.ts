// 送簽前檢查 checkSendPreconditions(facts)（ADR-0018 決議 10，ADR-0021 決議 4）。
// 純函式，沒有 I/O，不綁合約 ID：輸入是分流事實與簽署人清單，E 線的文件也能用。
// 任一項不符就擋下，並一次列出全部原因。換證窗口內仍得送簽，期限放在 notices。
//
// 七項檢查：
//   1. 規則表有定義這個組合。
//   2. 規則要求執業人員時，有指派執業人員。ADR-0021 的過渡條件是「合約有指派」。
//      C 線完成後，這一項改成「案件有指派 practitioner 成員」，只換呼叫端組 signers 的來源。
//   3. credentialStatusAt(facts, now) 為可簽章。
//   4. 證書種類與專任要求符合規則。經紀營業員不得簽章。
//   5. 任職屬於規則指定的執業主體。
//   6. 執業人員的 email 取自其帳號。
//   7. 合併後 email 不重複。MIL-76 做合併之前，同一人兼任會因 email 重複被擋下。
//
// 另外併入 B 線的出租權源送簽前提（MIL-150）。呼叫端有權源事實才傳 `leasingAuthority`。
// 本函式不檢查簽署區域與範本審閱，那兩項由 wizard 與送簽流程各自處理。

import { credentialStatusAt, type CredentialFacts } from '../credential-status';
import { practitionerTitle, type CertificateKind } from '../labels';
import {
  checkLeasingAuthorityPreconditions,
  type LeasingAuthorityBlockReason,
  type LeasingAuthoritySendFact,
  type LeasingAuthoritySendFacts,
} from '../leasing-authority/preconditions';
import { normalizeEmail } from '../signing-module/progress';
import { routeSignatures, type PlannedSeat, type PractitionerEntitySource, type RoutingFacts } from '../signature-routing';
import { SIGNER_ROLE_LABELS } from '../types';

/** 已指派的執業人員，以及判定用的事實。`accountEmail` 是其帳號的 email。 */
export interface AssignedPractitionerFacts {
  practitionerId: string;
  accountEmail: string;
  /** null 代表沒有證書，例如負責人沒有管理人員證書。 */
  certificateKind: CertificateKind | null;
  /** 專任旗標。 */
  fullTime: boolean;
  isResponsiblePerson: boolean;
  /** 任職所屬的執業主體。 */
  employmentEntityId: string;
  credential: CredentialFacts;
}

/** 一個席位的簽署人。執業人員席位另帶 `practitioner`。 */
export interface SeatSigner {
  /** 席位的 rule_id。 */
  seatRuleId: string;
  name: string;
  email: string;
  practitioner?: AssignedPractitionerFacts;
}

export interface SendPreconditionFacts {
  routing: RoutingFacts;
  /** 判定時點，ISO 8601。送簽時是送簽當下。 */
  at: string;
  /** 規則表各個取得來源指向的執業主體 ID。過渡期取自指派時選的執業主體。 */
  entities: Partial<Record<PractitionerEntitySource, string>>;
  signers: readonly SeatSigner[];
  /** 登錄資料來源是否可用。正式金鑰下沒有真實 adapter 時是 false（ADR-0021）。 */
  registryAvailable: boolean;
  leasingAuthority?: LeasingAuthoritySendFacts;
}

export type SendBlockCode =
  | 'no_rule'
  | 'not_required'
  | 'registry_unavailable'
  | 'practitioner_not_assigned'
  | 'entity_not_selected'
  | 'credential_not_signable'
  | 'certificate_missing'
  | 'certificate_kind_not_allowed'
  | 'not_full_time'
  | 'employment_entity_mismatch'
  | 'email_not_from_account'
  | 'duplicate_email'
  // 下面三個不是七項檢查，是指派資料不完整。由組出簽署人清單的呼叫端產生（practitioner-assignment 的 evaluateSend）。
  | 'practitioner_not_found'
  | 'party_signer_not_assigned'
  | 'party_signer_mismatch'
  // 範本閘門（MIL-73），由送簽流程的 prepareContractSend 產生，不是七項檢查
  | 'template_not_reviewed'
  | LeasingAuthorityBlockReason['code'];

/** 正式金鑰下沒有真實 adapter 時，要求執業人員簽章的組合被擋下的原因（ADR-0021）。 */
export const REGISTRY_UNAVAILABLE_REASON =
  '正式環境尚未設定執業主體與執業人員的登錄資料來源，要求執業人員簽章的合約無法送簽';

export interface SendBlockReason {
  code: SendBlockCode;
  message: string;
  /** 原因屬於哪個席位。 */
  seatRuleId?: string;
}

export interface SendNotice {
  code: 'renewal_window';
  seatRuleId: string;
  validUntil: string;
  message: string;
}

export interface SendPreconditionResult {
  ok: boolean;
  reasons: SendBlockReason[];
  notices: SendNotice[];
  /** 權源未驗證的告知事實，電子簽署告知要載明（MIL-42 Q2 補充規則 1）。 */
  leasingAuthorityFacts: LeasingAuthoritySendFact[];
}

function seatLabel(seat: PlannedSeat): string {
  const kind = seat.practitioner?.certificateKinds[0];
  return kind ? `${SIGNER_ROLE_LABELS.practitioner}（${practitionerTitle(kind)}）` : SIGNER_ROLE_LABELS[seat.role];
}

function checkPractitionerSeat(
  seat: PlannedSeat,
  signer: SeatSigner | undefined,
  facts: SendPreconditionFacts,
  reasons: SendBlockReason[],
  notices: SendNotice[],
): void {
  const requirement = seat.practitioner!;
  const reason = (code: SendBlockCode, message: string) => reasons.push({ code, message, seatRuleId: seat.ruleId });

  // 第 2 項
  const assigned = signer?.practitioner;
  if (!signer || !assigned) {
    reason('practitioner_not_assigned', `尚未指派${seatLabel(seat)}`);
    return;
  }
  const name = signer.name;
  const requiredTitle = practitionerTitle(requirement.certificateKinds[0]);

  // 第 3 項
  const status = credentialStatusAt(assigned.credential, facts.at);
  if (status.signable) {
    if (status.renewalWindow) {
      const { validUntil } = status.renewalWindow;
      notices.push({
        code: 'renewal_window',
        seatRuleId: seat.ruleId,
        validUntil,
        message: `${name}的證書將於 ${validUntil} 期滿，請於期滿前換證`,
      });
    }
  } else {
    for (const issue of status.issues) reason('credential_not_signable', `${name}：${issue.message}`);
  }

  // 第 4 項
  if (assigned.certificateKind === null) {
    const prefix = assigned.isResponsiblePerson ? `${name}是負責人，但` : name;
    reason('certificate_missing', `${prefix}沒有${requiredTitle}證書`);
  } else if (assigned.certificateKind === 'real_estate_sales_agent') {
    reason('certificate_kind_not_allowed', `${name}是${practitionerTitle(assigned.certificateKind)}，不得簽章`);
  } else if (!requirement.certificateKinds.includes(assigned.certificateKind)) {
    reason(
      'certificate_kind_not_allowed',
      `${name}的證書種類（${practitionerTitle(assigned.certificateKind)}）不符合${requiredTitle}席位的要求`,
    );
  }
  if (requirement.fullTime && !assigned.fullTime) {
    reason('not_full_time', `${name}不是專任，不可擔任專任管理人員`);
  }

  // 第 5 項
  const expectedEntity = facts.entities[requirement.entitySource];
  if (expectedEntity === undefined) {
    reason('entity_not_selected', `尚未選定${seatLabel(seat)}所屬的執業主體`);
  } else if (assigned.employmentEntityId !== expectedEntity) {
    reason('employment_entity_mismatch', `${name}的任職不屬於這個席位指定的執業主體`);
  }

  // 第 6 項
  if (normalizeEmail(signer.email) !== normalizeEmail(assigned.accountEmail)) {
    reason('email_not_from_account', `${name}的 email 必須取自其帳號，不得修改`);
  }
}

function checkDuplicateEmails(
  plannedSeats: readonly PlannedSeat[],
  signers: readonly SeatSigner[],
  reasons: SendBlockReason[],
): void {
  const byEmail = new Map<string, string[]>();
  for (const seat of plannedSeats) {
    const signer = signers.find((s) => s.seatRuleId === seat.ruleId);
    if (!signer || signer.email.trim() === '') continue;
    const key = normalizeEmail(signer.email);
    byEmail.set(key, [...(byEmail.get(key) ?? []), SIGNER_ROLE_LABELS[seat.role]]);
  }
  for (const [email, roles] of byEmail) {
    if (roles.length > 1) {
      reasons.push({ code: 'duplicate_email', message: `簽署人的 email 重複：${email}（${roles.join('、')}）` });
    }
  }
}

export function checkSendPreconditions(facts: SendPreconditionFacts): SendPreconditionResult {
  const reasons: SendBlockReason[] = [];
  const notices: SendNotice[] = [];

  // 第 1 項
  const route = routeSignatures(facts.routing);
  if (route.kind === 'rejected') {
    reasons.push({ code: 'no_rule', message: route.reason });
  } else if (route.kind === 'not_required') {
    reasons.push({ code: 'not_required', message: '這個組合不送簽，由雙方確認' });
  } else {
    const seats = route.plan.seats;
    const practitionerSeats = seats.filter((seat) => seat.practitioner);
    if (practitionerSeats.length > 0 && !facts.registryAvailable) {
      reasons.push({ code: 'registry_unavailable', message: REGISTRY_UNAVAILABLE_REASON });
    } else {
      for (const seat of practitionerSeats) {
        checkPractitionerSeat(seat, facts.signers.find((s) => s.seatRuleId === seat.ruleId), facts, reasons, notices);
      }
    }
    // 第 7 項
    checkDuplicateEmails(seats, facts.signers, reasons);
  }

  let leasingAuthorityFacts: LeasingAuthoritySendFact[] = [];
  if (facts.leasingAuthority) {
    const authority = checkLeasingAuthorityPreconditions(facts.leasingAuthority);
    reasons.push(...authority.reasons);
    leasingAuthorityFacts = authority.facts;
  }

  return { ok: reasons.length === 0, reasons, notices, leasingAuthorityFacts };
}
