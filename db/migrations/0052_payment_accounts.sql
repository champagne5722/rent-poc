-- 收款帳戶（MIL-118，ADR-0014 決議 9、10，ADR-0050 決議 9）。E 線的 migration 從 0050 起。
-- 由 runner 以 app_owner 執行，表歸 app_owner，放在 org 區。
--
-- 只存遮罩識別：銀行代碼與帳號末四碼。完整帳號不進資料庫。
-- account_kind 是內部識別字（general、cash），介面不顯示也不讓使用者選，押金帳戶規則不讀（決議 9）。
-- cash 用於現金收取，沒有銀行欄位（決議 10）。P2 加其他值時改 CHECK。
-- holder_party_id 先不掛外鍵：control.parties 在 C 線（MIL-103）。MIL-123 併入後以 ADD CONSTRAINT 補上。
--
-- 鏡像帳的科目編碼用收款帳戶 ID（asset.bank.{id}，ADR-0015 決議 2）。帳戶有分錄引用後，
-- 持有人與遮罩識別不得修改（ADR-0050 決議 9），由觸發器擋下，要改就停用舊帳戶、新增一個。
-- 帳戶只能停用，不能刪除，也不能重新啟用。

CREATE TABLE org.payment_accounts (
  id               text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id           text NOT NULL REFERENCES control.orgs (id),
  -- 使用者看得懂的名稱，例如「王先生的台新帳戶」
  name             text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 60),
  holder_kind      text NOT NULL CHECK (holder_kind IN ('lessor', 'owner', 'manager', 'other')),
  -- 持有人是人（party）時帶 ID，other 沒有 party，改填姓名
  holder_party_id  text CHECK (holder_party_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  holder_name      text NOT NULL CHECK (btrim(holder_name) <> '' AND char_length(holder_name) <= 60),
  account_kind     text NOT NULL CHECK (account_kind IN ('general', 'cash')),
  bank_code        text CHECK (bank_code ~ '^[0-9]{3}([0-9]{4})?$'),
  account_last4    text CHECK (account_last4 ~ '^[0-9]{4}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  deactivated_at   timestamptz,
  UNIQUE (org_id, id),
  CHECK ((holder_kind = 'other') = (holder_party_id IS NULL)),
  CHECK (
    (account_kind = 'cash' AND bank_code IS NULL AND account_last4 IS NULL)
    OR (account_kind = 'general' AND bank_code IS NOT NULL AND account_last4 IS NOT NULL)
  )
);

-- 每位持有人一個現金收取帳戶（ADR-0050 決議 9）。持有人以種類加 party（或姓名）識別，
-- 過渡期所有人共用同一個 party，所以不同種類各算各的。已停用的不佔名額。
CREATE UNIQUE INDEX payment_accounts_one_cash_per_holder
  ON org.payment_accounts (org_id, holder_kind, COALESCE(holder_party_id, 'name:' || holder_name))
  WHERE account_kind = 'cash' AND deactivated_at IS NULL;

CREATE INDEX payment_accounts_by_org ON org.payment_accounts (org_id, id DESC);

ALTER TABLE org.payment_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.payment_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.payment_accounts
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

REVOKE ALL ON org.payment_accounts FROM PUBLIC;
REVOKE TRUNCATE ON org.payment_accounts FROM app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON org.payment_accounts TO app_rw;

-- 觸發器 ---------------------------------------------------------------------------
-- 函式以呼叫者的身分執行（不是 SECURITY DEFINER），讀 ledger_entries 時受 RLS 限制，只看得到本組織的分錄。

CREATE FUNCTION org.payment_account_before_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION '收款帳戶的 ID 不得修改';
  END IF;
  -- 帳戶性質（銀行或現金）從建立起就不變
  IF NEW.account_kind <> OLD.account_kind THEN
    RAISE EXCEPTION '收款帳戶不得在銀行帳戶與現金收取之間切換，請停用並新增';
  END IF;
  -- 停用是單向的
  IF OLD.deactivated_at IS NOT NULL AND NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at THEN
    RAISE EXCEPTION '已停用的收款帳戶不得重新啟用或改停用時間，請新增帳戶';
  END IF;
  -- 有分錄引用後，持有人與遮罩識別不得修改
  IF (NEW.holder_kind, NEW.holder_party_id, NEW.holder_name, NEW.bank_code, NEW.account_last4)
       IS DISTINCT FROM (OLD.holder_kind, OLD.holder_party_id, OLD.holder_name, OLD.bank_code, OLD.account_last4)
     AND EXISTS (
       SELECT 1 FROM org.ledger_entries
        WHERE org_id = OLD.org_id AND account = 'asset.bank.' || OLD.id
     ) THEN
    RAISE EXCEPTION '收款帳戶已有分錄引用，持有人與遮罩識別不得修改，請停用並新增';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER payment_account_before_update
  BEFORE UPDATE ON org.payment_accounts
  FOR EACH ROW EXECUTE FUNCTION org.payment_account_before_update();

CREATE FUNCTION org.payment_account_forbid_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '收款帳戶只能停用，不得刪除或清空';
END
$$;

-- app_rw 為了跨組織探測保留 DELETE 權限（RLS 讓別的組織的列刪不到），觸發器擋下自己組織的列與超級使用者
CREATE TRIGGER payment_account_no_delete
  BEFORE DELETE ON org.payment_accounts
  FOR EACH ROW EXECUTE FUNCTION org.payment_account_forbid_delete();
CREATE TRIGGER payment_account_no_truncate
  BEFORE TRUNCATE ON org.payment_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION org.payment_account_forbid_delete();
