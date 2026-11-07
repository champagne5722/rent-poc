import type Database from 'better-sqlite3';
import type { ContractStatus } from '../types';
import type { SigningProviderId } from './provider';
import { insertSignTask, type NewSignTask, type SignerRecord, type SignTaskStatus } from './sign-task-store';

// 一次性回填（MIL-56、ADR-0010）：既有合約由舊的任務編號欄位建立簽署任務與簽署人。
// 只處理還沒有簽署任務的合約，所以重跑等同 no-op，也不會蓋掉之後推進的簽署進度。
// 簽署中卻沒有任務編號的合約沒有東西可回填，由簽署模組照舊處理。

interface LegacyContractRow {
  id: number;
  status: ContractStatus;
  fields: string;
  task_ref: string;
  created_at: string;
  updated_at: string | null;
}

interface LegacyEventRow {
  type: string;
  actor: string;
  created_at: string;
}

export function backfillContractSignTasks(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT c.id, c.status, c.fields, c.dottedsign_task_id AS task_ref, c.created_at, c.updated_at
         FROM contracts c
         LEFT JOIN sign_tasks t ON t.subject_type = 'contract' AND t.subject_id = CAST(c.id AS TEXT)
        WHERE t.id IS NULL AND c.dottedsign_task_id IS NOT NULL AND c.status <> 'draft'`
    )
    .all() as LegacyContractRow[];
  if (rows.length === 0) return;

  const readEvents = db.prepare('SELECT type, actor, created_at FROM contract_events WHERE contract_id = ? ORDER BY id');
  db.transaction(() => {
    for (const row of rows) {
      const task = toNewSignTask(row, readEvents.all(row.id) as LegacyEventRow[]);
      // 開檔時執行，壞資料只略過，不得擋住整個系統啟動
      if (!task || !insertSignTask(db, task)) {
        console.warn(`[signing] 合約 #${row.id} 無法回填簽署任務，已略過`);
      }
    }
  })();
}

// 一次性回填（MIL-58）：既有合約文件紀錄改以簽署任務為鍵。rel_path 原樣保留，舊檔案不搬。
// 已有紀錄的種類不動，所以重跑等同 no-op，也不會蓋掉之後補抓的結果。
// 對不到簽署任務的合約沒有東西可回填：那些合約原本就無法向服務商取文件。
export function backfillContractFiles(db: Database.Database): void {
  // INSERT ... SELECT 接 ON CONFLICT 時，SQLite 需要 WHERE 才能解析
  db.prepare(
    `INSERT INTO sign_task_files (sign_task_id, kind, status, file_name, rel_path, byte_size, content_type, error, saved_at)
     SELECT t.id, f.kind, f.status, f.file_name, f.rel_path, f.byte_size, f.content_type, f.error, f.saved_at
       FROM contract_files f
       JOIN sign_tasks t ON t.subject_type = 'contract' AND t.subject_id = CAST(f.contract_id AS TEXT)
      WHERE 1 = 1
     ON CONFLICT (sign_task_id, kind) DO NOTHING`
  ).run();
}

function toNewSignTask(row: LegacyContractRow, events: LegacyEventRow[]): NewSignTask | null {
  const fields = parseFields(row.fields);
  if (!fields) return null;
  const plan = planProgress(row, events);
  if (!plan) return null;

  return {
    provider: providerOf(row.task_ref),
    taskRef: row.task_ref,
    subject: { type: 'contract', id: row.id },
    status: plan.status,
    createdAt: events.find((e) => e.type === 'sent')?.created_at ?? row.created_at,
    updatedAt: row.updated_at,
    // 這些合約送簽時的順序就是乙先甲後。這是歷史事實，所以不共用會隨規則改變的簽署序列。
    signers: [
      { role: 'party_b', name: text(fields.tenantName), email: text(fields.tenantEmail), ...plan.partyB },
      { role: 'party_a', name: text(fields.landlordName), email: text(fields.landlordEmail), ...plan.partyA },
    ],
  };
}

// 舊資料不保證是字串，缺值或型別不對都記為空字串
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function providerOf(taskRef: string): SigningProviderId {
  return taskRef.startsWith('mock-') ? 'mock' : 'dottedsign';
}

function parseFields(stored: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

type SignerPlan = Pick<SignerRecord, 'status' | 'signedAt'>;
type ProgressPlan = { status: SignTaskStatus; partyB: SignerPlan; partyA: SignerPlan };

// 由合約狀態與合約歷程還原簽署進度。甲方的簽署沒有自己的歷程，以完成時間為準。
function planProgress(row: LegacyContractRow, events: LegacyEventRow[]): ProgressPlan | null {
  const eventOf = (type: string) => events.find((e) => e.type === type);
  const tenantSignedAt = eventOf('tenant_signed')?.created_at ?? null;
  const pending = { status: 'pending', signedAt: null } as const;
  const partyBSigned = { status: 'signed', signedAt: tenantSignedAt } as const;

  switch (row.status) {
    case 'awaiting_tenant':
      return { status: 'in_progress', partyB: pending, partyA: pending };
    case 'awaiting_landlord':
      return { status: 'in_progress', partyB: partyBSigned, partyA: pending };
    case 'completed': {
      const completedAt = eventOf('completed')?.created_at ?? row.updated_at;
      return {
        status: 'completed',
        partyB: { status: 'signed', signedAt: tenantSignedAt ?? completedAt },
        partyA: { status: 'signed', signedAt: completedAt },
      };
    }
    case 'declined':
      return eventOf('declined')?.actor === 'landlord'
        ? { status: 'declined', partyB: partyBSigned, partyA: { status: 'declined', signedAt: null } }
        : { status: 'declined', partyB: { status: 'declined', signedAt: null }, partyA: pending };
    case 'voided':
      return { status: 'voided', partyB: tenantSignedAt ? partyBSigned : pending, partyA: pending };
    default:
      return null;
  }
}
