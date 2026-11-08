-- 鏡像帳（MIL-117，ADR-0015 決議 2 到 5、13，ADR-0050 決議 2、3）。E 線的 migration 從 0050 起。
-- 由 runner 以 app_owner 執行，表歸 app_owner，放在 org 區。
--
-- 只增不改：app_rw 只有 SELECT 與 INSERT，UPDATE、DELETE、TRUNCATE 另有觸發器擋下超級使用者與擁有者。
-- 平衡由延遲約束觸發器在提交時檢查，掛在分錄與明細兩張表上（只掛明細時，沒有明細的分錄會過關）。
-- case_id 先存文字，不掛 cases 的外鍵。到 cases 的複合外鍵由「接上案件」票（MIL-123）以 ADD CONSTRAINT 加入。
-- 案件成員的讀取政策與 security_invoker view 也在 MIL-123 加入，這裡只有組織隔離。
-- 科目是由案件 ID 與收款帳戶 ID 組出來的文字編碼，沒有科目表。收款帳戶是否屬於本組織由 MIL-118 處理。

-- 1. org.ledger_journals：分錄 ---------------------------------------------------
CREATE TABLE org.ledger_journals (
  id                  text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  -- 排序依據。同一個交易內 now() 相同，所以不用時間排序
  seq                 bigint GENERATED ALWAYS AS IDENTITY,
  org_id              text NOT NULL REFERENCES control.orgs (id),
  -- 一筆分錄只屬於一個案件（ADR-0015 決議 4）。先存文字，ID 規則與 src/lib/ledger 的 isValidLedgerId 相同
  case_id             text NOT NULL CHECK (case_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- 事件類型是開放字串，資料庫不列舉。新增事件時不必改 migration（ADR-0050 決議 3）
  business_event_type text NOT NULL CHECK (business_event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  business_event_id   text NOT NULL CHECK (business_event_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- 沖銷：指向被沖銷的分錄，並必須帶原因
  reverses_journal_id text,
  reason              text,
  -- 報表月份依 posted_at，銀行日看 effective_date（ADR-0015 決議 4）
  posted_at           timestamptz NOT NULL DEFAULT now(),
  effective_date      date NOT NULL,
  -- 建立這筆分錄的交易。觸發器一律覆寫成目前交易，呼叫端填什麼都沒用
  posted_txid         bigint NOT NULL DEFAULT txid_current(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, case_id, id),
  -- 擋下用舊 ID 重寫（ADR-0015 決議 4）
  UNIQUE (org_id, business_event_type, business_event_id),
  -- 一筆分錄最多被沖銷一次。NULL 彼此不衝突，所以一般分錄不受影響
  UNIQUE (org_id, reverses_journal_id),
  FOREIGN KEY (org_id, reverses_journal_id) REFERENCES org.ledger_journals (org_id, id),
  CHECK (reverses_journal_id IS NULL OR reverses_journal_id <> id),
  CHECK ((reverses_journal_id IS NULL) = (reason IS NULL)),
  CHECK (reason IS NULL OR btrim(reason) <> ''),
  CHECK ((business_event_type = 'reversal') = (reverses_journal_id IS NOT NULL))
);

CREATE INDEX ledger_journals_by_case ON org.ledger_journals (org_id, case_id, seq);
CREATE INDEX ledger_journals_by_posted ON org.ledger_journals (org_id, posted_at);

-- 2. org.ledger_entries：明細 ----------------------------------------------------
CREATE TABLE org.ledger_entries (
  id         text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  seq        bigint GENERATED ALWAYS AS IDENTITY,
  org_id     text NOT NULL REFERENCES control.orgs (id),
  case_id    text NOT NULL,
  journal_id text NOT NULL,
  line_no    integer NOT NULL CHECK (line_no >= 1),
  -- 科目編碼：{類型}.{名稱}.{ID}，與 src/lib/ledger 的 parseAccountCode 相同規則
  account    text NOT NULL CHECK (account ~ '^(asset|liability|income)\.[a-z][a-z_]*\.[A-Za-z0-9_-]{1,64}$'),
  -- 整數新台幣元。上限是 JavaScript 的安全整數，讀回應用層時不會失真
  debit      bigint NOT NULL CHECK (debit >= 0 AND debit <= 9007199254740991),
  credit     bigint NOT NULL CHECK (credit >= 0 AND credit <= 9007199254740991),
  -- 恰好一欄大於 0
  CHECK ((debit > 0) <> (credit > 0)),
  UNIQUE (org_id, id),
  UNIQUE (org_id, journal_id, line_no),
  -- 複合外鍵（ADR-0015 決議 3、ADR-0012 陷阱 5）：外鍵檢查不受 RLS 限制，只有帶 org_id 才擋得住跨組織引用。
  -- 帶 case_id 讓「明細的案件與分錄的案件不同」被擋下
  FOREIGN KEY (org_id, case_id, journal_id) REFERENCES org.ledger_journals (org_id, case_id, id)
);

CREATE INDEX ledger_entries_by_account ON org.ledger_entries (org_id, account);
CREATE INDEX ledger_entries_by_case ON org.ledger_entries (org_id, case_id, seq);

-- 3. 權限：只讀與新增 ---------------------------------------------------------------
REVOKE ALL ON org.ledger_journals, org.ledger_entries FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON org.ledger_journals, org.ledger_entries FROM app_rw;
GRANT SELECT, INSERT ON org.ledger_journals, org.ledger_entries TO app_rw;

-- 4. 觸發器函式 ----------------------------------------------------------------------
-- 所有函式以呼叫者的身分執行（不是 SECURITY DEFINER），所以讀表時受 RLS 限制，只看得到目前組織的列。

-- 4.1 只增不改。擋下超級使用者與擁有者的 UPDATE、DELETE、TRUNCATE
CREATE FUNCTION org.ledger_forbid_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '鏡像帳只增不改：不得對 % 執行 %，更正請用沖銷', TG_TABLE_NAME, TG_OP;
END
$$;

-- 4.2 分錄寫入前：覆寫 posted_txid，並檢查沖銷的前提
CREATE FUNCTION org.ledger_journal_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  original org.ledger_journals%ROWTYPE;
BEGIN
  NEW.posted_txid := txid_current();

  IF NEW.reverses_journal_id IS NOT NULL THEN
    -- 找不到原分錄時不在這裡丟錯，交給 (org_id, reverses_journal_id) 外鍵。外鍵看得到別的組織的列，
    -- 帶 org_id 比對所以跨組織沖銷也會被擋下
    SELECT * INTO original FROM org.ledger_journals
     WHERE org_id = NEW.org_id AND id = NEW.reverses_journal_id;
    IF FOUND THEN
      IF original.reverses_journal_id IS NOT NULL THEN
        RAISE EXCEPTION '不得沖銷沖銷分錄：分錄 % 本身是沖銷', original.id;
      END IF;
      IF original.case_id <> NEW.case_id THEN
        RAISE EXCEPTION '沖銷的案件必須與原分錄相同：原分錄是 %，沖銷是 %', original.case_id, NEW.case_id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- 4.3 明細寫入前：只准在建立分錄的同一個交易內寫入
CREATE FUNCTION org.ledger_entry_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  parent_txid bigint;
BEGIN
  SELECT posted_txid INTO parent_txid FROM org.ledger_journals
   WHERE org_id = NEW.org_id AND id = NEW.journal_id;
  -- 找不到分錄時交給複合外鍵處理。找得到卻是別的交易寫的，就是對已提交的分錄追加明細
  IF FOUND AND parent_txid <> txid_current() THEN
    RAISE EXCEPTION '不得對已提交的分錄追加明細：分錄 % 是在不同交易寫入的', NEW.journal_id;
  END IF;
  RETURN NEW;
END
$$;

-- 4.4 提交時檢查整筆分錄。分錄與明細兩張表都掛，每一列各檢查一次，結果相同
CREATE FUNCTION org.ledger_check_journal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  context_org text := nullif(current_setting('app.org_id', true), '');
  journal_key text;
  line_count  integer;
  debit_sum   numeric;
  credit_sum  numeric;
  original_id text;
  journal_txid bigint;
BEGIN
  IF TG_TABLE_NAME = 'ledger_journals' THEN
    journal_key := NEW.id;
  ELSE
    journal_key := NEW.journal_id;
  END IF;

  -- RLS 只看得到目前組織的列。提交前把 app.org_id 切走，下面的查詢會讀到 0 列而通過，
  -- 所以必須先比對脈絡與該列的組織（ADR-0015 決議 3，實測情境 13）
  IF context_org IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION '分錄 % 提交時組織脈絡已不是 %，不得在提交前切換組織脈絡', journal_key, NEW.org_id;
  END IF;

  -- 明細的 BEFORE 觸發器已擋過一次追加。這裡再比對一次：分錄剛好在 BEFORE 觸發器查詢與外鍵檢查之間
  -- 由另一個交易提交時，BEFORE 觸發器讀不到分錄而放行，外鍵卻看得到
  SELECT reverses_journal_id, posted_txid INTO original_id, journal_txid FROM org.ledger_journals
   WHERE org_id = NEW.org_id AND id = journal_key;
  IF journal_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION '不得對已提交的分錄追加明細：分錄 % 是在不同交易寫入的', journal_key;
  END IF;

  SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    INTO line_count, debit_sum, credit_sum
    FROM org.ledger_entries
   WHERE org_id = NEW.org_id AND journal_id = journal_key;

  IF line_count < 2 THEN
    RAISE EXCEPTION '分錄 % 至少 2 列明細，目前只有 % 列', journal_key, line_count;
  END IF;
  IF debit_sum <> credit_sum THEN
    RAISE EXCEPTION '分錄 % 借貸不平衡：借方合計 % 不等於貸方合計 %', journal_key, debit_sum, credit_sum;
  END IF;

  -- 沖銷：明細必須與原分錄借貸相反。兩個方向各比一次，多一列或少一列都擋下
  IF original_id IS NOT NULL THEN
    IF EXISTS (
         (SELECT account, debit, credit FROM org.ledger_entries WHERE org_id = NEW.org_id AND journal_id = journal_key
          EXCEPT ALL
          SELECT account, credit, debit FROM org.ledger_entries WHERE org_id = NEW.org_id AND journal_id = original_id)
       ) OR EXISTS (
         (SELECT account, credit, debit FROM org.ledger_entries WHERE org_id = NEW.org_id AND journal_id = original_id
          EXCEPT ALL
          SELECT account, debit, credit FROM org.ledger_entries WHERE org_id = NEW.org_id AND journal_id = journal_key)
       ) THEN
      RAISE EXCEPTION '沖銷分錄 % 的明細與原分錄 % 不相反', journal_key, original_id;
    END IF;
  END IF;

  RETURN NULL;
END
$$;

-- 5. 觸發器 ------------------------------------------------------------------------------
CREATE TRIGGER ledger_journals_before_insert BEFORE INSERT ON org.ledger_journals
  FOR EACH ROW EXECUTE FUNCTION org.ledger_journal_before_insert();
CREATE TRIGGER ledger_entries_before_insert BEFORE INSERT ON org.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION org.ledger_entry_before_insert();

CREATE CONSTRAINT TRIGGER ledger_journals_balance AFTER INSERT ON org.ledger_journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION org.ledger_check_journal();
CREATE CONSTRAINT TRIGGER ledger_entries_balance AFTER INSERT ON org.ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION org.ledger_check_journal();

CREATE TRIGGER ledger_journals_no_update_delete BEFORE UPDATE OR DELETE ON org.ledger_journals
  FOR EACH ROW EXECUTE FUNCTION org.ledger_forbid_change();
CREATE TRIGGER ledger_entries_no_update_delete BEFORE UPDATE OR DELETE ON org.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION org.ledger_forbid_change();
CREATE TRIGGER ledger_journals_no_truncate BEFORE TRUNCATE ON org.ledger_journals
  FOR EACH STATEMENT EXECUTE FUNCTION org.ledger_forbid_change();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON org.ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION org.ledger_forbid_change();

-- 6. RLS：ENABLE 加 FORCE，只看得到也只寫得進當下組織。沒有 UPDATE 與 DELETE 的政策 -----------------
ALTER TABLE org.ledger_journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.ledger_journals FORCE  ROW LEVEL SECURITY;
ALTER TABLE org.ledger_entries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.ledger_entries  FORCE  ROW LEVEL SECURITY;

CREATE POLICY org_isolation_select ON org.ledger_journals FOR SELECT TO app_rw
  USING (org_id = nullif(current_setting('app.org_id', true), ''));
CREATE POLICY org_isolation_insert ON org.ledger_journals FOR INSERT TO app_rw
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), ''));
CREATE POLICY org_isolation_select ON org.ledger_entries FOR SELECT TO app_rw
  USING (org_id = nullif(current_setting('app.org_id', true), ''));
CREATE POLICY org_isolation_insert ON org.ledger_entries FOR INSERT TO app_rw
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), ''));
