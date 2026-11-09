-- 委託管理合約的委託標的清單（MIL-74 在 SQLite 建立，第二次同步 main 時搬進 PostgreSQL；ADR-0018、ADR-0021）。
-- 由 runner 以 app_owner 執行。寫法照 0005：org_id、複合唯一鍵、複合外鍵、ENABLE 與 FORCE RLS。
--
-- 一個租賃單位一列，名稱與地址是建立當下的快照。position 是畫面與 PDF 的列順序。
-- property_id 是文字：B 線完成後會改指產權錨點，不是 org.properties 的 ULID，所以不加外鍵。
-- scopes 是委託範圍（收租、押金管理、修繕、點交）的 jsonb 陣列。
-- 沒有 legacy_id：這張表在 main 上只有 MIL-74 之後的資料，MIL-90 搬資料時靠合約的 legacy_id 對應。
--
-- 委託管理合約不綁單一物件：org.contracts.property_id 本來就允許空值（0004），不需要放寬。

CREATE TABLE org.contract_mandate_items (
  id               text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id           text NOT NULL REFERENCES control.orgs (id),
  contract_id      text NOT NULL,
  position         integer NOT NULL CHECK (position >= 0),
  property_id      text NOT NULL,
  property_name    text NOT NULL,
  property_address text NOT NULL,
  scopes           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scopes) = 'array'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, contract_id, position),
  -- 同一份合約內，一個租賃單位一列
  UNIQUE (org_id, contract_id, property_id),
  -- 清單屬於草稿，草稿刪除時一起刪（ADR-0006 只有草稿可刪）
  FOREIGN KEY (org_id, contract_id) REFERENCES org.contracts (org_id, id) ON DELETE CASCADE
);

ALTER TABLE org.contract_mandate_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.contract_mandate_items FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.contract_mandate_items
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
