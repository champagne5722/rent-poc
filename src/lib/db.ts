import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type {
  Contract,
  ContractEvent,
  ContractEventActor,
  ContractEventType,
  ContractRelationRef,
  ContractRelations,
  ContractStatus,
  SignerRole,
} from './types';
import type { ContractType } from './labels';
import { migrateLegacyContractSigning } from './signing-module/contract-backfill';
import { ensureSignTaskFileTable } from './signing-module/sign-task-files';
import { ensureSignTaskTables } from './signing-module/sign-task-store';

export const DATA_DIR = path.join(process.cwd(), 'data');

// Next.js dev 模式下模組可能被多次載入，掛在 globalThis 上避免重複開檔
const globalForDb = globalThis as unknown as { __rentPocDb?: Database.Database };

// PoC 沒有 migration 工具，schema 一律以 CREATE TABLE / INDEX IF NOT EXISTS 表達，
// 對既有 data/rent-poc.db 相容（新表會在下次開檔時補建）。測試用 in-memory DB 也共用這份。
export function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- 物件已搬到 PostgreSQL（MIL-81），這裡存物件的 ULID，沒有外鍵。合約搬過去時（MIL-83）改複合外鍵
      property_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      fields TEXT NOT NULL DEFAULT '{}',
      signature_fields TEXT NOT NULL DEFAULT '[]',
      declined_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT
    );

    -- 合約歷程（ADR-0007）：append-only，只有 INSERT 與查詢，沒有 UPDATE／DELETE 入口
    CREATE TABLE IF NOT EXISTS contract_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contracts(id),
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_contract_events_contract ON contract_events (contract_id, id);
  `);

  // 既有資料表補欄位：SQLite 沒有 ADD COLUMN IF NOT EXISTS，先用 PRAGMA table_info 檢查再 ALTER
  addColumnIfMissing(db, 'contracts', 'derived_from', 'INTEGER REFERENCES contracts(id)');
  // 合約類型（ADR-0021 決議 2）。既有合約沒有值，DEFAULT 讓它們全部成為 lease。
  addColumnIfMissing(
    db,
    'contracts',
    'contract_type',
    "TEXT NOT NULL DEFAULT 'lease' CHECK (contract_type IN ('lease', 'management'))"
  );
  ensureSignTaskTables(db);
  ensureSignTaskFileTable(db);

  convertLegacySignerRoles(db);
  // 要在簽署角色改名之後：回填讀合約欄位的簽署人
  migrateLegacyContractSigning(db);
}

const LEGACY_SIGNER_ROLES = new Map<unknown, SignerRole>([
  ['landlord', 'party_a'],
  ['tenant', 'party_b'],
]);

/**
 * 一次性資料轉換（MIL-55、ADR-0010）：既有合約的 `signature_fields[].signer` 由舊值改新值。
 * 頁碼與座標原樣保留，也不動 updated_at，因為這不是使用者的編輯。
 * 沒有舊值的列不寫回，重跑等同 no-op。
 */
function convertLegacySignerRoles(db: Database.Database): void {
  const rows = db.prepare('SELECT id, signature_fields FROM contracts').all() as {
    id: number;
    signature_fields: string;
  }[];
  const update = db.prepare('UPDATE contracts SET signature_fields = ? WHERE id = ?');
  db.transaction(() => {
    for (const row of rows) {
      const converted = convertSignatureFieldsJson(row.signature_fields);
      if (converted !== null) update.run(converted, row.id);
    }
  })();
}

// 回傳改寫後的 JSON；不需要改寫時回 null。開檔時執行，壞資料只略過，不得擋住整個系統啟動。
function convertSignatureFieldsJson(stored: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  let changed = false;
  const converted = parsed.map((f) => {
    const signer = LEGACY_SIGNER_ROLES.get(f?.signer);
    if (!signer) return f;
    changed = true;
    return { ...f, signer };
  });
  return changed ? JSON.stringify(converted) : null;
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function createDb(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, 'rent-poc.db'));
  db.pragma('journal_mode = WAL');
  ensureSchema(db);
  return db;
}

export function getDb(): Database.Database {
  if (!globalForDb.__rentPocDb) globalForDb.__rentPocDb = createDb();
  return globalForDb.__rentPocDb;
}

// 測試用：換掉全域連線（傳 null 還原）
export function setDb(db: Database.Database | null): void {
  if (db) globalForDb.__rentPocDb = db;
  else delete globalForDb.__rentPocDb;
}

type ContractRow = Omit<Contract, 'fields' | 'signature_fields' | 'status'> & {
  fields: string;
  signature_fields: string;
  status: ContractStatus;
};

export function rowToContract(row: ContractRow): Contract {
  return {
    ...row,
    fields: JSON.parse(row.fields),
    signature_fields: JSON.parse(row.signature_fields),
  };
}

export function listContracts(): Contract[] {
  return (getDb().prepare('SELECT * FROM contracts ORDER BY id DESC').all() as ContractRow[]).map(rowToContract);
}

export function getContract(id: number): Contract | null {
  const row = getDb().prepare('SELECT * FROM contracts WHERE id = ?').get(id) as ContractRow | undefined;
  return row ? rowToContract(row) : null;
}

// --- 合約歷程（ADR-0007）---

export interface ContractEventInput {
  type: ContractEventType;
  actor: ContractEventActor;
  note?: string | null;
}

// 寫入一筆歷程事件。append-only：本模組刻意不提供更新／刪除單筆事件的函式。
export function appendContractEvent(
  contractId: number,
  event: ContractEventInput,
  db: Database.Database = getDb()
): void {
  db.prepare('INSERT INTO contract_events (contract_id, type, actor, note) VALUES (?, ?, ?, ?)').run(
    contractId,
    event.type,
    event.actor,
    event.note ?? null
  );
}

export function listContractEvents(contractId: number, db: Database.Database = getDb()): ContractEvent[] {
  return db
    .prepare('SELECT * FROM contract_events WHERE contract_id = ? ORDER BY id ASC')
    .all(contractId) as ContractEvent[];
}

export interface TransitionCommit {
  status: ContractStatus;
  event: ContractEventInput;
  declinedReason?: string | null;
}

// 狀態轉移與歷程事件同一次交易寫入（ADR-0007）：任一失敗即一起回滾。
// better-sqlite3 的 transaction 是同步的，包住即可保證原子性。
export function commitTransition(
  contractId: number,
  commit: TransitionCommit,
  db: Database.Database = getDb()
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE contracts
         SET status = ?,
             declined_reason = COALESCE(?, declined_reason),
             updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    ).run(commit.status, commit.declinedReason ?? null, contractId);
    appendContractEvent(contractId, commit.event, db);
  })();
}

// 建立合約：插入合約與「建立」事件同交易，回傳新合約 id
export function insertContractWithEvent(
  values: {
    property_id: string | null;
    fields: string;
    signature_fields?: string;
    contract_type?: ContractType;
  },
  event: ContractEventInput,
  db: Database.Database = getDb()
): number {
  return db.transaction(() => {
    const result = db
      .prepare('INSERT INTO contracts (property_id, fields, signature_fields, contract_type) VALUES (?, ?, ?, ?)')
      .run(values.property_id, values.fields, values.signature_fields ?? '[]', values.contract_type ?? 'lease');
    const id = Number(result.lastInsertRowid);
    appendContractEvent(id, event, db);
    return id;
  })();
}

// 複製為新草稿：新約記「建立」、來源記「被複製為新草稿」，同交易寫入。
// 衍生關聯（derived_from 欄位＋建立事件附註）只在撤回修約路徑記錄；
// 拒簽後的複製是純省時便利，不記衍生關聯（ADR-0006）。
export function copyContractAsDraft(source: Contract, db: Database.Database = getDb()): number {
  const isAmendment = source.status === 'voided';
  const derivedFrom = isAmendment ? source.id : null;
  const derivedNote = isAmendment ? `衍生自合約 #${source.id}（撤回後修約）` : null;
  return db.transaction(() => {
    const result = db
      .prepare(
        'INSERT INTO contracts (property_id, fields, signature_fields, derived_from, contract_type) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        source.property_id,
        JSON.stringify(source.fields),
        JSON.stringify(source.signature_fields),
        derivedFrom,
        source.contract_type
      );
    const newId = Number(result.lastInsertRowid);
    appendContractEvent(newId, { type: 'created', actor: 'landlord', note: derivedNote }, db);
    appendContractEvent(source.id, { type: 'copied', actor: 'landlord', note: `複製為新草稿：合約 #${newId}` }, db);
    return newId;
  })();
}

// 查一份合約的衍生鏈鄰居：前身＝derived_from 指向的合約，後繼＝derived_from 指向本約的合約們。
// 只回編號與狀態，供詳情頁「關聯合約」分頁連結用。
export function getContractRelations(contract: Contract, db: Database.Database = getDb()): ContractRelations {
  const predecessor = contract.derived_from
    ? ((db.prepare('SELECT id, status FROM contracts WHERE id = ?').get(contract.derived_from) as
        | ContractRelationRef
        | undefined) ?? null)
    : null;
  const successors = db
    .prepare('SELECT id, status FROM contracts WHERE derived_from = ? ORDER BY id ASC')
    .all(contract.id) as ContractRelationRef[];
  return { derived_from: predecessor, derived_contracts: successors };
}

// 刪除草稿合約：歷程隨合約走，一起刪掉（UI 沒有單獨刪事件的入口）
export function deleteContractWithEvents(contractId: number, db: Database.Database = getDb()): void {
  db.transaction(() => {
    db.prepare('DELETE FROM contract_events WHERE contract_id = ?').run(contractId);
    db.prepare('DELETE FROM contracts WHERE id = ?').run(contractId);
  })();
}
