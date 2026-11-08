import type { Tx } from '../pg/with-tx';
import { isAuditAction, type AuditAction } from './actions';

// 寫稽核事件的唯一入口（ADR-0019 決議 2、3，MIL-82）。只呼叫資料庫函式 audit.append()。
//
// 介面的規則：
// - 鏈由交易的 app.org_id 決定，這裡沒有參數可以指定。沒有組織脈絡（control、party 脈絡，
//   或 org_id 為空字串）時寫平台組織的鏈。
// - 必須在業務資料的同一個交易內呼叫，用呼叫端自己的 tx。交易回滾時事件跟著回滾，序號不推進。
// - 同一條鏈的寫入在鏈頭的列鎖排隊，直到提交。交易要短，callback 內不得有外部呼叫（withTx 的規則）。
// - payload 只放變更前後的關鍵欄位，不得放個資：canonical 寫入後刪不掉（ADR-0019 決議 5）。
// - 行為者從脈絡取：operator 脈絡是營運者，帶 partyId 的 org 脈絡是該使用者，其餘是系統。
//   登入前的動作（脈絡裡沒有行為者）才明確指定 actor。

/** 明確指定行為者只允許這兩種。營運者來自交易脈絡，由資料庫決定。 */
export type AuditActorType = 'party' | 'system';

export interface AuditEntry {
  action: AuditAction;
  /** 被操作的物件。 */
  object?: { type: string; id: string };
  payload?: Record<string, unknown>;
  /** 只在脈絡沒有行為者時指定，例如承租人登入。 */
  actor?: { type: AuditActorType; id?: string };
}

/** 事件在鏈上的位置。`consent_audit_ref` 之類的欄位存 chainId 與 seq。 */
export interface AuditRef {
  chainId: string;
  seq: number;
  hash: string;
}

interface RefRow {
  chain_id: string;
  seq: string; // bigint 在 pg 回傳字串
  hash: string;
}

export function toAuditRef(row: RefRow): AuditRef {
  const seq = Number(row.seq);
  if (!Number.isSafeInteger(seq)) throw new Error(`稽核序號超出安全整數範圍：${row.seq}`);
  return { chainId: row.chain_id, seq, hash: row.hash };
}

export async function appendAudit(tx: Tx, entry: AuditEntry): Promise<AuditRef> {
  if (!isAuditAction(entry.action)) {
    throw new Error(`稽核動作 ${String(entry.action)} 不在 AUDIT_ACTIONS 清單內，請先到 src/lib/audit/actions.ts 新增`);
  }
  const { rows } = await tx.query<RefRow>(
    `SELECT chain_id, seq::text AS seq, hash FROM audit.append($1, $2, $3, $4::jsonb, $5, $6)`,
    [
      entry.action,
      entry.object?.type ?? null,
      entry.object?.id ?? null,
      JSON.stringify(entry.payload ?? {}),
      entry.actor?.type ?? null,
      entry.actor?.id ?? null,
    ],
  );
  return toAuditRef(rows[0]);
}
