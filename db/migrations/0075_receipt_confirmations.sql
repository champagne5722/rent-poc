-- 入帳確認、配置與持有人確認紀錄（MIL-125，ADR-0014 決議 2、4、7、13、15，ADR-0015 決議 2、11，ADR-0050 決議 3）。
-- 由 runner 以 app_owner 執行。寫法照 0055：org_id、複合唯一鍵、複合外鍵、ENABLE 與 FORCE RLS。
-- 檔名接在全域最大號之後（0074），不用 E 線區段的 0057。
--
-- 三張表都是資料，不是函式：沒有 SECURITY DEFINER，也沒有新的 registry 函式。
-- 案件成員的讀取登記在 src/lib/pg/rls-cases/receipts.ts，三張表都只開給 lessor（代管案件是屋主）。
-- 承租人端不顯示入帳確認的登錄者、證明檔與持有人確認紀錄。
--
--   receipt_confirmations         入帳確認，只增不改。分錄由 ledger 模組的 confirmReceipt() 在同一個交易寫入
--   receipt_allocations           入帳或預收抵充配置到應收期別。只有 active 能由 true 改 false（沖銷、改配置）
--   deposit_holder_acknowledgments 持有人確認紀錄，只增不改

-- 1. 應收期別加複合唯一鍵，配置才能用 (org_id, case_id, period_id) 指過來 ------------------------
-- ADD CONSTRAINT 不改既有列。id 本來就唯一，加上它不會失敗。
ALTER TABLE org.receivable_periods ADD CONSTRAINT receivable_periods_org_case_id_key UNIQUE (org_id, case_id, id);

-- 2. org.receipt_confirmations：入帳確認 -----------------------------------------------------
-- 登錄後狀態直接是 confirmed，沒有審核狀態（ADR-0014 決議 2），所以不存 status。
-- 被沖銷與否由 ledger_journals.reverses_journal_id 推導（MIL-126）。
CREATE TABLE org.receipt_confirmations (
  id                  text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id              text NOT NULL REFERENCES control.orgs (id),
  case_id             text NOT NULL,
  -- 識別字不用 deposit 表示入帳（ADR-0014 決議 5）
  purpose             text NOT NULL CHECK (purpose IN ('security_deposit', 'rent')),
  amount              bigint NOT NULL CHECK (amount > 0 AND amount <= 9007199254740991),
  -- 銀行日。報表月份看分錄的 posted_at
  value_date          date NOT NULL,
  payment_account_id  text NOT NULL,
  -- Phase 1 兩種來源。P2 加 bank_push、escrow_push 時改 CHECK
  source              text NOT NULL CHECK (source IN ('manual', 'statement_file')),
  -- 去重鍵（ADR-0014 決議 7）。manual 是表單產生的冪等鍵，只防連點
  external_id         text NOT NULL CHECK (btrim(external_id) <> '' AND char_length(external_id) <= 200),
  -- 這筆入帳寫的分錄。一筆入帳確認一筆分錄
  journal_id          text NOT NULL,
  -- 登錄者。對帳檔與推送沒有人登錄時是 null
  recorded_by_party_id text REFERENCES control.parties (id),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  -- 證明檔（選填）。檔案本體在 FileStore，key 一律含 org_id
  evidence_key        text,
  evidence_sha256     text CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_name       text CHECK (evidence_name IS NULL OR (btrim(evidence_name) <> '' AND char_length(evidence_name) <= 200)),
  evidence_content_type text,
  -- 同一份證明檔再用時，指向最早用它的入帳確認。只警告與記錄，不阻擋（ADR-0014 決議 7）
  evidence_reuse_of   text,
  UNIQUE (org_id, id),
  UNIQUE (org_id, source, external_id),
  UNIQUE (org_id, journal_id),
  FOREIGN KEY (org_id, case_id) REFERENCES org.cases (org_id, id),
  FOREIGN KEY (org_id, payment_account_id) REFERENCES org.payment_accounts (org_id, id),
  FOREIGN KEY (org_id, case_id, journal_id) REFERENCES org.ledger_journals (org_id, case_id, id),
  FOREIGN KEY (org_id, evidence_reuse_of) REFERENCES org.receipt_confirmations (org_id, id),
  CHECK ((evidence_key IS NULL) = (evidence_sha256 IS NULL)),
  CHECK ((evidence_key IS NULL) = (evidence_name IS NULL)),
  CHECK ((evidence_key IS NULL) = (evidence_content_type IS NULL)),
  CHECK (evidence_key IS NULL OR starts_with(evidence_key, 'org/' || org_id || '/ledger/receipt-evidence/')),
  CHECK (evidence_reuse_of IS NULL OR evidence_sha256 IS NOT NULL)
);

