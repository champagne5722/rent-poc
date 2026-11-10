import { appendAudit } from '../audit';
import { caseRuleVariantOf, isManagerOperated, type BusinessType, type StatutoryCaseKind } from '../cases';
import type { NotifyReceipt } from '../notifications';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { listHolderConflicts, type HolderConflict } from './holder-conflicts';
import { notifyMandators } from './mandator';
import type { SocialHousingChange } from './types';

// 社宅代管案件旗標（ADR-0050 決議 10，MIL-123）。
// 旗標在 org.cases.social_housing。建立案件時標記（有委託管理案件時預設帶入它的旗標），事後修改走 changeSocialHousing()。
//
// changeSocialHousing 在呼叫端的組織交易內，同交易做四件事：改旗標、寫修改紀錄、寫稽核事件、通知委託人。
// 既有押金分錄不變。改為社宅後回傳持有人與規則的衝突清單，由畫面列出。
// 改為非社宅時，已被擋在待配對清單的列不自動釋放（屬 MIL-129、MIL-132，這裡不處理）。
// 呼叫端先 authorize()。通知的 email 要等交易提交後，才用回傳的單據呼叫 dispatchNotificationEmail。

export const MAX_REASON_LENGTH = 500;

export type ChangeSocialHousingResult =
  | {
      ok: true;
      changed: { from: boolean; to: boolean };
      /** 提交後交給 dispatchNotificationEmail。沒有 email 的單據 outboxId 是 null，可略過。 */
      receipts: NotifyReceipt[];
      /** 是否另寄 email 給委託人。案件沒有委託管理案件、或委託人沒有 email 時是 false。 */
      mandatorNotified: boolean;
      /** 改為社宅時的持有人衝突。改為非社宅時是空陣列。 */
      conflicts: HolderConflict[];
    }
  | { ok: false; error: 'case_not_found' | 'not_applicable' | 'unchanged' | 'reason_required' | 'reason_too_long' };

interface CaseRow {
  case_kind: StatutoryCaseKind;
  business_type: BusinessType | null;
  social_housing: boolean;
  title: string;
  linked_mandate_case_id: string | null;
}

const yesNo = (value: boolean) => (value ? '是' : '否');

export async function changeSocialHousing(
  tx: OrgTx,
  input: { caseId: string; value: boolean; reason: string; actorPartyId: string | null },
): Promise<ChangeSocialHousingResult> {
  const reason = input.reason.trim();
  if (reason === '') return { ok: false, error: 'reason_required' };
  if ([...reason].length > MAX_REASON_LENGTH) return { ok: false, error: 'reason_too_long' };

  // 鎖住案件列：兩個人同時改，後到的看到新值而回 unchanged
  const found = await tx.query<CaseRow>(
    `SELECT case_kind, business_type, social_housing, title, linked_mandate_case_id FROM org.cases WHERE id = $1 AND kind = 'lease' FOR UPDATE`,
    [input.caseId],
  );
  const row = found.rows[0];
  if (!row) return { ok: false, error: 'case_not_found' };
  // 自管與包租案件沒有代管業者，社宅代管的規則不適用（DHR-01 只管租賃代管）。轉租案件適用，與原本的規則相同
  if (!isManagerOperated(caseRuleVariantOf({ caseKind: row.case_kind, businessType: row.business_type }))) {
    return { ok: false, error: 'not_applicable' };
  }
  if (row.social_housing === input.value) return { ok: false, error: 'unchanged' };

  const changeId = newUlid();
  await tx.query(
    `INSERT INTO org.case_social_housing_changes (id, org_id, case_id, from_value, to_value, reason, changed_by_party_id)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6)`,
    [changeId, input.caseId, row.social_housing, input.value, reason, input.actorPartyId],
  );
  await tx.query(`UPDATE org.cases SET social_housing = $2, updated_at = now() WHERE id = $1`, [input.caseId, input.value]);
  // payload 只放 ID 與旗標值：原因是自由文字，可能含個資，canonical 寫入後刪不掉（ADR-0019 決議 5）
  await appendAudit(tx, {
    action: 'case.social_housing_change',
    object: { type: 'case', id: input.caseId },
    payload: { from: row.social_housing, to: input.value, change_id: changeId },
  });

  const title = `案件的社宅代管旗標已改為「${yesNo(input.value)}」`;
  const body = [
    `案件：${row.title || input.caseId}`,
    `原因：${reason}`,
    '社宅代管旗標會影響押金持有人的檢查規則。既有的押金分錄不會更動。',
  ].join('\n');
  // 第一則帶站內通知（主辦組織的成員看得到），之後每位委託人各一封 email。沒有委託人時只有站內通知
  const { receipts, mandatorNotified } = await notifyMandators(tx, row.linked_mandate_case_id, {
    kind: 'case.social_housing_changed',
    title,
    body,
    linkPath: `/cases/${input.caseId}`,
  });

  const conflicts = input.value ? await listHolderConflicts(tx, input.caseId) : [];
  return { ok: true, changed: { from: row.social_housing, to: input.value }, receipts, mandatorNotified, conflicts };
}

interface ChangeRow {
  id: string;
  case_id: string;
  from_value: boolean;
  to_value: boolean;
  reason: string;
  changed_by_party_id: string | null;
  changed_at: Date;
}

/** 案件的社宅旗標修改紀錄，由舊到新。 */
export async function listSocialHousingChanges(tx: OrgTx, caseId: string): Promise<SocialHousingChange[]> {
  const { rows } = await tx.query<ChangeRow>(
    `SELECT id, case_id, from_value, to_value, reason, changed_by_party_id, changed_at
       FROM org.case_social_housing_changes WHERE case_id = $1 ORDER BY id`,
    [caseId],
  );
  return rows.map((r) => ({
    id: r.id,
    caseId: r.case_id,
    fromValue: r.from_value,
    toValue: r.to_value,
    reason: r.reason,
    changedByPartyId: r.changed_by_party_id,
    changedAt: r.changed_at.toISOString(),
  }));
}

export { resolveSocialHousingDefault } from './social-housing-default';
