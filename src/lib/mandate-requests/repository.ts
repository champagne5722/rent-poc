import { appendAudit } from '../audit';
import { newUlid } from '../pg/ulid';
import type { OrgTx, Tx } from '../pg/with-tx';
import type {
  MandateRequestClosedBy,
  MandateRequestCreated,
  MandateRequestDraft,
  MandateRequestKind,
  MandateRequestLinkView,
  PracticeMandateRequest,
} from '../types';
import { generateRequestCode, hashRequestCode, requestLinkPath } from './code';
import { KIND_LABEL } from './messages';
import { deadlineOf, effectiveStatus, type RequestFacts, type StoredStatus } from './status';

// 申請的資料存取（MIL-206）。申請表在 registry，app_rw 沒有權限，所有讀寫經 migration 0086 的定義者函式。
// 每個函式的政策（誰能呼叫、回什麼、為什麼）寫在 migration 的函式註解。時間由呼叫端傳入，這裡不呼叫 new Date()。

interface PracticeRow {
  request_id: string;
  kind: MandateRequestKind;
  status: StoredStatus;
  created_at: Date;
  link_expires_at: Date;
  submitted_at: Date | null;
  withdrawn_at: Date | null;
  accepted_at: Date | null;
  contract_sent_at: Date | null;
  draft: MandateRequestDraft | null;
  transcript_file_name: string | null;
  unit_count: number | null;
  manager_employment_id: string | null;
  closed_at: Date | null;
  closed_by: MandateRequestClosedBy | null;
}

export function factsOf(row: {
  status: StoredStatus;
  link_expires_at: Date;
  submitted_at: Date | null;
  accepted_at: Date | null;
  contract_sent_at: Date | null;
}): RequestFacts {
  return {
    status: row.status,
    linkExpiresAt: row.link_expires_at,
    submittedAt: row.submitted_at,
    acceptedAt: row.accepted_at,
    contractSentAt: row.contract_sent_at,
  };
}

export const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function toPracticeView(row: PracticeRow, now: Date): PracticeMandateRequest {
  const facts = factsOf(row);
  const status = effectiveStatus(facts, now);
  return {
    id: row.request_id,
    kind: row.kind,
    kind_label: KIND_LABEL[row.kind],
    status,
    created_at: row.created_at.toISOString(),
    deadline: status === 'expired' ? null : iso(deadlineOf(facts)),
    submitted_at: iso(row.submitted_at),
    withdrawn_at: iso(row.withdrawn_at),
    accepted_at: iso(row.accepted_at),
    manager_employment_id: row.manager_employment_id,
    closed_at: iso(row.closed_at),
    closed_by: row.closed_by,
    // 失效後資料庫函式已回 null，這裡不依賴它
    draft: status === 'expired' ? null : row.draft,
    transcript_file_name: status === 'expired' ? null : row.transcript_file_name,
    unit_count: row.unit_count,
  };
}

const PRACTICE_COLUMNS = `request_id, kind, status, created_at, link_expires_at, submitted_at, withdrawn_at, accepted_at,
  contract_sent_at, draft, transcript_file_name, unit_count, manager_employment_id, closed_at, closed_by`;

/**
 * 業者產生連結。碼在這裡產生，只回傳這一次。資料庫只收到雜湊。
 * 呼叫者的組織沒有通過驗證的對應業別（或不是業者）時回 null，什麼都沒寫。
 * 同交易寫稽核事件 request.create，payload 不放碼與代填內容。
 */
export async function createMandateRequest(
  tx: OrgTx,
  input: { kind: MandateRequestKind; draft: MandateRequestDraft | null; now: Date },
): Promise<MandateRequestCreated | null> {
  const id = newUlid();
  const code = generateRequestCode();
  const { rows } = await tx.query('SELECT * FROM registry.create_mandate_request($1, $2, $3, $4::jsonb, $5)', [
    id,
    input.kind,
    hashRequestCode(code),
    input.draft === null ? null : JSON.stringify(input.draft),
    input.now,
  ]);
  // 零列：沒有通過驗證的對應業別。函式什麼都沒寫，交易沒有中止
  if (rows.length === 0) return null;
  await appendAudit(tx, {
    action: 'request.create',
    object: { type: 'mandate_request', id },
    payload: { kind: input.kind, has_draft: input.draft !== null },
  });
  const view = await getPracticeRequest(tx, id, input.now);
  if (!view) throw new Error('剛建立的申請讀不到');
  return { ...view, link_path: requestLinkPath(code) };
}

/** 業者自己的申請，最新的 200 筆。 */
export async function listPracticeRequests(tx: OrgTx, now: Date): Promise<PracticeMandateRequest[]> {
  const { rows } = await tx.query<PracticeRow>(`SELECT ${PRACTICE_COLUMNS} FROM registry.mandate_requests_for_practice(NULL, $1)`, [now]);
  return rows.map((row) => toPracticeView(row, now));
}

/** 業者讀自己的一份申請。別的組織的與不存在的申請都回 null。 */
export async function getPracticeRequest(tx: OrgTx, id: string, now: Date): Promise<PracticeMandateRequest | null> {
  const { rows } = await tx.query<PracticeRow>(`SELECT ${PRACTICE_COLUMNS} FROM registry.mandate_requests_for_practice($1, $2)`, [id, now]);
  return rows[0] ? toPracticeView(rows[0], now) : null;
}

/**
 * 登入前的連結頁。無效的原因（查無此碼、過期、已收回、已被別的組織綁定、業別失效）一律回 null，不區分。
 * tx 可以是 control 脈絡（登入前）或組織脈絡。
 */
export async function getLinkView(tx: Tx, code: string, now: Date): Promise<MandateRequestLinkView | null> {
  const { rows } = await tx.query<{
    kind: MandateRequestKind;
    practice_name: string;
    tax_id: string;
    verified_kinds: string[];
    expires_at: Date;
  }>('SELECT kind, practice_name, tax_id, verified_kinds, expires_at FROM registry.mandate_request_link_view($1, $2)', [
    hashRequestCode(code),
    now,
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    kind: row.kind,
    kind_label: KIND_LABEL[row.kind],
    practice: { name: row.practice_name, tax_id: row.tax_id, verified_kinds: row.verified_kinds ?? [] },
    expires_at: row.expires_at.toISOString(),
  };
}

/** 清掉已失效申請的代填資料與謄本。回傳該刪除的 FileStore key，呼叫端在交易提交後刪檔。 */
export async function expireMandateRequests(tx: Tx, now: Date): Promise<string[]> {
  const { rows } = await tx.query<{ expire_mandate_requests: string }>('SELECT * FROM registry.expire_mandate_requests($1)', [now]);
  return rows.map((row) => row.expire_mandate_requests);
}
