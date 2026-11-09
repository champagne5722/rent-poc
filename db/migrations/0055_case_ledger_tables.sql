-- 接上案件之一：押金台帳、應收期別、社宅旗標、匯款識別、預設收款帳戶（MIL-123，ADR-0015 決議 6、11、12，ADR-0050 決議 4、5、6、10）。
-- 由 runner 以 app_owner 執行。寫法照 0045：org_id、複合唯一鍵、複合外鍵、ENABLE 與 FORCE RLS。E 線的 migration 從 0050 起。
--
-- 案件範圍的表各有 org_isolation（主辦組織）與 member_read（案件成員，只開 SELECT）。成員可讀的關係登記在
-- src/lib/pg/rls-cases/ledger.ts 的 caseScopedReads，case-rls.test.ts 逐表、逐關係驗證政策與登記一致。
-- 成員政策用 0045 的 org.case_relations_of_current_party()（INVOKER，有防遞迴）。
--
--   deposit_ledgers             lessor、lessee、co_lessee（承租人看自己的押金進度，MIL-140）
--   receivable_periods          lessor（承租人端不顯示應收期別與逾期，ADR-0050 與交接文件第 6 節第 5 題）
--   case_social_housing_changes lessor（屋主看得到旗標與修改原因）
--   case_remitter_ids           無（付款人戶名是個資，只有主辦組織讀得到）

-- 1. org.cases 加欄位 ---------------------------------------------------------------
-- 社宅代管案件旗標（ADR-0050 決議 10）。建案件時標記，事後修改走 changeSocialHousing()（寫修改紀錄、稽核與通知）。
-- 預設收款帳戶只用來預填入帳表單（spec「收款帳戶」），不影響配對與分錄。
ALTER TABLE org.cases ADD COLUMN social_housing boolean NOT NULL DEFAULT false;
ALTER TABLE org.cases ADD COLUMN default_rent_account_id text;
ALTER TABLE org.cases ADD COLUMN default_deposit_account_id text;
-- 複合外鍵（ADR-0012 陷阱 5）：預設帳戶只能是同一個組織的收款帳戶。收款帳戶只能停用不能刪除，所以不需要 ON DELETE
ALTER TABLE org.cases ADD FOREIGN KEY (org_id, default_rent_account_id) REFERENCES org.payment_accounts (org_id, id);
ALTER TABLE org.cases ADD FOREIGN KEY (org_id, default_deposit_account_id) REFERENCES org.payment_accounts (org_id, id);

-- 2. org.deposit_ledgers：押金台帳 -----------------------------------------------------
-- 只存約定金額與狀態。餘額不存，一律由 liability.deposit.{case} 即時加總（ADR-0015 決議 6）。
-- 合約全員完成時，與完成事件同一個交易建立（src/lib/case-ledger 的 openCaseLedger）。
-- status 由押金分錄的業務函式在同交易更新（MIL-125、MIL-128）：open 表示尚未結清，settled 表示餘額歸 0 後結清。
CREATE TABLE org.deposit_ledgers (
  id              text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id          text NOT NULL REFERENCES control.orgs (id),
  case_id         text NOT NULL,
  -- 約定金額取合約欄位的押金，整數新台幣元。合約沒填押金時是 0
  expected_amount bigint NOT NULL CHECK (expected_amount >= 0 AND expected_amount <= 9007199254740991),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  UNIQUE (org_id, id),
  -- 一個案件一份押金台帳。重送完成事件時靠它擋下重複建立
  UNIQUE (org_id, case_id),
  FOREIGN KEY (org_id, case_id) REFERENCES org.cases (org_id, id)
);

