import type Database from 'better-sqlite3';

// 簽章紀錄的資料表（MIL-70，ADR-0018 決議 12）。沿用 SQLite 的 ensureSchema，存取走 repository.ts。
//
// 寫入後不得修改：資料庫層用 trigger 擋下，不只靠 repository 沒有開放修改。
// 例外只有 snapshot_at_sign 從 NULL 補成一次值。刪除一律擋下。
//
// A 線遷移 PostgreSQL 時：trigger 語法要改成 plpgsql，欄位、約束與 trigger 的規則不變。
// signer_id 參照簽署模組的 signers.id，兩張表要一起搬。

export function ensureSignatureRecordTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signature_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contracts(id),
      signer_id INTEGER NOT NULL REFERENCES signers(id),
      rule_id TEXT NOT NULL,
      statute_ref TEXT NOT NULL,
      rule_version INTEGER NOT NULL,
      practitioner_id TEXT NOT NULL,
      employment_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      license_kind TEXT NOT NULL,
      concurrent_roles TEXT NOT NULL DEFAULT '[]',
      snapshot_at_send TEXT NOT NULL,
      snapshot_at_sign TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE (contract_id, rule_id)
    );

    CREATE INDEX IF NOT EXISTS idx_signature_records_contract ON signature_records (contract_id);

    CREATE TRIGGER IF NOT EXISTS signature_records_immutable
    BEFORE UPDATE ON signature_records
    WHEN OLD.id IS NOT NEW.id
      OR OLD.contract_id IS NOT NEW.contract_id
      OR OLD.signer_id IS NOT NEW.signer_id
      OR OLD.rule_id IS NOT NEW.rule_id
      OR OLD.statute_ref IS NOT NEW.statute_ref
      OR OLD.rule_version IS NOT NEW.rule_version
      OR OLD.practitioner_id IS NOT NEW.practitioner_id
      OR OLD.employment_id IS NOT NEW.employment_id
      OR OLD.entity_id IS NOT NEW.entity_id
      OR OLD.license_kind IS NOT NEW.license_kind
      OR OLD.concurrent_roles IS NOT NEW.concurrent_roles
      OR OLD.snapshot_at_send IS NOT NEW.snapshot_at_send
      OR OLD.created_at IS NOT NEW.created_at
      OR (OLD.snapshot_at_sign IS NOT NULL AND OLD.snapshot_at_sign IS NOT NEW.snapshot_at_sign)
    BEGIN
      SELECT RAISE(ABORT, '簽章紀錄寫入後不得修改');
    END;

    CREATE TRIGGER IF NOT EXISTS signature_records_no_delete
    BEFORE DELETE ON signature_records
    BEGIN
      SELECT RAISE(ABORT, '簽章紀錄不得刪除');
    END;
  `);
}
