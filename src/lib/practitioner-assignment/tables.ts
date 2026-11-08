import type Database from 'better-sqlite3';

// 指派的資料表（MIL-69）。沿用 SQLite 的 ensureSchema，所有存取走 repository.ts（介面回傳 Promise），
// A 線遷移到 PostgreSQL 時一起搬。ID 一律是 TEXT：執業主體、執業人員與簽署人候選來自 practiceRegistry，不是本機資料表的數字 ID。
//
// 這張表是過渡做法（ADR-0021 決議 4）：C 線建案件後，指派改成案件的 practitioner 成員。
// MIL-69 的 contract_credential_snapshots 已由簽章紀錄（MIL-70，signature_records）取代，不再建立也不再寫入。
// 舊資料庫殘留的那張表沒有程式讀它，可以之後清掉。

export function ensurePractitionerAssignmentTables(db: Database.Database): void {
  db.exec(`
    -- 合約的執業人員指派：一個執業人員席位一列，slot 是規則列的 rule_id（ADR-0021 決議 5）。
    -- party_signer_id 是同一個執業主體的當事人簽署人，執業主體不是當事人（經紀人席位）時為 NULL。
    CREATE TABLE IF NOT EXISTS contract_practitioner_assignments (
      contract_id INTEGER NOT NULL REFERENCES contracts(id),
      slot TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      practitioner_id TEXT NOT NULL,
      party_signer_id TEXT,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (contract_id, slot)
    );
  `);
}
