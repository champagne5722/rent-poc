// 簽章分流的型別（ADR-0018 決議 3、5，ADR-0021）。純型別與常數，沒有 I/O。

import type { BusinessType, StatutoryCaseKind } from '../cases';
import type { CertificateKind } from '../labels';
import type { SignerVerifyMethod } from '../signing-module/provider';
import type { SignerRole } from '../types';

/**
 * 文件類型。`lease` 涵蓋三種租賃類合約（租賃、包租、轉租，MIL-199），案件種類由 `caseKind` 區分。`management` 與 `contracts.contract_type` 相同。
 * 後三個是 E 線的簽署標的，識別字與簽署標的的種類相同（ADR-0051 決議 1）。
 */
export const DOCUMENT_TYPES = [
  'lease',
  'management',
  'handover_certificate',
  'deposit_settlement',
  'deposit_refund_certificate',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** 租賃案件的業務類型：自管、代管（ADR-0030 決議 3）。舊值 `master_lease` 是轉租，現在是轉租案件。 */
export const LEASE_BUSINESS_TYPES = ['self_managed', 'managed'] as const satisfies readonly BusinessType[];
export type LeaseBusinessType = (typeof LEASE_BUSINESS_TYPES)[number];

/**
 * 分流事實裡的案件部分（ADR-0030 決議 2、3）。規則表看案件種類。
 * 業務類型只留給租賃案件，用來分自管與代管。其他案件種類沒有業務類型。
 */
export type CaseRoutingBasis =
  | { caseKind: 'lease'; businessType: LeaseBusinessType }
  | { caseKind: Exclude<StatutoryCaseKind, 'lease'> };

/**
 * 分流事實：`routeSignatures` 的輸入。不綁合約 ID，E 線的文件也用同一個形狀。
 * 只有租賃合約帶「是否有經紀業者居間」。
 * 「承租人是否為包租業者」不再是分流事實：它已併入案件種類 `master_lease`（包租案件，MIL-197）。
 */
export type RoutingFacts =
  | ({ documentType: 'lease'; brokerMediated: boolean } & CaseRoutingBasis)
  | ({ documentType: Exclude<DocumentType, 'lease'> } & CaseRoutingBasis);

/** 簽署區域必須落在哪一種頁：合約本文，或現況確認附件頁（ADR-0018 決議 6）。 */
export type SignatureFieldPage = 'body' | 'status_annex';

/**
 * 執業人員所屬的執業主體從哪裡取得。
 * - party_a、party_b：該文件的甲方或乙方就是執業主體。
 * - case_mandatary：代管案件的受託人（點交證明與退還證明的甲乙方是屋主與承租人）。
 * - broker_entity：居間的經紀業者。
 */
export type PractitionerEntitySource = 'party_a' | 'party_b' | 'case_mandatary' | 'broker_entity';

/** 執業人員席位的資格要求。證書種類與專任要求都是待法務確認的假設（MIL-62）。 */
export interface PractitionerRequirement {
  certificateKinds: readonly CertificateKind[];
  fullTime: boolean;
  entitySource: PractitionerEntitySource;
}

/** 簽署序列中的一個席位。`ruleId` 在同一份序列內唯一，同時是簽署區域的 `slot`（ADR-0021 決議 5）。 */
export interface PlannedSeat {
  ruleId: string;
  role: SignerRole;
  statuteRef: string;
  verifyMethods: readonly SignerVerifyMethod[];
  requiredFieldPages: readonly SignatureFieldPage[];
  /** 只有執業人員席位有。 */
  practitioner?: PractitionerRequirement;
}

export interface SignaturePlan {
  ruleVersion: number;
  /** 命中的規則列。居間加在後面時，這裡仍是原本的列。 */
  baseRuleId: string;
  seats: readonly PlannedSeat[];
}

export type RejectionCode = 'invalid_facts' | 'unknown_document_type' | 'unknown_case_kind' | 'unknown_business_type' | 'undefined_combination';

/** 分流結果：有序列、不送簽、拒絕。拒絕時沒有預設序列。 */
export type SignatureRoute =
  | { kind: 'sequence'; plan: SignaturePlan }
  | { kind: 'not_required'; ruleVersion: number; ruleId: string; statuteRef: string }
  | { kind: 'rejected'; code: RejectionCode; reason: string };
