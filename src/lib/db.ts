import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { Contract, ContractFile, ContractFileKind, ContractStatus, Property } from './types';

export const DATA_DIR = path.join(process.cwd(), 'data');

// Next.js dev 模式下模組可能被多次載入，掛在 globalThis 上避免重複開檔
const globalForDb = globalThis as unknown as { __rentPocDb?: Database.Database };

// schema 與開檔分離：測試用 in-memory DB 也能建出同一份 schema
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

    -- 合約完成時保存的已簽 PDF 與 Audit Trail File（檔案本體在 data/contract-files/ 下）
    CREATE TABLE IF NOT EXISTS contract_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contracts(id),
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'saved',
      file_name TEXT NOT NULL,
      rel_path TEXT,
      byte_size INTEGER,
      content_type TEXT,
      error TEXT,
      saved_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE (contract_id, kind)
    );
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

// 測試用：換掉全域連線（傳 null 還原）
export function setDb(db: Database.Database | null): void {
  if (db) globalForDb.__rentPocDb = db;
  else delete globalForDb.__rentPocDb;
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

export function updateContractStatus(id: number, status: ContractStatus, declinedReason?: string) {
  getDb()
    .prepare(
      "UPDATE contracts SET status = ?, declined_reason = COALESCE(?, declined_reason), updated_at = datetime('now', 'localtime') WHERE id = ?"
    )
    .run(status, declinedReason ?? null, id);
}

export function findContractByTaskId(taskId: string): Contract | null {
  const row = getDb().prepare('SELECT * FROM contracts WHERE dottedsign_task_id = ?').get(taskId) as
    | ContractRow
    | undefined;
  return row ? rowToContract(row) : null;
}

// ── 合約文件（已簽 PDF／Audit Trail File）─────────────────────────────

export type ContractFileInput = Omit<ContractFile, 'id' | 'saved_at'>;

// 一份合約的每種檔案只留一筆：補抓成功會覆蓋先前的失敗紀錄
export function upsertContractFile(file: ContractFileInput): void {
  getDb()
    .prepare(
      `INSERT INTO contract_files (contract_id, kind, status, file_name, rel_path, byte_size, content_type, error, saved_at)
       VALUES (@contract_id, @kind, @status, @file_name, @rel_path, @byte_size, @content_type, @error, datetime('now', 'localtime'))
       ON CONFLICT (contract_id, kind) DO UPDATE SET
         status = excluded.status,
         file_name = excluded.file_name,
         rel_path = excluded.rel_path,
         byte_size = excluded.byte_size,
         content_type = excluded.content_type,
         error = excluded.error,
         saved_at = excluded.saved_at`
    )
    .run(file);
}

export function getContractFile(contractId: number, kind: ContractFileKind): ContractFile | null {
  const row = getDb().prepare('SELECT * FROM contract_files WHERE contract_id = ? AND kind = ?').get(contractId, kind) as
    | ContractFile
    | undefined;
  return row ?? null;
}

export function listContractFiles(contractId: number): ContractFile[] {
  return getDb().prepare('SELECT * FROM contract_files WHERE contract_id = ? ORDER BY kind').all(contractId) as ContractFile[];
}
