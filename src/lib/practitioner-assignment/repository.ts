// 指派的 repository（MIL-69）。判定事實快照在 MIL-70 改由簽章紀錄承接，見 src/lib/signature-records/。介面一律回傳 Promise，A 線遷移到 PostgreSQL 時只換內部。
// 表的說明見 tables.ts。

import type Database from 'better-sqlite3';
import { getDb } from '../db';
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
  assigned_at: string;
}

export async function getAssignments(
  contractId: number,
  db: Database.Database = getDb(),
): Promise<PractitionerAssignment[]> {
  const rows = db
    .prepare('SELECT * FROM contract_practitioner_assignments WHERE contract_id = ? ORDER BY slot')
    .all(contractId) as AssignmentRow[];
  return rows.map((r) => ({
    slot: r.slot,
    entityId: r.entity_id,
    practitionerId: r.practitioner_id,
    partySignerId: r.party_signer_id,
    assignedAt: r.assigned_at,
  }));
}

/** 整批取代。改派與取消都走這裡，不留舊資料。同一個席位出現兩次時整批拒絕。 */
export async function replaceAssignments(
  contractId: number,
  assignments: readonly PractitionerAssignmentInput[],
  db: Database.Database = getDb(),
): Promise<void> {
  db.transaction(() => {
    db.prepare('DELETE FROM contract_practitioner_assignments WHERE contract_id = ?').run(contractId);
    const insert = db.prepare(
      `INSERT INTO contract_practitioner_assignments (contract_id, slot, entity_id, practitioner_id, party_signer_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const a of assignments) insert.run(contractId, a.slot, a.entityId, a.practitionerId, a.partySignerId);
  })();
}

/** 複製為新草稿時沿用指派。送簽前仍會重新檢查，所以失效的人不會被帶過去簽。 */
export async function copyAssignments(
  fromContractId: number,
  toContractId: number,
  db: Database.Database = getDb(),
): Promise<void> {
  db.prepare(
    `INSERT INTO contract_practitioner_assignments (contract_id, slot, entity_id, practitioner_id, party_signer_id)
     SELECT ?, slot, entity_id, practitioner_id, party_signer_id
       FROM contract_practitioner_assignments WHERE contract_id = ?`,
  ).run(toContractId, fromContractId);
}
