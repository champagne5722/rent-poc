// 執業人員席位的指派規則（MIL-69）。純函式，client 與 server 都能引用。
// 席位本身（證書種類、專任、執業主體來源）來自規則表，這裡只回答「這個席位要查哪一種業別」與「哪一方是執業主體」。

import type { LicenseKind } from '../labels';
import { partyRoleOfEntitySource, type PlannedSeat, type RoutingFacts, type SignaturePlan } from '../signature-routing';
import type { ContractPartyRole } from '../types';

export { partyRoleOfEntitySource };

/**
 * 席位的執業主體要持有哪一種業別。判定事實的業別層用這一種。
 * - 經紀人席位：經紀業。
 * - 其他席位的執業主體：包租或代管，依案件種類（ADR-0030）。包租案件與轉租案件是包租業者，
 *   委託管理案件與代管的租賃案件是代管業者。
 * 回 null 代表這個組合沒有對應的業別，不應該有執業人員席位。
 */
export function licenseKindForSeat(routing: RoutingFacts, seat: PlannedSeat): LicenseKind | null {
  const requirement = seat.practitioner;
  if (!requirement) return null;
  if (requirement.entitySource === 'broker_entity') return 'brokerage';
  if (routing.caseKind === 'master_lease' || routing.caseKind === 'sublease') return 'master_lease';
  if (routing.caseKind === 'management') return 'management';
  if (routing.caseKind === 'lease' && routing.businessType === 'managed') return 'management';
  return null;
}

/** 印在簽署欄的執業人員資料：姓名、法定稱謂、執業主體，不含證號（ADR-0018 決議 14）。 */
export interface PrintedPractitioner {
  name: string;
  title?: string;
  entityName: string;
}

/** 指派的輸入。`slot` 是席位的 rule_id。 */
export interface PractitionerAssignmentInput {
  slot: string;
  entityId: string;
  practitionerId: string;
  /** 當事人簽署人。執業主體不是當事人（經紀人席位）時為 null。 */
  partySignerId: string | null;
}

/**
 * 執業主體是甲方或乙方的角色。這些角色的姓名與 email 由所選的當事人簽署人帶入，畫面不開放手填。
 */
export function entityPartyRoles(plan: SignaturePlan): ContractPartyRole[] {
  const roles = plan.seats.flatMap((seat) => {
    const role = seat.practitioner ? partyRoleOfEntitySource(seat.practitioner.entitySource) : null;
    return role ? [role] : [];
  });
  return [...new Set(roles)];
}
