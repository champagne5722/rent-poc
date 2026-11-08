import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SqlExecutor } from './executor';

// 自寫的 migration runner（MIL-79，ADR-0012 Action Item 4）。
// - 純 SQL 檔，檔名 NNNN_name.sql，依檔名排序，只往前，沒有 down。
// - 已執行的檔案記在 control.schema_migrations，附 SHA-256。內容被改動就報錯。
// - 全程持有 advisory lock，兩個程序同時執行時由後到的排隊。
// - 每個檔案一個交易。檔案自己不得寫 BEGIN／COMMIT。
// - pg 與 PGlite 走同一段程式。多語句一律走 exec。
// - 傳進來的 pg 連線必須是專用的 Client，不能是 Pool：advisory lock 綁在連線上。
// 這個檔案只能 import node 內建模組，scripts/migrate.mjs 會直接執行它。

export type { SqlExecutor } from './executor';

export interface MigrateOptions {
  dir: string;
  /** 從第二個檔案起，角色存在時每個檔案的交易開頭 SET LOCAL ROLE。讓各線的 migration 自動由 app_owner 擁有物件。 */
  runAs?: string;
}

const LOCK_KEY = '7940001'; // 任意固定值，所有執行 migration 的程序必須相同
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
// 要求結尾分號，避免誤判 plpgsql 區塊的 BEGIN
const TX_STATEMENT = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)(\s+(WORK|TRANSACTION))?\s*;/im;

// 同一個程序內對同一個連線的呼叫排成一列，advisory lock 擋不住（同一個 session 可重入）
const inProcessQueue = new WeakMap<object, Promise<unknown>>();

export async function migrate(db: SqlExecutor, options: MigrateOptions): Promise<string[]> {
  const previous = inProcessQueue.get(db) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => migrateLocked(db, options));
  inProcessQueue.set(db, run);
  return run;
}

async function migrateLocked(db: SqlExecutor, { dir, runAs }: MigrateOptions): Promise<string[]> {
  const files = await listFiles(dir);
  await db.query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY]);
  try {
    // 紀錄表已存在時不再送 DDL：CREATE ... IF NOT EXISTS 仍會檢查權限，app_owner 沒有資料庫層級的 CREATE
    const boot = await db.query<{ t: string | null }>("SELECT to_regclass('control.schema_migrations') AS t");
    if (boot.rows[0].t === null) {
      await db.exec(`
        CREATE SCHEMA IF NOT EXISTS control;
        CREATE TABLE IF NOT EXISTS control.schema_migrations (
          filename   text PRIMARY KEY,
          sha256     text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        );`);
    }
    const done = new Map<string, string>();
    const { rows } = await db.query<{ filename: string; sha256: string }>(
      'SELECT filename, sha256 FROM control.schema_migrations',
    );
    for (const r of rows) done.set(r.filename, r.sha256);

    const sources = new Map<string, { sql: string; sha256: string }>();
    for (const name of files) {
      const sql = await readFile(path.join(dir, name), 'utf8');
      sources.set(name, { sql, sha256: createHash('sha256').update(sql).digest('hex') });
    }
    for (const [name, sha256] of done) {
      const file = sources.get(name);
      if (!file) throw new Error(`已執行的 migration ${name} 在目錄中不存在`);
      if (file.sha256 !== sha256) throw new Error(`已執行的 migration ${name} 已被修改，內容與紀錄的 SHA-256 不符`);
    }

    const applied: string[] = [];
    for (const [name, { sql, sha256 }] of sources) {
      if (done.has(name)) continue;
      if (TX_STATEMENT.test(sql)) throw new Error(`${name} 自己寫了交易敘述，runner 已為每個檔案開交易`);
      // 第一個檔案一律以連線者身分執行：它負責建立角色與 schema，且角色可能早已存在於同一個叢集
      const role = done.size + applied.length > 0 ? runAs : undefined;
      await applyOne(db, name, sql, sha256, role);
      applied.push(name);
    }
    return applied;
  } finally {
    await db.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  for (const n of names) {
    if (!FILE_PATTERN.test(n)) throw new Error(`${n} 的檔名不合 NNNN_name.sql 格式`);
  }
  return names;
}

async function applyOne(db: SqlExecutor, name: string, sql: string, sha256: string, runAs?: string) {
  await db.exec('BEGIN');
  try {
    // 先記錄再執行：同一個交易，失敗時記錄一併回滾。記錄用連線者的身分寫，不受 runAs 影響
    await db.query('INSERT INTO control.schema_migrations (filename, sha256) VALUES ($1, $2)', [name, sha256]);
    if (runAs) {
      const { rows } = await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [runAs]);
      if (rows.length > 0) await db.exec(`SET LOCAL ROLE "${runAs.replace(/"/g, '""')}"`);
    }
    await db.exec(sql);
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => undefined);
    throw new Error(`migration ${name} 失敗：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}
