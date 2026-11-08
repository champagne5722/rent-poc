import type Database from 'better-sqlite3';

// 測試用：把資料庫退回 MIL-60 之前的形式，模擬已部署過的資料庫。
// 下一次 ensureSchema() 會先回填，再移除這兩個舊形式。
export function restoreLegacySigningSchema(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(contracts)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'dottedsign_task_id')) {
    db.exec('ALTER TABLE contracts ADD COLUMN dottedsign_task_id TEXT');
  }
  db.exec(`
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
