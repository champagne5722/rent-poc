// 簽章紀錄的 repository（MIL-70）。表的說明見 tables.ts。
//
// 兩種函式：
// - 同步函式（`insertSignatureRecords`、`completeSignSnapshot`、`listPendingSignRecords`）：
//   在簽署模組的交易內被訂閱者呼叫，所以必須同步，連線由呼叫端傳入。
//   A 線遷移 PostgreSQL 後，交易內方法改成帶 `tx`，這幾個函式跟著改成吃 `tx`。
// - 非同步函式（`listSignatureRecords`）：頁面與測試讀取用，回傳 Promise。

import type Database from 'better-sqlite3';
import { getDb } from '../db';
import type { LicenseKind } from '../labels';
import type { SignerRole } from '../types';
import type { CredentialSnapshot, SignatureSnapshot } from './snapshot';
import type { PendingSignRecord, SignatureRecord, SignatureRecordDetail, SignatureRecordInput } from './types';

/**
 * 送簽時寫入，與簽署任務同一個交易（呼叫端在 `onSent` 內呼叫）。
 * 簽署人用位置對應：簽署任務的第 `signerIndex` 位簽署人就是這一列參照的簽署人。
 * 任一列寫入失敗就拋例外，整個送簽交易回滾。
 */
export function insertSignatureRecords(
  db: Database.Database,
  contractId: number,
  records: readonly SignatureRecordInput[],
): void {
  const insert = db.prepare(
    `INSERT INTO signature_records
       (contract_id, signer_id, rule_id, statute_ref, rule_version, practitioner_id, employment_id, entity_id,
        license_kind, concurrent_roles, snapshot_at_send)
     VALUES (?, (
         SELECT s.id FROM signers s JOIN sign_tasks t ON t.id = s.sign_task_id
          WHERE t.subject_type = 'contract' AND t.subject_id = ? AND s.position = ?
       ), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of records) {
    insert.run(
      contractId,
      String(contractId),
      r.signerIndex,
      r.ruleId,
      r.statuteRef,
      r.ruleVersion,
      r.practitionerId,
      r.employmentId,
      r.entityId,
      r.licenseKind,
      JSON.stringify(r.concurrentRoles),
      JSON.stringify(r.snapshotAtSend),
    );
  }
}

/** 還沒補 snapshot_at_sign 的紀錄，含對應簽署人的 email。 */
export function listPendingSignRecords(db: Database.Database, contractId: number): PendingSignRecord[] {
  const rows = db
    .prepare(
      `SELECT r.rule_id AS ruleId, r.practitioner_id AS practitionerId, r.license_kind AS licenseKind,
              s.email AS signerEmail
         FROM signature_records r JOIN signers s ON s.id = r.signer_id
        WHERE r.contract_id = ? AND r.snapshot_at_sign IS NULL
        ORDER BY r.id`,
    )
    .all(contractId) as Array<Omit<PendingSignRecord, 'licenseKind'> & { licenseKind: string }>;
  return rows.map((r) => ({ ...r, licenseKind: r.licenseKind as LicenseKind }));
}

/** 補 snapshot_at_sign。只在還是空的時候寫入，回傳是否寫入。 */
export function completeSignSnapshot(
  db: Database.Database,
  contractId: number,
  ruleId: string,
  snapshot: SignatureSnapshot,
): boolean {
  const result = db
    .prepare(
      `UPDATE signature_records SET snapshot_at_sign = ?
        WHERE contract_id = ? AND rule_id = ? AND snapshot_at_sign IS NULL`,
    )
    .run(JSON.stringify(snapshot), contractId, ruleId);
  return result.changes > 0;
}

interface RecordRow {
  id: number;
  contract_id: number;
  signer_id: number;
  rule_id: string;
  statute_ref: string;
  rule_version: number;
  practitioner_id: string;
  employment_id: string;
  entity_id: string;
  license_kind: string;
  concurrent_roles: string;
  snapshot_at_send: string;
  snapshot_at_sign: string | null;
  created_at: string;
}

export async function listSignatureRecords(
  contractId: number,
  db: Database.Database = getDb(),
): Promise<SignatureRecord[]> {
  const rows = db
    .prepare('SELECT * FROM signature_records WHERE contract_id = ? ORDER BY id')
    .all(contractId) as RecordRow[];
  return rows.map((r) => ({
    id: r.id,
    contractId: r.contract_id,
    signerId: r.signer_id,
    ruleId: r.rule_id,
    statuteRef: r.statute_ref,
    ruleVersion: r.rule_version,
    practitionerId: r.practitioner_id,
    employmentId: r.employment_id,
    entityId: r.entity_id,
    licenseKind: r.license_kind as LicenseKind,
    concurrentRoles: JSON.parse(r.concurrent_roles) as SignerRole[],
    snapshotAtSend: JSON.parse(r.snapshot_at_send) as CredentialSnapshot,
    snapshotAtSign: r.snapshot_at_sign ? (JSON.parse(r.snapshot_at_sign) as SignatureSnapshot) : null,
    createdAt: r.created_at,
  }));
}

/** 詳情頁用：簽章紀錄加上所參照簽署人列的姓名與簽署狀態。執業主體名稱由呼叫端補。 */
export async function listSignatureRecordSigners(
  contractId: number,
  db: Database.Database = getDb(),
): Promise<Map<number, SignatureRecordDetail['signer']>> {
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.name AS name, s.role AS role, s.status AS status, s.signed_at AS signedAt
         FROM signers s JOIN signature_records r ON r.signer_id = s.id
        WHERE r.contract_id = ?`,
    )
    .all(contractId) as Array<{ id: number } & SignatureRecordDetail['signer']>;
  return new Map(rows.map(({ id, ...signer }) => [id, signer]));
}
