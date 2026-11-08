// 指派與判定事實快照的 repository（MIL-69）。介面一律回傳 Promise，A 線遷移到 PostgreSQL 時只換內部。
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

export interface CredentialSnapshotInput {
  slot: string;
  practitionerId: string;
  /** 判定時點，ISO 8601。 */
  decidedAt: string;
  /** 判定用的事實，原樣保存。 */
  facts: unknown;
  /** 判定結果，原樣保存。 */
  result: unknown;
}

export async function saveCredentialSnapshots(
  contractId: number,
  snapshots: readonly CredentialSnapshotInput[],
  db: Database.Database = getDb(),
): Promise<void> {
  const upsert = db.prepare(
    `INSERT INTO contract_credential_snapshots (contract_id, slot, practitioner_id, decided_at, facts, result)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (contract_id, slot) DO UPDATE SET
       practitioner_id = excluded.practitioner_id,
       decided_at = excluded.decided_at,
       facts = excluded.facts,
       result = excluded.result`,
  );
  db.transaction(() => {
    for (const s of snapshots) {
      upsert.run(contractId, s.slot, s.practitionerId, s.decidedAt, JSON.stringify(s.facts), JSON.stringify(s.result));
    }
  })();
}

export async function listCredentialSnapshots(
  contractId: number,
  db: Database.Database = getDb(),
): Promise<CredentialSnapshotInput[]> {
  const rows = db
    .prepare('SELECT * FROM contract_credential_snapshots WHERE contract_id = ? ORDER BY slot')
    .all(contractId) as Array<{
    slot: string;
    practitioner_id: string;
    decided_at: string;
    facts: string;
    result: string;
  }>;
  return rows.map((r) => ({
    slot: r.slot,
    practitionerId: r.practitioner_id,
    decidedAt: r.decided_at,
    facts: JSON.parse(r.facts),
    result: JSON.parse(r.result),
  }));
}