-- 3. org.receivable_periods：應收期別 ----------------------------------------------------
-- 一個月一期（ADR-0050 決議 5）。金額與日期寫入後不改，只有 state（active 轉 cancelled）與 overdue_at 能變。
-- 未入帳、部分入帳、已入帳由配置加總算出，不存（ADR-0015 決議 11）。配置表 receipt_allocations 屬 MIL-125。
-- 押金不進應收期別，所以 kind 固定 rent。
CREATE TABLE org.receivable_periods (
  id           text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id       text NOT NULL REFERENCES control.orgs (id),
  case_id      text NOT NULL,
  -- 日曆月，格式 YYYY-MM
  period_key   text NOT NULL CHECK (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  period_start date NOT NULL,
  period_end   date NOT NULL,
  due_date     date NOT NULL,
  amount       bigint NOT NULL CHECK (amount >= 0 AND amount <= 9007199254740991),
  kind         text NOT NULL DEFAULT 'rent' CHECK (kind = 'rent'),
  state        text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'cancelled')),
  -- 每日排程判定逾期的時間（MIL-130），用來避免重複通知。足額後仍保留，顯示以配置為準
  overdue_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  -- 一案件一月一期。重送完成事件時靠它擋下重複建立
  UNIQUE (org_id, case_id, period_key),
  FOREIGN KEY (org_id, case_id) REFERENCES org.cases (org_id, id),
  CHECK (period_start <= period_end),
  CHECK (due_date >= period_start)
);

CREATE INDEX receivable_periods_by_case ON org.receivable_periods (org_id, case_id, period_key);
-- 逾期排程找「未取消、已過到期日、還沒標逾期」的期別
CREATE INDEX receivable_periods_due ON org.receivable_periods (org_id, due_date) WHERE state = 'active' AND overdue_at IS NULL;

-- 4. org.case_remitter_ids：匯款識別 ------------------------------------------------------
-- 每個租賃案件 0 到多筆（ADR-0050 決議 6）。內容是付款人戶名或付款帳號末五碼，供對帳檔自動配對（MIL-129）。
-- 戶名存正規化後的文字（NFKC、前後空白去除、連續空白合成一個），比對時兩邊同樣正規化。
-- 不同案件可以登錄同一個識別：配對時命中多個案件就進待配對清單，所以這裡不做跨案件唯一。
CREATE TABLE org.case_remitter_ids (
  id         text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id     text NOT NULL REFERENCES control.orgs (id),
  case_id    text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('payer_name', 'account_last5')),
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, case_id, kind, value),
  FOREIGN KEY (org_id, case_id) REFERENCES org.cases (org_id, id),
  CHECK (
    (kind = 'payer_name' AND btrim(value) <> '' AND char_length(value) <= 60)
    OR (kind = 'account_last5' AND value ~ '^[0-9]{5}$')
  )
);

CREATE INDEX case_remitter_ids_lookup ON org.case_remitter_ids (org_id, kind, value);

-- 5. org.case_social_housing_changes：社宅旗標的修改紀錄 -----------------------------------------
-- 只增不改。原因是使用者輸入的自由文字，可能含個資，所以放在這裡，稽核事件（寫入後刪不掉）只放 ID 與旗標值。
-- 建案件時標記的初始值不寫紀錄，初始值就在案件上。
CREATE TABLE org.case_social_housing_changes (
  id                  text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id              text NOT NULL REFERENCES control.orgs (id),
  case_id             text NOT NULL,
  from_value          boolean NOT NULL,
  to_value            boolean NOT NULL,
  reason              text NOT NULL CHECK (btrim(reason) <> '' AND char_length(reason) <= 500),
  changed_by_party_id text,
  changed_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, case_id) REFERENCES org.cases (org_id, id),
  CHECK (from_value <> to_value)
);

CREATE INDEX case_social_housing_changes_by_case ON org.case_social_housing_changes (org_id, case_id, id);

-- 6. 觸發器 ---------------------------------------------------------------------------------
-- 函式以呼叫者的身分執行（不是 SECURITY DEFINER）。app_rw 為了跨組織探測保留 DELETE 權限（RLS 讓別的組織的列刪不到），
-- 觸發器擋下自己組織的列與超級使用者。

CREATE FUNCTION org.case_ledger_forbid_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '%：資料寫入後不得刪除或清空', TG_TABLE_NAME;
END
$$;

-- 押金台帳：約定金額與所屬案件不改，只有 status 與 updated_at 能變。settled 不能回到 open（要重開請沖銷後再處理）
CREATE FUNCTION org.deposit_ledger_before_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.case_id, NEW.expected_amount, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.case_id, OLD.expected_amount, OLD.created_at) THEN
    RAISE EXCEPTION '押金台帳的約定金額與所屬案件寫入後不得修改';
  END IF;
  IF OLD.status = 'settled' AND NEW.status <> 'settled' THEN
    RAISE EXCEPTION '已結清的押金台帳不得重開';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER deposit_ledger_before_update BEFORE UPDATE ON org.deposit_ledgers
  FOR EACH ROW EXECUTE FUNCTION org.deposit_ledger_before_update();
