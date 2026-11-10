// 簽章分流規則表（ADR-0018 決議 5、7）。
// 規則表是程式碼內的資料常數，只經 PR 修改，不建資料表。改順序時只改這份資料。
// 每個席位的 rule_id 是「列的 id」加「席位名」。簽署序列送簽時凍結，簽章紀錄存 rule_id 與 rule_version。
//
// 所有列的法律狀態都是「待法務確認」（MIL-62）。這裡的假設：
// - 順序原則：非業者的當事人先簽，執業人員其次，執業主體的當事人最後，經紀人排在最後（決議 4）。
// - §32 席位的證書種類是 rental_housing_manager，專任要求為 true。
// - 經紀人席位的證書種類是 real_estate_broker，專任要求為 false。經紀營業員禁止簽章（P0-12 規則 7），所以證書種類不含 real_estate_sales_agent。
// - 點交證明與退還證明的 §32 第 4、6 款，依條文文義推得。
//
// 用詞（ADR-0030 決議 2）：列的 id 沿用舊名，不改名。讀 id 時照下表換讀。
//   id 中的 master_lease        案件種類 sublease（轉租案件，舊業務類型 master_lease）
//   id 中的 lessee_master_lessor 案件種類 master_lease（包租案件，屋主租給包租業者那一份）
// 兩個 master_lease 不同義：條件裡的 `master_lease` 是新的包租案件，列 id 裡的 `master_lease` 是舊值，指轉租。
// 版本 2 之前，點交證明、押金結算單與退還證明不帶「承租人是否為包租業者」，所以包租案件沿用自管那一列（待法務確認）。

import type { StatutoryCaseKind } from '../cases';
import type { SignerRole } from '../types';
import type {
  PractitionerEntitySource,
  PractitionerRequirement,
  SignatureFieldPage,
  DocumentType,
  LeaseBusinessType,
} from './types';

/**
 * 規則表版本。任何一列的順序、角色、依據或條件改動時加一。
 * - 版本 1：條件看業務類型與「承租人是否為包租業者」（ADR-0018 決議 5）。
 * - 版本 2：條件改看案件種類（ADR-0030 決議 2、3，MIL-197）。列的 id、席位、順序與依據都沒有改。
 *   所以版本 1 凍結的 `rule_id` 與簽署區域 `slot` 在版本 2 仍然解析得到，見 `findSeatRule`。
 */
export const SIGNATURE_RULES_VERSION = 2;

/** 仍能解讀的規則表版本。版本 2 只換條件，列 id 與席位不變，所以兩個版本共用同一份規則表。 */
export const SUPPORTED_RULE_VERSIONS: readonly number[] = [1, 2];

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

/**
 * 條件：文件類型加案件種類（ADR-0030 決議 2）。
 * `businessType` 只限縮租賃案件：業務類型只留給租賃案件，分自管與代管（決議 3）。
 * 沒有寫 `businessType` 的列，租賃案件的自管與代管都適用。其他案件種類沒有業務類型，不看這個欄位。
 */
