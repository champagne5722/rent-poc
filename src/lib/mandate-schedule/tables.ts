import type Database from 'better-sqlite3';

// 委託標的清單的資料表（MIL-74）。沿用 SQLite 的 ensureSchema，所有存取走 repository.ts（介面回傳 Promise），
// A 線遷移到 PostgreSQL 時一起搬。租賃單位的 ID 一律是 TEXT：B 線完成後會改指產權錨點，不是本機物件表的數字 ID。
// contract_id 是 contracts 表的 INTEGER，與 contract_practitioner_assignments 相同。

export function ensureMandateScheduleTables(db: Database.Database): void {
  db.exec(`
    -- 委託管理合約的委託標的清單：一個租賃單位一列。名稱與地址是建立當下的快照。
    -- scopes 是委託範圍的 JSON 陣列（收租、押金管理、修繕、點交），position 是畫面與 PDF 的列順序。
    CREATE TABLE IF NOT EXISTS contract_mandate_items (
      contract_id INTEGER NOT NULL REFERENCES contracts(id),
      position INTEGER NOT NULL,
      property_id TEXT NOT NULL,
      property_name TEXT NOT NULL,
      property_address TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (contract_id, position),
      UNIQUE (contract_id, property_id)
    );
  `);
}
