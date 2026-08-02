import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type {
  Contract,
  ContractEvent,
  ContractEventActor,
  ContractEventType,
  ContractStatus,
  Property,
} from './types';

const DATA_DIR = path.join(process.cwd(), 'data');

// Next.js dev 模式下模組可能被多次載入，掛在 globalThis 上避免重複開檔
const globalForDb = globalThis as unknown as { __rentPocDb?: Database.Database };

// PoC 沒有 migration 工具，schema 一律以 CREATE TABLE / INDEX IF NOT EXISTS 表達，
// 對既有 data/rent-poc.db 相容（新表會在下次開檔時補建）。測試用 in-memory DB 也共用這份。
export function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '整層住家',
      size REAL,
      default_rent INTEGER,
      note TEXT NOT NULL DEFAULT '',
      equipment TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER REFERENCES properties(id),
      status TEXT NOT NULL DEFAULT 'draft',
      fields TEXT NOT NULL DEFAULT '{}',
      signature_fields TEXT NOT NULL DEFAULT '[]',
      dottedsign_task_id TEXT,
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

type PropertyRow = Omit<Property, 'equipment'> & { equipment: string };
type ContractRow = Omit<Contract, 'fields' | 'signature_fields' | 'status'> & {
  fields: string;
  signature_fields: string;
  status: ContractStatus;
};

export function rowToProperty(row: PropertyRow): Property {
  return { ...row, equipment: JSON.parse(row.equipment) };
}

export function rowToContract(row: ContractRow): Contract {
  return {
    ...row,
    fields: JSON.parse(row.fields),
    signature_fields: JSON.parse(row.signature_fields),
  };
}

export function listProperties(): Property[] {
  return (getDb().prepare('SELECT * FROM properties ORDER BY id DESC').all() as PropertyRow[]).map(rowToProperty);
}

export function getProperty(id: number): Property | null {
  const row = getDb().prepare('SELECT * FROM properties WHERE id = ?').get(id) as PropertyRow | undefined;
  return row ? rowToProperty(row) : null;
}

export function listContracts(): Contract[] {
  return (getDb().prepare('SELECT * FROM contracts ORDER BY id DESC').all() as ContractRow[]).map(rowToContract);
}

export function getContract(id: number): Contract | null {
  const row = getDb().prepare('SELECT * FROM contracts WHERE id = ?').get(id) as ContractRow | undefined;
  return row ? rowToContract(row) : null;
}

export function findContractByTaskId(taskId: string): Contract | null {
  const row = getDb().prepare('SELECT * FROM contracts WHERE dottedsign_task_id = ?').get(taskId) as
    | ContractRow
    | undefined;
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
  dottedsignTaskId?: string | null;
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
             dottedsign_task_id = COALESCE(?, dottedsign_task_id),
             updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    ).run(commit.status, commit.declinedReason ?? null, commit.dottedsignTaskId ?? null, contractId);
    appendContractEvent(contractId, commit.event, db);
  })();
}

// 建立合約：插入合約與「建立」事件同交易，回傳新合約 id
export function insertContractWithEvent(
  values: {
    property_id: number | null;
    fields: string;
    signature_fields?: string;
  },
  event: ContractEventInput,
  db: Database.Database = getDb()
): number {
  return db.transaction(() => {
    const result = db
      .prepare('INSERT INTO contracts (property_id, fields, signature_fields) VALUES (?, ?, ?)')
      .run(values.property_id, values.fields, values.signature_fields ?? '[]');
    const id = Number(result.lastInsertRowid);
    appendContractEvent(id, event, db);
    return id;
  })();
}

// 複製為新草稿：新約記「建立」、來源記「被複製為新草稿」，同交易寫入。
// 衍生來源附註只在撤回修約路徑記錄；拒簽後的複製是純省時便利，不記衍生關聯（ADR-0006）。
export function copyContractAsDraft(source: Contract, db: Database.Database = getDb()): number {
  const derivedNote = source.status === 'voided' ? `衍生自合約 #${source.id}（撤回後修約）` : null;
  return db.transaction(() => {
    const result = db
      .prepare('INSERT INTO contracts (property_id, fields, signature_fields) VALUES (?, ?, ?)')
      .run(source.property_id, JSON.stringify(source.fields), JSON.stringify(source.signature_fields));
    const newId = Number(result.lastInsertRowid);
    appendContractEvent(newId, { type: 'created', actor: 'landlord', note: derivedNote }, db);
    appendContractEvent(source.id, { type: 'copied', actor: 'landlord', note: `複製為新草稿：合約 #${newId}` }, db);
    return newId;
  })();
}

// 刪除草稿合約：歷程隨合約走，一起刪掉（UI 沒有單獨刪事件的入口）
export function deleteContractWithEvents(contractId: number, db: Database.Database = getDb()): void {
  db.transaction(() => {
    db.prepare('DELETE FROM contract_events WHERE contract_id = ?').run(contractId);
    db.prepare('DELETE FROM contracts WHERE id = ?').run(contractId);
  })();
}