CREATE INDEX receipt_confirmations_by_case ON org.receipt_confirmations (org_id, case_id, id);
CREATE INDEX receipt_confirmations_by_evidence ON org.receipt_confirmations (org_id, evidence_sha256) WHERE evidence_sha256 IS NOT NULL;

-- 3. org.receipt_allocations：配置 -------------------------------------------------------------
-- 一筆入帳（或預收抵充）配到一個應收期別的金額。期別的未入帳、部分入帳、已入帳由有效配置加總算出（ADR-0015 決議 11）。
-- 押金不進應收期別，所以只有租金的配置。source_id：receipt 是入帳確認 ID，prepaid 是預收抵充事件 ID（MIL-127）。
CREATE TABLE org.receipt_allocations (
  id             text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id         text NOT NULL REFERENCES control.orgs (id),
  case_id        text NOT NULL,
  period_id      text NOT NULL,
  source         text NOT NULL CHECK (source IN ('receipt', 'prepaid')),
  source_id      text NOT NULL CHECK (btrim(source_id) <> ''),
  amount         bigint NOT NULL CHECK (amount > 0 AND amount <= 9007199254740991),
  -- false 表示已被沖銷或改配置而失效。失效的配置不計入期別狀態
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, case_id) REFERENCES org.cases (org_id, id),
  -- 期別必須是同組織、同案件的期別
  FOREIGN KEY (org_id, case_id, period_id) REFERENCES org.receivable_periods (org_id, case_id, id),
  CHECK (active = (invalidated_at IS NULL))
);

CREATE INDEX receipt_allocations_by_period ON org.receipt_allocations (org_id, case_id, period_id) WHERE active;
CREATE INDEX receipt_allocations_by_source ON org.receipt_allocations (org_id, source, source_id);

-- 4. org.deposit_holder_acknowledgments：持有人確認紀錄 --------------------------------------------
-- 使用者看過押金帳戶規則的警告後仍要登錄的紀錄（ADR-0014 決議 13）。與入帳確認同交易寫入。
-- rule_id 與 rule_version 在規則表沒有命中（視為 warn）時是 null。
CREATE TABLE org.deposit_holder_acknowledgments (
  id                       text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id                   text NOT NULL REFERENCES control.orgs (id),
  case_id                  text NOT NULL,
  receipt_confirmation_id  text NOT NULL,
  payment_account_id       text NOT NULL,
  rule_id                  text,
  rule_version             integer,
  -- 只有需要確認的動作會留紀錄。allow 不留，block 不寫入帳
  action                   text NOT NULL CHECK (action IN ('warn', 'warn_fix_mandate')),
  message_key              text NOT NULL CHECK (btrim(message_key) <> ''),
  acknowledged_by_party_id text REFERENCES control.parties (id),
  acknowledged_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, receipt_confirmation_id),
  FOREIGN KEY (org_id, case_id) REFERENCES org.cases (org_id, id),
  FOREIGN KEY (org_id, receipt_confirmation_id) REFERENCES org.receipt_confirmations (org_id, id),
  FOREIGN KEY (org_id, payment_account_id) REFERENCES org.payment_accounts (org_id, id),
  FOREIGN KEY (rule_id, rule_version) REFERENCES control.deposit_holder_rules (rule_id, version),
  CHECK ((rule_id IS NULL) = (rule_version IS NULL))
);

CREATE INDEX deposit_holder_acknowledgments_by_rule ON org.deposit_holder_acknowledgments (org_id, rule_id, rule_version);

