import type Database from 'better-sqlite3';

// 簽署中失效紀錄的資料表（MIL-75，ADR-0018 決議 11 情況 B）。沿用 SQLite 的 ensureSchema，存取走 repository.ts。
//
// 一列代表「某個執業人員席位在簽署事件到達時不可簽章」這個事實，以及它目前的處理狀態。
// UNIQUE (contract_id, rule_id) 讓同一個席位只會有一列，重複的事件不會重複撤回。
// 狀態轉移見 types.ts 的 SigningLapseState。
//
// A 線遷移 PostgreSQL 時：欄位與約束不變。signer_id 參照簽署模組的 signers.id，和簽章紀錄一起搬。

export function ensureSigningLapseTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signing_lapses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contracts(id),
      signer_id INTEGER NOT NULL REFERENCES signers(id),
      rule_id TEXT NOT NULL,
      state TEXT NOT NULL,
      reasons TEXT NOT NULL DEFAULT '[]',
      event_at TEXT NOT NULL,
      void_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE (contract_id, rule_id)
    );

    CREATE INDEX IF NOT EXISTS idx_signing_lapses_contract ON signing_lapses (contract_id);
  `);
}
