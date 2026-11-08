// 簽章分流規則表（ADR-0018 決議 5、7）。
// 規則表是程式碼內的資料常數，只經 PR 修改，不建資料表。改順序時只改這份資料。
// 每個席位的 rule_id 是「列的 id」加「席位名」。簽署序列送簽時凍結，簽章紀錄存 rule_id 與 rule_version。
//
// 所有列的法律狀態都是「待法務確認」（MIL-62）。這裡的假設：
// - 順序原則：非業者的當事人先簽，執業人員其次，執業主體的當事人最後，經紀人排在最後（決議 4）。
// - §32 席位的證書種類是 rental_housing_manager，專任要求為 true。
// - 經紀人席位的證書種類是 real_estate_broker，專任要求為 false。經紀營業員不得簽章（P0-12 規則 7）。
// - 點交證明與退還證明的 §32 第 4、6 款，依條文文義推得。

import type { BusinessType } from '../cases';
import type { SignerRole } from '../types';
import type {
  PractitionerEntitySource,
  PractitionerRequirement,
  SignatureFieldPage,
  DocumentType,
} from './types';

/** 規則表版本。任何一列的順序、角色或依據改動時加一。 */
export const SIGNATURE_RULES_VERSION = 1;

/** 第一版全部用 email 驗證（ADR-0018 決議 13）。改用其他方式時只改這裡。 */
export const DEFAULT_VERIFY_METHODS = ['email'] as const;

interface SeatTemplate {
  role: SignerRole;
  /** 覆蓋列的依據。經紀人席位的依據與所在列不同。 */
  statuteRef?: string;
  requiredFieldPages?: readonly SignatureFieldPage[];
  practitioner?: PractitionerRequirement;
  /** 覆蓋席位名（rule_id 的最後一段）。預設是角色。 */
  seatName?: string;
}

const partyA: SeatTemplate = { role: 'party_a' };
const partyB: SeatTemplate = { role: 'party_b' };

/** §32 的專任管理人員席位。 */
const manager = (
  entitySource: PractitionerEntitySource,
  requiredFieldPages: readonly SignatureFieldPage[] = ['body'],
): SeatTemplate => ({
  role: 'practitioner',
  requiredFieldPages,
  practitioner: { certificateKinds: ['rental_housing_manager'], fullTime: true, entitySource },
});

/** 條件。`lesseeIsMasterLessor` 只有租賃合約的列會寫。 */
interface RuleCondition {
  documentType: DocumentType;
  businessTypes: readonly BusinessType[];
  lesseeIsMasterLessor?: boolean;
}

interface SequenceRule {
  /** 列的 id，也是 rule_id 的前綴。 */
  id: string;
  when: RuleCondition;
  /** 沒有 seats 代表「不送簽，由雙方確認」。 */
  seats: readonly SeatTemplate[] | null;
  statuteRef: string;
}

/** 居間時加在租賃合約序列最後的席位（決議 5 第 6 列）。 */
export interface BrokerAppendRule {
  id: 'lease.broker';
  statuteRef: string;
  seat: SeatTemplate;
}

export const BROKER_APPEND_RULE: BrokerAppendRule = {
  id: 'lease.broker',
  statuteRef: '經紀條例 §22',
  seat: {
    role: 'practitioner',
    seatName: 'broker',
    requiredFieldPages: ['body'],
    practitioner: { certificateKinds: ['real_estate_broker'], fullTime: false, entitySource: 'broker_entity' },
  },
};

/**
 * 規則表的列：ADR-0018 決議 5 的 13 列。
 * 第 1 到 5 列與第 7 到 13 列在 SEQUENCE_RULES，第 6 列（居間）是 BROKER_APPEND_RULE。
 * 押金結算單的「全部」是同一列，條件列出三種業務類型。
 */
export const SEQUENCE_RULES: readonly SequenceRule[] = [
  // 1
  {
    id: 'management.managed',
    when: { documentType: 'management', businessTypes: ['managed'] },
    seats: [partyA, manager('party_b'), partyB],
    statuteRef: '§32 第 1 款',
  },
  // 2
  {
    id: 'lease.self_managed',
    when: { documentType: 'lease', businessTypes: ['self_managed'], lesseeIsMasterLessor: false },
    seats: [partyB, partyA],
    statuteRef: 'P0-10 AC7（現況）',
  },
  // 3
  {
    id: 'lease.managed',
    when: { documentType: 'lease', businessTypes: ['managed'], lesseeIsMasterLessor: false },
    seats: [partyB, partyA],
    statuteRef: '§32 第 2 款（代管不適用）',
  },
  // 4
  {
    id: 'lease.master_lease',
    when: { documentType: 'lease', businessTypes: ['master_lease'], lesseeIsMasterLessor: false },
    seats: [partyB, manager('party_a', ['body', 'status_annex']), partyA],
    statuteRef: '§32 第 2、3 款',
  },
  // 5
  {
    id: 'lease.self_managed_lessee_master_lessor',
    when: { documentType: 'lease', businessTypes: ['self_managed'], lesseeIsMasterLessor: true },
    seats: [partyA, manager('party_b'), partyB],
    statuteRef: '§32 第 2 款（承租人是包租業者）',
  },
  // 6 是 BROKER_APPEND_RULE
  // 7
  {
    id: 'handover_certificate.self_managed',
    when: { documentType: 'handover_certificate', businessTypes: ['self_managed'] },
    seats: null,
    statuteRef: 'ADR-0016 決議 6（雙方確認）',
  },
  // 8
  {
    id: 'handover_certificate.managed',
    when: { documentType: 'handover_certificate', businessTypes: ['managed'] },
    seats: [partyB, partyA, manager('case_mandatary')],
    statuteRef: '§32 第 4 款',
  },
  // 9
  {
    id: 'handover_certificate.master_lease',
    when: { documentType: 'handover_certificate', businessTypes: ['master_lease'] },
    seats: [partyB, manager('party_a'), partyA],
    statuteRef: '§32 第 4 款',
  },
  // 10
  {
    id: 'deposit_settlement.all',
    when: { documentType: 'deposit_settlement', businessTypes: ['self_managed', 'managed', 'master_lease'] },
    seats: [partyB, partyA],
    statuteRef: 'P0-18（不屬 §32）',
  },
  // 11
  {
    id: 'deposit_refund_certificate.self_managed',
    when: { documentType: 'deposit_refund_certificate', businessTypes: ['self_managed'] },
    seats: [partyB, partyA],
    statuteRef: '不屬 §32',
  },
  // 12
  {
    id: 'deposit_refund_certificate.managed',
    when: { documentType: 'deposit_refund_certificate', businessTypes: ['managed'] },
    seats: [partyB, partyA, manager('case_mandatary')],
    statuteRef: '§32 第 6 款',
  },
  // 13
  {
    id: 'deposit_refund_certificate.master_lease',
    when: { documentType: 'deposit_refund_certificate', businessTypes: ['master_lease'] },
    seats: [partyB, manager('party_a'), partyA],
    statuteRef: '§32 第 6 款',
  },
];

export type { SequenceRule, SeatTemplate };
