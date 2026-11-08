import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { ensureSignTaskFileTable } from './signing-module/sign-task-files';
import { ensureSignTaskTables } from './signing-module/sign-task-store';

// SQLite 只剩簽署任務、簽署人與文件紀錄（MIL-85 搬走，MIL-91 移除 SQLite）。
// 物件在 PostgreSQL（MIL-81），合約與合約歷程也在 PostgreSQL（MIL-83），見 src/lib/contracts/。
// 簽署任務的 subject_id 存合約的 ULID。

export const DATA_DIR = path.join(process.cwd(), 'data');

// Next.js dev 模式下模組可能被多次載入，掛在 globalThis 上避免重複開檔
const globalForDb = globalThis as unknown as { __rentPocDb?: Database.Database };

// 沒有 migration 工具，schema 一律以 CREATE TABLE / INDEX IF NOT EXISTS 表達。測試用 in-memory DB 也共用這份。
export function ensureSchema(db: Database.Database): void {
  ensureSignTaskTables(db);
  ensureSignTaskFileTable(db);
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
