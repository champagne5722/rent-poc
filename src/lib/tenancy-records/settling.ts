// 推進到押金結算（settling）的前提檢查（MIL-136、ADR-0016 決議 6、ADR-0051 決議 4、5）。
// 純函式，沒有 I/O。推進動作本身屬案件狀態機（src/lib/cases/）。
// 這裡不檢查案件是否在 move_out，也不看時間。

import { caseRuleVariantOf, isManagerOperated, type CaseRuleFacts } from '../cases';
import { handoverConfirmations, type HandoverRecordState } from './handover-record';

export interface SettlingFacts extends CaseRuleFacts {
  /** 退租點交紀錄的狀態。還沒建立是 null。 */
  moveOutRecordState: HandoverRecordState | null;
  /** 租賃代管與轉租案件的點交證明是否已全員完成簽署。租賃自管與包租案件不適用。 */
  certificateCompleted: boolean;
  /** 是否已登錄催告（一方未會同）。系統只記錄，不判定法律效果。 */
  demandNoticeRecorded: boolean;
}

export type SettlingPrerequisite =
  | 'move_out_record_missing'
  | 'lessor_unconfirmed'
  | 'lessee_unconfirmed'
  | 'certificate_incomplete';

export type SettlingResult =
  | { ok: true; via: 'both_confirmed' | 'certificate_completed' | 'demand_notice' }
  /** missing 列出主要路徑缺的前提。登錄催告是另一條路，隨時可用，所以不列在 missing。 */
  | { ok: false; missing: SettlingPrerequisite[] };

/**
 * 租賃自管與包租案件：雙方已確認（包租案件沿用自管的規則，待法務確認）。
 * 租賃代管與轉租案件：點交證明已完成。任一種都能改走登錄催告。
 * 主要路徑與催告同時成立時，回報主要路徑。案件種類或業務類型不合法時丟 RangeError。
 */
export function canAdvanceToSettling(facts: SettlingFacts): SettlingResult {
  const managerOperated = isManagerOperated(caseRuleVariantOf(facts));
  const missing: SettlingPrerequisite[] = [];

  if (!managerOperated) {
    if (facts.moveOutRecordState === null) {
      missing.push('move_out_record_missing');
    } else {
      const confirmations = handoverConfirmations(facts.moveOutRecordState);
      if (!confirmations.lessor) missing.push('lessor_unconfirmed');
      if (!confirmations.lessee) missing.push('lessee_unconfirmed');
    }
    if (missing.length === 0) return { ok: true, via: 'both_confirmed' };
  } else {
    if (facts.certificateCompleted) return { ok: true, via: 'certificate_completed' };
    missing.push('certificate_incomplete');
  }

  if (facts.demandNoticeRecorded) return { ok: true, via: 'demand_notice' };
  return { ok: false, missing };
}