-- 5. 觸發器 ------------------------------------------------------------------------------------
-- 函式以呼叫者的身分執行（不是 SECURITY DEFINER）。

CREATE FUNCTION org.receipt_forbid_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '%：入帳確認與持有人確認紀錄只增不改', TG_TABLE_NAME;
END
$$;

CREATE TRIGGER receipt_confirmations_immutable BEFORE UPDATE OR DELETE ON org.receipt_confirmations
  FOR EACH ROW EXECUTE FUNCTION org.receipt_forbid_change();
CREATE TRIGGER receipt_confirmations_no_truncate BEFORE TRUNCATE ON org.receipt_confirmations
  FOR EACH STATEMENT EXECUTE FUNCTION org.receipt_forbid_change();
CREATE TRIGGER deposit_holder_acknowledgments_immutable BEFORE UPDATE OR DELETE ON org.deposit_holder_acknowledgments
  FOR EACH ROW EXECUTE FUNCTION org.receipt_forbid_change();
CREATE TRIGGER deposit_holder_acknowledgments_no_truncate BEFORE TRUNCATE ON org.deposit_holder_acknowledgments
  FOR EACH STATEMENT EXECUTE FUNCTION org.receipt_forbid_change();

-- 配置：金額、期別與來源不改，只有 active 能由 true 改 false，而且必須同時填 invalidated_at。失效不能回復
CREATE FUNCTION org.receipt_allocation_before_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.case_id, NEW.period_id, NEW.source, NEW.source_id, NEW.amount, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.case_id, OLD.period_id, OLD.source, OLD.source_id, OLD.amount, OLD.created_at) THEN
    RAISE EXCEPTION '配置的金額、期別與來源寫入後不得修改，只能標記失效';
  END IF;
  IF OLD.active = false THEN
    RAISE EXCEPTION '已失效的配置不得回復';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION org.receipt_allocation_forbid_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '配置寫入後不得刪除，只能標記失效';
END
$$;

CREATE TRIGGER receipt_allocation_before_update BEFORE UPDATE ON org.receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION org.receipt_allocation_before_update();
CREATE TRIGGER receipt_allocation_no_delete BEFORE DELETE ON org.receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION org.receipt_allocation_forbid_delete();
CREATE TRIGGER receipt_allocation_no_truncate BEFORE TRUNCATE ON org.receipt_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION org.receipt_allocation_forbid_delete();

-- 6. 權限 --------------------------------------------------------------------------------------
REVOKE ALL ON org.receipt_confirmations, org.receipt_allocations, org.deposit_holder_acknowledgments FROM PUBLIC;
-- 預設權限可能已給 app_rw 全部權限（0050 同樣明確收回），所以先收回再授予
REVOKE UPDATE, DELETE, TRUNCATE ON org.receipt_confirmations, org.deposit_holder_acknowledgments FROM app_rw;
GRANT SELECT, INSERT ON org.receipt_confirmations, org.deposit_holder_acknowledgments TO app_rw;
-- 配置保留 DELETE 權限，與 0055 的應收期別相同：別的組織的列 RLS 讓它刪不到，自己組織的列由觸發器擋下
REVOKE TRUNCATE ON org.receipt_allocations FROM app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON org.receipt_allocations TO app_rw;

-- 7. RLS 與讀取政策 ------------------------------------------------------------------------------
ALTER TABLE org.receipt_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.receipt_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.receipt_confirmations
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
CREATE POLICY member_read ON org.receipt_confirmations FOR SELECT
  USING (org.case_relations_of_current_party(case_id) && ARRAY['lessor']);

ALTER TABLE org.receipt_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.receipt_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.receipt_allocations
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
CREATE POLICY member_read ON org.receipt_allocations FOR SELECT
  USING (org.case_relations_of_current_party(case_id) && ARRAY['lessor']);

ALTER TABLE org.deposit_holder_acknowledgments ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.deposit_holder_acknowledgments FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.deposit_holder_acknowledgments
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
CREATE POLICY member_read ON org.deposit_holder_acknowledgments FOR SELECT
  USING (org.case_relations_of_current_party(case_id) && ARRAY['lessor']);
