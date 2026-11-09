// 指派的 repository（MIL-69 建立，MIL-85 搬進 PostgreSQL）。判定事實快照在 MIL-70 改由簽章紀錄承接，見 src/lib/signature-records/。
// 表的說明見 db/migrations/0005_practitioner_assignments.sql。
//
// 形狀照 src/lib/contracts/repository.ts：第一個參數是 withTx 給的 tx（OrgTx），
// 不傳 org_id：INSERT 取交易的 app.org_id，查詢靠 RLS 篩選。別的組織的合約和不存在的合約沒有差別。

import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { PractitionerAssignmentInput } from './seats';

export type { PractitionerAssignmentInput };

export interface PractitionerAssignment extends PractitionerAssignmentInput {
  assignedAt: string;
}

interface AssignmentRow {
  slot: string;
  entity_id: string;
  practitioner_id: string;
  party_signer_id: string | null;
  assigned_at: Date;
}

export async function getAssignments(tx: OrgTx, contractId: string): Promise<PractitionerAssignment[]> {
  const { rows } = await tx.query<AssignmentRow>(
    `SELECT slot, entity_id, practitioner_id, party_signer_id, assigned_at
       FROM org.contract_practitioner_assignments WHERE contract_id = $1 ORDER BY slot`,
    [contractId],
  );
  return rows.map((r) => ({
    slot: r.slot,
    entityId: r.entity_id,
    practitionerId: r.practitioner_id,
    partySignerId: r.party_signer_id,
    assignedAt: r.assigned_at.toISOString(),
  }));
}

const INSERT_ASSIGNMENT = `INSERT INTO org.contract_practitioner_assignments
    (id, org_id, contract_id, slot, entity_id, practitioner_id, party_signer_id)
  VALUES ($1, current_setting('app.org_id', true), $2, $3, $4, $5, $6)`;

/**
 * 整批取代。改派與取消都走這裡，不留舊資料。同一個席位出現兩次時整批拒絕（唯一鍵），交易回滾。
 * 合約不存在（含別的組織的合約）時複合外鍵擋下。
 */
export async function replaceAssignments(
  tx: OrgTx,
  contractId: string,
  assignments: readonly PractitionerAssignmentInput[],
): Promise<void> {
  await tx.query('DELETE FROM org.contract_practitioner_assignments WHERE contract_id = $1', [contractId]);
  for (const a of assignments) {
    await tx.query(INSERT_ASSIGNMENT, [newUlid(), contractId, a.slot, a.entityId, a.practitionerId, a.partySignerId]);
  }
}

/** 複製為新草稿時沿用指派。送簽前仍會重新檢查，所以失效的人不會被帶過去簽。 */
export async function copyAssignments(tx: OrgTx, fromContractId: string, toContractId: string): Promise<void> {
  const { rows } = await tx.query<Omit<AssignmentRow, 'assigned_at'>>(
    `SELECT slot, entity_id, practitioner_id, party_signer_id
       FROM org.contract_practitioner_assignments WHERE contract_id = $1 ORDER BY slot`,
    [fromContractId],
  );
  for (const r of rows) {
    await tx.query(INSERT_ASSIGNMENT, [newUlid(), toContractId, r.slot, r.entity_id, r.practitioner_id, r.party_signer_id]);
  }
}
