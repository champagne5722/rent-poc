// 簽署中失效紀錄的 repository（MIL-75，第二次同步 main 時搬進 PostgreSQL）。表的說明見 db/migrations/0012_signing_lapses.sql。
//
// 形狀照 src/lib/signature-records/repository.ts：第一個參數是 withTx 給的 tx（OrgTx），
// 不傳 org_id：INSERT 取交易的 app.org_id。查詢另外帶 org_id 條件，只認目前組織（MIL-115）。
//
// 前四個函式在簽署模組的交易內被合約訂閱者呼叫（`onOutcome`），與簽署進度同一個交易。
// 另外兩個（`hasVoidPendingLapse`、`markVoidFailed`）在 `afterOutcome` 內，經 tools.inOrg 開的短交易呼叫。

import type { OrgTx } from '../pg/with-tx';
import { newUlid } from '../pg/ulid';
import type { SigningLapseDetail, SigningLapseState } from './types';

export interface NewLapse {
  contractId: string;
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
export async function recordLapse(tx: OrgTx, lapse: NewLapse): Promise<{ signerName: string } | null> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO org.signing_lapses (id, org_id, contract_id, signer_id, rule_id, state, reasons, event_at)
     SELECT $1::text, r.org_id, r.contract_id, r.signer_id, r.rule_id, $2::text, $3::jsonb, $4::timestamptz
       FROM org.signature_records r
      WHERE r.contract_id = $5 AND r.rule_id = $6 AND r.org_id = current_setting('app.org_id', true)
     ON CONFLICT (org_id, contract_id, rule_id) DO NOTHING
     RETURNING id`,
    [newUlid(), lapse.state, JSON.stringify(lapse.reasons), lapse.eventAt, lapse.contractId, lapse.ruleId],
  );
  if (rows.length === 0) return null;
  const { rows: names } = await tx.query<{ name: string }>(
    `SELECT s.name FROM org.signing_lapses l JOIN org.signers s ON s.id = l.signer_id AND s.org_id = l.org_id
      WHERE l.id = $1`,
    [rows[0].id],
  );
  return { signerName: names[0].name };
}

/** 有沒有等著自動撤回的失效紀錄。 */
export async function hasVoidPendingLapse(tx: OrgTx, contractId: string): Promise<boolean> {
  const { rows } = await tx.query(
    "SELECT 1 FROM org.signing_lapses WHERE contract_id = $1 AND org_id = current_setting('app.org_id', true) AND state = 'void_pending' LIMIT 1",
    [contractId],
  );
  return rows.length > 0;
}

/**
 * 自動撤回失敗。只有等著撤回的紀錄能轉成撤回失敗：撤回途中任務已完成或已撤回時，紀錄已被改成其他狀態，不覆蓋。
 * 回傳是否有寫入，呼叫端據此決定要不要寫歷程。
 */
export async function markVoidFailed(tx: OrgTx, contractId: string, error: string): Promise<boolean> {
  const { rows } = await tx.query(
    `UPDATE org.signing_lapses SET state = 'void_failed', void_error = $2, updated_at = now()
      WHERE contract_id = $1 AND org_id = current_setting('app.org_id', true) AND state = 'void_pending' RETURNING id`,
    [contractId, error],
  );
  return rows.length > 0;
}

/** 任務結束時結清還沒處理完的紀錄（等著撤回或撤回失敗），回傳被結清的席位姓名。 */
export async function settleOpenLapses(
  tx: OrgTx,
  contractId: string,
  to: Extract<SigningLapseState, 'voided' | 'completed_lapsed' | 'task_ended'>,
): Promise<Array<{ signerName: string }>> {
  const { rows } = await tx.query<{ signer_name: string }>(
    `WITH settled AS (
       UPDATE org.signing_lapses SET state = $2, updated_at = now()
        WHERE contract_id = $1 AND org_id = current_setting('app.org_id', true) AND state IN ('void_pending', 'void_failed')
        RETURNING id, org_id, signer_id
     )
     SELECT s.name AS signer_name
       FROM settled JOIN org.signers s ON s.id = settled.signer_id AND s.org_id = settled.org_id
      ORDER BY settled.id`,
    [contractId, to],
  );
  return rows.map((r) => ({ signerName: r.signer_name }));
}

interface LapseRow {
  id: string;
  contract_id: string;
  signer_id: string;
  signer_name: string;
  rule_id: string;
  state: string;
  reasons: string[];
  event_at: Date;
  void_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function listSigningLapses(tx: OrgTx, contractId: string): Promise<SigningLapseDetail[]> {
  const { rows } = await tx.query<LapseRow>(
    `SELECT l.id, l.contract_id, l.signer_id, s.name AS signer_name, l.rule_id, l.state, l.reasons,
            l.event_at, l.void_error, l.created_at, l.updated_at
       FROM org.signing_lapses l JOIN org.signers s ON s.id = l.signer_id AND s.org_id = l.org_id
      WHERE l.contract_id = $1 AND l.org_id = current_setting('app.org_id', true) ORDER BY l.id`,
    [contractId],
  );
  return rows.map((r) => ({
    id: r.id,
    contractId: r.contract_id,
    signerId: r.signer_id,
    signerName: r.signer_name,
    ruleId: r.rule_id,
    state: r.state as SigningLapseState,
    reasons: r.reasons,
    eventAt: r.event_at.toISOString(),
    voidError: r.void_error,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));
}
