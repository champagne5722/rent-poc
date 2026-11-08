-- 登入與 session（MIL-103，ADR-0022）。C 線 migration 從 0040 起編號。
-- 由 runner 以 app_owner 執行。control 不掛組織 RLS，權限逐表授予（ADR-0012 決議 3），
-- 所以這裡每張表都自己 REVOKE 與 GRANT。
--
-- A 線的 0002 只建了 control.orgs。ADR-0012 列的 parties、users、org_memberships 沒人建，
-- 由這張票補上最小形狀，MIL-106（邀請與角色）、MIL-115（案件成員依 email 找或建 party）沿用。

-- 1. parties：自然人。以 email 為唯一鍵 --------------------------------------
-- 承租人在登入前就可能有 party（送簽時依乙方 email 建立，MIL-115），所以 party 不等於帳號。
-- email 一律存小寫且去掉前後空白，比對時不再轉換。
CREATE TABLE control.parties (
  id           text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  email        text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+$'),
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 2. users：有登入能力的帳號。一個 party 最多一個帳號 -----------------------
CREATE TABLE control.users (
  id         text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  party_id   text NOT NULL UNIQUE REFERENCES control.parties (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3. org_memberships：帳號與組織的成員關係 ---------------------------------
-- 角色只有三種（ADR-0022 決議 5）。平台營運者是平台組織的成員，不另設角色。
CREATE TABLE control.org_memberships (
  id         text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id     text NOT NULL REFERENCES control.orgs (id),
  user_id    text NOT NULL REFERENCES control.users (id),
  role       text NOT NULL CHECK (role IN ('admin', 'staff', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX org_memberships_user_idx ON control.org_memberships (user_id);

-- 4. sessions：伺服器端 session（ADR-0022 決議 2） --------------------------
-- cookie 只放隨機 token，這裡只存它的 SHA-256。token 有 256 位元亂度，不需要加鹽或慢雜湊。
-- identity_kind 是目前身分，空值代表帳號還沒有任何可用身分（MIL-106 的建組織流程接手）。
--   org：identity_org_id 是屋主或執業主體組織。
--   operator：帳號是平台組織成員，目標組織與工單號由審核台的動作另外帶。
--   party：承租人，以案件成員關係讀資料。
CREATE TABLE control.sessions (
  id              text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  token_hash      text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id         text NOT NULL REFERENCES control.users (id) ON DELETE CASCADE,
  identity_kind   text CHECK (identity_kind IN ('org', 'party', 'operator')),
  identity_org_id text REFERENCES control.orgs (id),
  -- Phase 1 全部帳號都是等級 1（ADR-0022 決議 8）
  identity_level  smallint NOT NULL DEFAULT 1 CHECK (identity_level >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  CHECK (
    (identity_kind IS NULL AND identity_org_id IS NULL)
    OR (identity_kind = 'org' AND identity_org_id IS NOT NULL)
    OR (identity_kind IN ('party', 'operator') AND identity_org_id IS NULL)
  ),
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx ON control.sessions (user_id);
CREATE INDEX sessions_org_idx ON control.sessions (identity_org_id) WHERE identity_org_id IS NOT NULL;

-- 5. login_otps：一次性驗證碼 ----------------------------------------------
-- 只存雜湊（HMAC-SHA256，金鑰在應用程式環境變數，不在資料庫）。用過、作廢或過期的列留著，
-- 供每分鐘一次的頻率判斷，由應用程式定期清除。
CREATE TABLE control.login_otps (
  id          text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  email       text NOT NULL CHECK (email = lower(btrim(email))),
  code_hash   text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  attempts    integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX login_otps_email_idx ON control.login_otps (email, created_at DESC);

-- 6. 權限 -------------------------------------------------------------------
REVOKE ALL ON control.parties, control.users, control.org_memberships, control.sessions, control.login_otps
  FROM PUBLIC, app_rw;
GRANT SELECT, INSERT ON control.parties TO app_rw;
GRANT SELECT, INSERT ON control.users TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON control.org_memberships TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON control.sessions TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON control.login_otps TO app_rw;
