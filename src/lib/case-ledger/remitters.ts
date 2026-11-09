import { appendAudit } from '../audit';
import { newUlid } from '../pg/ulid';
import type { OrgTx } from '../pg/with-tx';
import { parseRemitterInput } from './remitter-input';
import type { RemitterId, RemitterKind } from './types';

// 案件的匯款識別（ADR-0050 決議 6，MIL-123）：每個租賃案件 0 到多筆，付款人戶名或付款帳號末五碼。
// 對帳檔的列依它自動配對（MIL-129）。呼叫端先 authorize()，函式不做權限判斷。
// tx 是呼叫端的組織交易，稽核事件與寫入同一個交易。稽核 payload 只放種類，不放戶名與帳號。

export type AddRemitterResult =
  | { ok: true; id: string }
  | { ok: false; error: 'invalid_input'; message: string }
  | { ok: false; error: 'case_not_found' }
  | { ok: false; error: 'duplicate' };

/** 只有主辦組織的租賃案件能登錄。看不到的案件（別的組織）與不存在的案件回應相同。 */
async function leaseCaseExists(tx: OrgTx, caseId: string): Promise<boolean> {
  const { rows } = await tx.query(`SELECT 1 FROM org.cases WHERE id = $1 AND kind = 'lease' FOR SHARE`, [caseId]);
  return rows.length > 0;
}

export async function addRemitterId(tx: OrgTx, caseId: string, raw: unknown): Promise<AddRemitterResult> {
  const parsed = parseRemitterInput(raw);
  if (!parsed.ok) return { ok: false, error: 'invalid_input', message: parsed.error };
  if (!(await leaseCaseExists(tx, caseId))) return { ok: false, error: 'case_not_found' };

  const id = newUlid();
  const { rows } = await tx.query(
    `INSERT INTO org.case_remitter_ids (id, org_id, case_id, kind, value)
     VALUES ($1, current_setting('app.org_id', true), $2, $3, $4)
     ON CONFLICT (org_id, case_id, kind, value) DO NOTHING RETURNING id`,
    [id, caseId, parsed.value.kind, parsed.value.value],
  );
  if (rows.length === 0) return { ok: false, error: 'duplicate' };
  await appendAudit(tx, {
    action: 'case_remitter.add',
    object: { type: 'case', id: caseId },
    payload: { remitter_id: id, kind: parsed.value.kind },
  });
  return { ok: true, id };
}

interface Row {
  id: string;
  case_id: string;
  kind: RemitterKind;
  value: string;
  created_at: Date;
}

/** 案件的匯款識別，依登錄順序（ULID 單調遞增）。 */
export async function listRemitterIds(tx: OrgTx, caseId: string): Promise<RemitterId[]> {
  const { rows } = await tx.query<Row>(
    `SELECT id, case_id, kind, value, created_at FROM org.case_remitter_ids WHERE case_id = $1 ORDER BY id`,
    [caseId],
  );
  return rows.map((r) => ({ id: r.id, caseId: r.case_id, kind: r.kind, value: r.value, createdAt: r.created_at.toISOString() }));
}

/** 移除一筆匯款識別。回傳是否真的移除：識別不屬於這個案件、別的組織的識別、已移除的，都回 false。 */
export async function removeRemitterId(tx: OrgTx, caseId: string, remitterId: string): Promise<boolean> {
  const { rows } = await tx.query<{ kind: RemitterKind }>(
    `DELETE FROM org.case_remitter_ids WHERE id = $1 AND case_id = $2 RETURNING kind`,
    [remitterId, caseId],
  );
  if (rows.length === 0) return false;
  await appendAudit(tx, {
    action: 'case_remitter.remove',
    object: { type: 'case', id: caseId },
    payload: { remitter_id: remitterId, kind: rows[0].kind },
  });
  return true;
}
