// 簽署中失效紀錄的 repository（MIL-75）。表的說明見 tables.ts。
//
// 兩種函式：
// - 同步函式：在簽署模組的交易內被訂閱者呼叫，所以必須同步，連線由呼叫端傳入。
//   A 線遷移 PostgreSQL 後，交易內方法改成帶 `tx`，這幾個函式跟著改成吃 `tx`。
// - 非同步函式（`listSigningLapses`）：頁面與測試讀取用，回傳 Promise。

import type Database from 'better-sqlite3';
import { getDb } from '../db';
import type { SigningLapseDetail, SigningLapseState } from './types';

export interface NewLapse {
  contractId: number;
  ruleId: string;
  /** 任務未結束是 void_pending，任務已全員完成是 completed_lapsed。 */
  state: Extract<SigningLapseState, 'void_pending' | 'completed_lapsed'>;
  reasons: string[];
  eventAt: string;
}

/**
 * 記下一個席位的失效事實。同一個席位只記一次：已有紀錄時回 null，呼叫端不重複寫歷程、不重複撤回。
 * 成功時回簽署人姓名，給歷程附註用。簽署人用簽章紀錄參照的簽署人列。
 */
export function recordLapse(db: Database.Database, lapse: NewLapse): { signerName: string } | null {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO signing_lapses (contract_id, signer_id, rule_id, state, reasons, event_at)
       SELECT r.contract_id, r.signer_id, r.rule_id, ?, ?, ?
         FROM signature_records r
        WHERE r.contract_id = ? AND r.rule_id = ?`,
    )
    .run(lapse.state, JSON.stringify(lapse.reasons), lapse.eventAt, lapse.contractId, lapse.ruleId);
  if (result.changes === 0) return null;
  const row = db
    .prepare(
      `SELECT s.name AS name FROM signing_lapses l JOIN signers s ON s.id = l.signer_id
        WHERE l.contract_id = ? AND l.rule_id = ?`,
    )
    .get(lapse.contractId, lapse.ruleId) as { name: string };
  return { signerName: row.name };
}

/** 有沒有等著自動撤回的失效紀錄。 */
export function hasVoidPendingLapse(db: Database.Database, contractId: number): boolean {
  return Boolean(db.prepare("SELECT 1 FROM signing_lapses WHERE contract_id = ? AND state = 'void_pending'").get(contractId));
}

/**
 * 自動撤回失敗。只有等著撤回的紀錄能轉成撤回失敗：撤回途中任務已完成或已撤回時，紀錄已被改成其他狀態，不覆蓋。
 * 回傳是否有寫入，呼叫端據此決定要不要寫歷程。
 */
export function markVoidFailed(db: Database.Database, contractId: number, error: string): boolean {
  const result = db
    .prepare(
      `UPDATE signing_lapses SET state = 'void_failed', void_error = ?, updated_at = datetime('now', 'localtime')
        WHERE contract_id = ? AND state = 'void_pending'`,
    )
    .run(error, contractId);
  return result.changes > 0;
}

/** 任務結束時結清還沒處理完的紀錄（等著撤回或撤回失敗），回傳被結清的席位姓名。 */
export function settleOpenLapses(
  db: Database.Database,
  contractId: number,
  to: Extract<SigningLapseState, 'voided' | 'completed_lapsed' | 'task_ended'>,
): Array<{ signerName: string }> {
  const open = db
    .prepare(
      `SELECT l.id AS id, s.name AS signerName
         FROM signing_lapses l JOIN signers s ON s.id = l.signer_id
        WHERE l.contract_id = ? AND l.state IN ('void_pending', 'void_failed')`,
    )
    .all(contractId) as Array<{ id: number; signerName: string }>;
  const update = db.prepare("UPDATE signing_lapses SET state = ?, updated_at = datetime('now', 'localtime') WHERE id = ?");
  for (const row of open) update.run(to, row.id);
  return open.map(({ signerName }) => ({ signerName }));
}

interface LapseRow {
  id: number;
  contract_id: number;
  signer_id: number;
  signer_name: string;
  rule_id: string;
  state: string;
  reasons: string;
  event_at: string;
  void_error: string | null;
  created_at: string;
  updated_at: string;
}

export async function listSigningLapses(
  contractId: number,
  db: Database.Database = getDb(),
): Promise<SigningLapseDetail[]> {
  const rows = db
    .prepare(
      `SELECT l.*, s.name AS signer_name
         FROM signing_lapses l JOIN signers s ON s.id = l.signer_id
        WHERE l.contract_id = ? ORDER BY l.id`,
    )
    .all(contractId) as LapseRow[];
  return rows.map((r) => ({
    id: r.id,
    contractId: r.contract_id,
    signerId: r.signer_id,
    signerName: r.signer_name,
    ruleId: r.rule_id,
    state: r.state as SigningLapseState,
    reasons: JSON.parse(r.reasons) as string[],
    eventAt: r.event_at,
    voidError: r.void_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}
