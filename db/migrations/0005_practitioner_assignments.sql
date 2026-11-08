-- 合約的執業人員指派與送簽時的判定事實快照（MIL-69 在 SQLite 建立，MIL-85 搬進 PostgreSQL）。
-- 由 runner 以 app_owner 執行。寫法照 0004：org_id、複合唯一鍵、複合外鍵、ENABLE 與 FORCE RLS。
--
-- 這兩張表是過渡做法（ADR-0021 決議 4）：C 線建案件後，指派改成案件的 practitioner 成員，
-- 判定事實快照改由簽章紀錄（MIL-70）承接。
-- 沒有 legacy_id：兩張表以 (合約, 席位) 為自然鍵，MIL-90 搬資料時靠合約的 legacy_id 對應。

-- 1. org.contract_practitioner_assignments：執業人員指派 ---------------------------
-- 一個執業人員席位一列，slot 是規則列的 rule_id（ADR-0021 決議 5）。
-- ID 欄位是 TEXT：執業主體、執業人員與簽署人候選來自 practiceRegistry，不是本機資料表的主鍵。
-- party_signer_id 是同一個執業主體的當事人簽署人，執業主體不是當事人（經紀人席位）時為 NULL。
CREATE TABLE org.contract_practitioner_assignments (
  id               text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id           text NOT NULL REFERENCES control.orgs (id),
  contract_id      text NOT NULL,
  slot             text NOT NULL,
  entity_id        text NOT NULL,
  practitioner_id  text NOT NULL,
  party_signer_id  text,
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, contract_id, slot),
  -- 草稿刪除時指派一起刪（ADR-0006 只有草稿可刪）
  FOREIGN KEY (org_id, contract_id) REFERENCES org.contracts (org_id, id) ON DELETE CASCADE
);

ALTER TABLE org.contract_practitioner_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.contract_practitioner_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.contract_practitioner_assignments
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- 2. org.contract_credential_snapshots：判定事實快照 --------------------------------
-- 簽署任務建立成功後才存，判定用的事實與結果原樣保存，之後登錄資料改了也查得到當時依據。
-- 重複送簽（上一次送簽失敗後重送）時覆蓋同一列。送簽成功的合約不是草稿，不會被刪，所以不設 CASCADE：
-- 有快照的合約被刪除時，資料庫擋下，而不是讓依據無聲消失。
CREATE TABLE org.contract_credential_snapshots (
  id               text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id           text NOT NULL REFERENCES control.orgs (id),
  contract_id      text NOT NULL,
  slot             text NOT NULL,
  practitioner_id  text NOT NULL,
  decided_at       timestamptz NOT NULL,
  facts            jsonb NOT NULL,
  result           jsonb NOT NULL,
  UNIQUE (org_id, id),
  UNIQUE (org_id, contract_id, slot),
  FOREIGN KEY (org_id, contract_id) REFERENCES org.contracts (org_id, id)
);

ALTER TABLE org.contract_credential_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.contract_credential_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.contract_credential_snapshots
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
