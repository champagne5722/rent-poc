import type Database from 'better-sqlite3';

// 測試用：建出 MIL-60 之前的 SQLite 合約表，給 contract-backfill.test.ts 寫入舊資料。
// 合約搬到 PostgreSQL 後（MIL-83），ensureSchema() 不再建這些表，它們只存在於舊的 data/rent-poc.db。
export function createLegacyContractTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      fields TEXT NOT NULL DEFAULT '{}',
      signature_fields TEXT NOT NULL DEFAULT '[]',
      dottedsign_task_id TEXT,
      declined_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT
    );
    CREATE TABLE contract_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contracts(id),
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE contract_files (
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
