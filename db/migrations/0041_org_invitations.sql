-- 建立組織、邀請成員（MIL-106，ADR-0022 決議 4、5）。由 runner 以 app_owner 執行。

-- 1. 建組織：登入後第一次選「我是屋主」或「我是經理人」時，由應用程式在同一個交易寫入 orgs 與第一位 admin。
-- 只開 INSERT。改名、刪除組織不在這張票的範圍。
GRANT INSERT ON control.orgs TO app_rw;

-- 2. org_invitations：以 email 邀請成員 ---------------------------------------
-- 被邀請者通過驗證碼登入時，待處理的邀請轉成 org_memberships（login-flow）。
-- 帳號不必已存在，所以只存 email，不存 user_id。email 一律小寫且去掉前後空白。
-- 已接受的列留著當紀錄；待處理的列可以由 admin 撤銷（刪除）。
CREATE TABLE control.org_invitations (
  id                 text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id             text NOT NULL REFERENCES control.orgs (id),
  email              text NOT NULL CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+$'),
  role               text NOT NULL CHECK (role IN ('admin', 'staff', 'viewer')),
  invited_by_user_id text NOT NULL REFERENCES control.users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  accepted_at        timestamptz
);
-- 同一個組織對同一個 email 同時只有一筆待處理的邀請
CREATE UNIQUE INDEX org_invitations_pending_unique ON control.org_invitations (org_id, email) WHERE accepted_at IS NULL;
-- 登入時依 email 找待處理的邀請
CREATE INDEX org_invitations_pending_email ON control.org_invitations (email) WHERE accepted_at IS NULL;

REVOKE ALL ON control.org_invitations FROM PUBLIC, app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON control.org_invitations TO app_rw;
