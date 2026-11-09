-- 簽章紀錄（MIL-70 在 SQLite 建立，同步 main 時搬進 PostgreSQL；ADR-0018 決議 12、ADR-0012）。
-- 由 runner 以 app_owner 執行。寫法照 0004：org_id、複合唯一鍵、複合外鍵、ENABLE 與 FORCE RLS。
--
-- 簽章紀錄只為執業人員席位寫一列，送簽時在簽署模組的送簽交易內寫 snapshot_at_send，
-- 簽署事件時在簽署進度的交易內補 snapshot_at_sign。
-- 沒有 legacy_id：這張表在 main 上只有 MIL-70 之後的資料，MIL-90 搬資料時靠合約與簽署人的 legacy_id 對應。
--
-- 同時移除 MIL-69 的暫存表 org.contract_credential_snapshots（0005 建立）。
-- MIL-70 以簽章紀錄取代它，main 已移除對應的函式。0005 已存在，不改它，另在這裡 DROP。

-- 1. org.signature_records ------------------------------------------------------------
-- signer_id 參照 org.signers.id（ULID 文字）。
-- 兩個快照欄位存 jsonb。concurrent_roles 是角色字串的 jsonb 陣列，沒有兼任時是空陣列。
-- 沒有 ON DELETE CASCADE：簽章紀錄只在送簽後才有，送簽後的合約不是草稿，不會被刪。
-- 紀錄存在時，刪除合約由資料庫擋下，而不是讓依據無聲消失。
CREATE TABLE org.signature_records (
  id               text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id           text NOT NULL REFERENCES control.orgs (id),
  contract_id      text NOT NULL,
  signer_id        text NOT NULL,
  rule_id          text NOT NULL,
  statute_ref      text NOT NULL,
  rule_version     integer NOT NULL,
  practitioner_id  text NOT NULL,
  employment_id    text NOT NULL,
  entity_id        text NOT NULL,
  license_kind     text NOT NULL,
  concurrent_roles jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(concurrent_roles) = 'array'),
  snapshot_at_send jsonb NOT NULL CHECK (jsonb_typeof(snapshot_at_send) = 'object'),
  snapshot_at_sign jsonb CHECK (snapshot_at_sign IS NULL OR jsonb_typeof(snapshot_at_sign) = 'object'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  -- 同一份合約內，一個席位（rule_id）一列
  UNIQUE (org_id, contract_id, rule_id),
  FOREIGN KEY (org_id, contract_id) REFERENCES org.contracts (org_id, id),
  FOREIGN KEY (org_id, signer_id) REFERENCES org.signers (org_id, id)
);

CREATE INDEX signature_records_contract ON org.signature_records (org_id, contract_id);

-- 2. 寫入後不得修改（資料庫層，不只靠 repository 沒有開放修改）---------------------------------
-- 例外只有 snapshot_at_sign 從 NULL 補成一次值。刪除一律擋下。規則與 SQLite 的 trigger 相同。
-- 比較用 IS DISTINCT FROM：欄位為空時也要正確判斷。
CREATE FUNCTION org.signature_records_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '簽章紀錄不得刪除';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.org_id IS DISTINCT FROM NEW.org_id
     OR OLD.contract_id IS DISTINCT FROM NEW.contract_id
     OR OLD.signer_id IS DISTINCT FROM NEW.signer_id
     OR OLD.rule_id IS DISTINCT FROM NEW.rule_id
     OR OLD.statute_ref IS DISTINCT FROM NEW.statute_ref
     OR OLD.rule_version IS DISTINCT FROM NEW.rule_version
     OR OLD.practitioner_id IS DISTINCT FROM NEW.practitioner_id
     OR OLD.employment_id IS DISTINCT FROM NEW.employment_id
     OR OLD.entity_id IS DISTINCT FROM NEW.entity_id
     OR OLD.license_kind IS DISTINCT FROM NEW.license_kind
     OR OLD.concurrent_roles IS DISTINCT FROM NEW.concurrent_roles
     OR OLD.snapshot_at_send IS DISTINCT FROM NEW.snapshot_at_send
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR (OLD.snapshot_at_sign IS NOT NULL AND OLD.snapshot_at_sign IS DISTINCT FROM NEW.snapshot_at_sign)
  THEN
    RAISE EXCEPTION '簽章紀錄寫入後不得修改';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER signature_records_immutable
  BEFORE UPDATE ON org.signature_records
  FOR EACH ROW EXECUTE FUNCTION org.signature_records_guard();

CREATE TRIGGER signature_records_no_delete
  BEFORE DELETE ON org.signature_records
  FOR EACH ROW EXECUTE FUNCTION org.signature_records_guard();

ALTER TABLE org.signature_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.signature_records FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.signature_records
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- 3. 移除 MIL-69 的判定事實快照暫存表 -----------------------------------------------------
-- 簽章紀錄的 snapshot_at_send 承接它，main 已移除讀寫它的函式。
DROP TABLE org.contract_credential_snapshots;