CREATE TRIGGER deposit_ledger_no_delete BEFORE DELETE ON org.deposit_ledgers
  FOR EACH ROW EXECUTE FUNCTION org.case_ledger_forbid_delete();
CREATE TRIGGER deposit_ledger_no_truncate BEFORE TRUNCATE ON org.deposit_ledgers
  FOR EACH STATEMENT EXECUTE FUNCTION org.case_ledger_forbid_delete();

-- 應收期別：金額與日期不改，只有 state 與 overdue_at 能變。cancelled 不能回到 active
CREATE FUNCTION org.receivable_period_before_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.case_id, NEW.period_key, NEW.period_start, NEW.period_end, NEW.due_date, NEW.amount, NEW.kind, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.case_id, OLD.period_key, OLD.period_start, OLD.period_end, OLD.due_date, OLD.amount, OLD.kind, OLD.created_at) THEN
    RAISE EXCEPTION '應收期別的金額與日期寫入後不得修改，只有狀態與逾期時間能變';
  END IF;
  IF OLD.state = 'cancelled' AND NEW.state <> 'cancelled' THEN
    RAISE EXCEPTION '已取消的應收期別不得恢復';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER receivable_period_before_update BEFORE UPDATE ON org.receivable_periods
  FOR EACH ROW EXECUTE FUNCTION org.receivable_period_before_update();
CREATE TRIGGER receivable_period_no_delete BEFORE DELETE ON org.receivable_periods
  FOR EACH ROW EXECUTE FUNCTION org.case_ledger_forbid_delete();
CREATE TRIGGER receivable_period_no_truncate BEFORE TRUNCATE ON org.receivable_periods
  FOR EACH STATEMENT EXECUTE FUNCTION org.case_ledger_forbid_delete();

-- 社宅旗標修改紀錄：只增不改
CREATE FUNCTION org.case_social_housing_change_forbid_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '社宅旗標的修改紀錄只增不改';
END
$$;

CREATE TRIGGER case_social_housing_change_immutable BEFORE UPDATE OR DELETE ON org.case_social_housing_changes
  FOR EACH ROW EXECUTE FUNCTION org.case_social_housing_change_forbid_change();
CREATE TRIGGER case_social_housing_change_no_truncate BEFORE TRUNCATE ON org.case_social_housing_changes
  FOR EACH STATEMENT EXECUTE FUNCTION org.case_social_housing_change_forbid_change();

-- 7. 權限 -------------------------------------------------------------------------------------
REVOKE ALL ON org.deposit_ledgers, org.receivable_periods, org.case_remitter_ids, org.case_social_housing_changes FROM PUBLIC;
-- 預設權限可能已給 app_rw 全部權限（0050 同樣明確收回），所以先收回再授予
REVOKE TRUNCATE ON org.deposit_ledgers, org.receivable_periods, org.case_remitter_ids FROM app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON org.deposit_ledgers, org.receivable_periods, org.case_remitter_ids TO app_rw;
-- 修改紀錄只增不改：連 UPDATE、DELETE 與 TRUNCATE 權限都不給
REVOKE UPDATE, DELETE, TRUNCATE ON org.case_social_housing_changes FROM app_rw;
GRANT SELECT, INSERT ON org.case_social_housing_changes TO app_rw;

-- 8. RLS 與讀取政策 ---------------------------------------------------------------------------
ALTER TABLE org.deposit_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.deposit_ledgers FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.deposit_ledgers
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
CREATE POLICY member_read ON org.deposit_ledgers FOR SELECT
  USING (org.case_relations_of_current_party(case_id) && ARRAY['lessor', 'lessee', 'co_lessee']);

ALTER TABLE org.receivable_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.receivable_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.receivable_periods
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
CREATE POLICY member_read ON org.receivable_periods FOR SELECT
  USING (org.case_relations_of_current_party(case_id) && ARRAY['lessor']);

ALTER TABLE org.case_remitter_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.case_remitter_ids FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.case_remitter_ids
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE org.case_social_housing_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.case_social_housing_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.case_social_housing_changes
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
CREATE POLICY member_read ON org.case_social_housing_changes FOR SELECT
  USING (org.case_relations_of_current_party(case_id) && ARRAY['lessor']);