interface RuleCondition {
  documentType: DocumentType;
  caseKinds: readonly StatutoryCaseKind[];
  businessType?: LeaseBusinessType;
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
 * 押金結算單的「全部」是同一列，條件列出租賃、包租與轉租三種案件。
 */
export const SEQUENCE_RULES: readonly SequenceRule[] = [
  // 1
  {
    id: 'management.managed',
    when: { documentType: 'management', caseKinds: ['management'] },
    seats: [partyA, manager('party_b'), partyB],
    statuteRef: '§32 第 1 款',
  },
  // 2
  {
    id: 'lease.self_managed',
    when: { documentType: 'lease', caseKinds: ['lease'], businessType: 'self_managed' },
    seats: [partyB, partyA],
    statuteRef: 'P0-10 AC7（現況）',
  },
  // 3
  {
    id: 'lease.managed',
    when: { documentType: 'lease', caseKinds: ['lease'], businessType: 'managed' },
    seats: [partyB, partyA],
    statuteRef: '§32 第 2 款（代管不適用）',
  },
  // 4
  {
    id: 'lease.master_lease',
    when: { documentType: 'lease', caseKinds: ['sublease'] },
    seats: [partyB, manager('party_a', ['body', 'status_annex']), partyA],
    statuteRef: '§32 第 2、3 款',
  },
  // 5
  {
    id: 'lease.self_managed_lessee_master_lessor',
    when: { documentType: 'lease', caseKinds: ['master_lease'] },
    seats: [partyA, manager('party_b'), partyB],
    statuteRef: '§32 第 2 款（承租人是包租業者）',
  },
  // 6 是 BROKER_APPEND_RULE
  // 7
  {
    id: 'handover_certificate.self_managed',
    when: { documentType: 'handover_certificate', caseKinds: ['lease', 'master_lease'], businessType: 'self_managed' },
    seats: null,
    statuteRef: 'ADR-0016 決議 6（雙方確認）',
  },
  // 8
  {
    id: 'handover_certificate.managed',
    when: { documentType: 'handover_certificate', caseKinds: ['lease'], businessType: 'managed' },
    seats: [partyB, partyA, manager('case_mandatary')],
    statuteRef: '§32 第 4 款',
  },
  // 9
  {
    id: 'handover_certificate.master_lease',
    when: { documentType: 'handover_certificate', caseKinds: ['sublease'] },
    seats: [partyB, manager('party_a'), partyA],
    statuteRef: '§32 第 4 款',
  },
  // 10
  {
    id: 'deposit_settlement.all',
    when: { documentType: 'deposit_settlement', caseKinds: ['lease', 'master_lease', 'sublease'] },
    seats: [partyB, partyA],
    statuteRef: 'P0-18（不屬 §32）',
  },
  // 11
  {
    id: 'deposit_refund_certificate.self_managed',
    when: { documentType: 'deposit_refund_certificate', caseKinds: ['lease', 'master_lease'], businessType: 'self_managed' },
    seats: [partyB, partyA],
    statuteRef: '不屬 §32',
  },
  // 12
  {
    id: 'deposit_refund_certificate.managed',
    when: { documentType: 'deposit_refund_certificate', caseKinds: ['lease'], businessType: 'managed' },
    seats: [partyB, partyA, manager('case_mandatary')],
    statuteRef: '§32 第 6 款',
  },
  // 13
  {
    id: 'deposit_refund_certificate.master_lease',
    when: { documentType: 'deposit_refund_certificate', caseKinds: ['sublease'] },
    seats: [partyB, manager('party_a'), partyA],
    statuteRef: '§32 第 6 款',
  },
];

/** 席位 rule_id 解析出的規則列與席位名。 */
export interface FoundSeatRule {
  /** 規則列的 id，也是 `PlannedSeat.baseRuleId` 的值。 */
  rowId: string;
  /** rule_id 的最後一段：角色，或覆蓋過的席位名（經紀人席位是 broker）。 */
  seatName: string;
  /** 該列這個席位的角色。 */
  role: SignerRole;
  /** 該席位在列內的順序，從 0 起算。經紀人席位排在列之後，回傳 null。 */
  index: number | null;
}

/**
 * 由已凍結的 rule_id 與 rule_version 找回規則列與席位。簽章紀錄與簽署區域的 `slot` 存的就是 rule_id。
 * 版本 1 與版本 2 的列 id 與席位相同，所以兩個版本都解析得到。不認得的版本或 rule_id 回 null，不猜。
 */
export function findSeatRule(ruleId: string, ruleVersion: number): FoundSeatRule | null {
  if (!SUPPORTED_RULE_VERSIONS.includes(ruleVersion)) return null;
  if (ruleId === BROKER_APPEND_RULE.id) {
    return { rowId: ruleId, seatName: 'broker', role: BROKER_APPEND_RULE.seat.role, index: null };
  }
  for (const rule of SEQUENCE_RULES) {
    const index = (rule.seats ?? []).findIndex((t) => `${rule.id}.${t.seatName ?? t.role}` === ruleId);
    if (index >= 0) {
      const template = rule.seats![index];
      return { rowId: rule.id, seatName: template.seatName ?? template.role, role: template.role, index };
    }
  }
  return null;
}

export type { SequenceRule, SeatTemplate };
