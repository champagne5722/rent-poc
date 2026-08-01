import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { Contract, ContractStatus, Property } from './types';

const DATA_DIR = path.join(process.cwd(), 'data');

// Next.js dev 模式下模組可能被多次載入，掛在 globalThis 上避免重複開檔
const globalForDb = globalThis as unknown as { __rentPocDb?: Database.Database };

function createDb(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, 'rent-poc.db'));
  db.pragma('journal_mode = WAL');
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
  `);
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
