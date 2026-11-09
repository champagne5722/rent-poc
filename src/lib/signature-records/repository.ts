// 簽章紀錄的 repository（MIL-70，同步 main 時搬進 PostgreSQL）。表的說明見 db/migrations/0009_signature_records.sql。
//
// 形狀照 src/lib/contracts/repository.ts：第一個參數是 withTx 給的 tx（OrgTx），
// 不傳 org_id：INSERT 取交易的 app.org_id，查詢靠 RLS 篩選。別的組織的合約和不存在的合約沒有差別。
//
// 前三個函式在簽署模組的交易內被合約訂閱者呼叫（`onSent`、`onOutcome`），與簽署進度同一個交易。
// 快照欄位是 jsonb，讀出來就是物件。

import type { LicenseKind } from '../labels';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import type { SignerRole } from '../types';
import type { CredentialSnapshot, SignatureSnapshot } from './snapshot';
import type { PendingSignRecord, SignatureRecord, SignatureRecordDetail, SignatureRecordInput } from './types';

/**
 * 送簽時寫入，與簽署任務同一個交易（呼叫端在 `onSent` 內呼叫）。
 * 簽署人用位置對應：簽署任務的第 `signerIndex` 位簽署人就是這一列參照的簽署人。
 * 任一列寫入失敗就拋例外，整個送簽交易回滾。對不到簽署人時 signer_id 為空，違反 NOT NULL 而失敗。
 */
export async function insertSignatureRecords(
  tx: OrgTx,
  contractId: string,
  records: readonly SignatureRecordInput[],
): Promise<void> {
  for (const r of records) {
    await tx.query(
      `INSERT INTO org.signature_records
         (id, org_id, contract_id, signer_id, rule_id, statute_ref, rule_version, practitioner_id, employment_id,
          entity_id, license_kind, concurrent_roles, snapshot_at_send)
       VALUES ($1, current_setting('app.org_id', true), $2, (
           SELECT s.id FROM org.signers s JOIN org.sign_tasks t ON t.id = s.sign_task_id AND t.org_id = s.org_id
            WHERE t.subject_type = 'contract' AND t.subject_id = $2 AND s.position = $3
         ), $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)`,
      [
        newUlid(),
        contractId,
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
      ],
    );
  }
}

/** 還沒補 snapshot_at_sign 的紀錄，含對應簽署人的 email。 */
export async function listPendingSignRecords(tx: OrgTx, contractId: string): Promise<PendingSignRecord[]> {
  const { rows } = await tx.query<{ ruleId: string; practitionerId: string; licenseKind: string; signerEmail: string }>(
    `SELECT r.rule_id AS "ruleId", r.practitioner_id AS "practitionerId", r.license_kind AS "licenseKind",
            s.email AS "signerEmail"
       FROM org.signature_records r JOIN org.signers s ON s.id = r.signer_id AND s.org_id = r.org_id
      WHERE r.contract_id = $1 AND r.snapshot_at_sign IS NULL
      ORDER BY r.id`,
    [contractId],
  );
  return rows.map((r) => ({ ...r, licenseKind: r.licenseKind as LicenseKind }));
}

/** 補 snapshot_at_sign。只在還是空的時候寫入，回傳是否寫入。 */
export async function completeSignSnapshot(
  tx: OrgTx,
  contractId: string,
  ruleId: string,
  snapshot: SignatureSnapshot,
): Promise<boolean> {
  const { rows } = await tx.query(
    `UPDATE org.signature_records SET snapshot_at_sign = $3::jsonb
      WHERE contract_id = $1 AND rule_id = $2 AND snapshot_at_sign IS NULL RETURNING id`,
    [contractId, ruleId, JSON.stringify(snapshot)],
  );
  return rows.length > 0;
}

interface RecordRow {
  id: string;
  contract_id: string;
  signer_id: string;
  rule_id: string;
  statute_ref: string;
  rule_version: number;
  practitioner_id: string;
  employment_id: string;
  entity_id: string;
  license_kind: string;
  concurrent_roles: SignerRole[];
  snapshot_at_send: CredentialSnapshot;
  snapshot_at_sign: SignatureSnapshot | null;
  created_at: Date;
}

export async function listSignatureRecords(tx: OrgTx, contractId: string): Promise<SignatureRecord[]> {
  const { rows } = await tx.query<RecordRow>(
    `SELECT id, contract_id, signer_id, rule_id, statute_ref, rule_version, practitioner_id, employment_id,
            entity_id, license_kind, concurrent_roles, snapshot_at_send, snapshot_at_sign, created_at
       FROM org.signature_records WHERE contract_id = $1 ORDER BY id`,
    [contractId],
  );
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
    concurrentRoles: r.concurrent_roles,
    snapshotAtSend: r.snapshot_at_send,
    snapshotAtSign: r.snapshot_at_sign,
    createdAt: r.created_at.toISOString(),
  }));
}

/** 詳情頁用：簽章紀錄所參照簽署人列的姓名與簽署狀態，以簽署人 ID 為鍵。執業主體名稱由呼叫端補。 */
export async function listSignatureRecordSigners(
  tx: OrgTx,
  contractId: string,
): Promise<Map<string, SignatureRecordDetail['signer']>> {
  const { rows } = await tx.query<{
    id: string;
    name: string;
    role: SignerRole;
    status: SignatureRecordDetail['signer']['status'];
    signed_at: Date | null;
  }>(
    `SELECT s.id, s.name, s.role, s.status, s.signed_at
       FROM org.signers s JOIN org.signature_records r ON r.signer_id = s.id AND r.org_id = s.org_id
      WHERE r.contract_id = $1`,
    [contractId],
  );
  return new Map(
    rows.map((r) => [
      r.id,
      { name: r.name, role: r.role, status: r.status, signedAt: r.signed_at ? r.signed_at.toISOString() : null },
    ]),
  );
}
