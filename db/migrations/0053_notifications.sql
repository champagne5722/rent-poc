-- 站內通知與通知 email（MIL-120，ADR-0050 決議 12）。
-- 由 runner 以 app_owner 執行。寫法照 0006：org_id、複合唯一鍵、複合外鍵、ENABLE 與 FORCE RLS。
--
-- 站內通知是組織資料。recipient_party_id 為空表示整個組織的成員都看得到，有值只給那一位成員。
-- 已讀狀態整列共用：組織通知任一位成員標已讀，其他成員也看到已讀。
-- email 的內容（收件人、寄件名義、主旨、本文）存在 org.notification_emails，outbox 列只記派送狀態。
-- 本文不得放驗證碼、身分證字號、電話等敏感內容（寄件紀錄會留在資料庫）。

-- 1. org.notifications：站內通知 -----------------------------------------------------
CREATE TABLE org.notifications (
  id                 text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id             text NOT NULL REFERENCES control.orgs (id),
  recipient_party_id text CHECK (recipient_party_id IS NULL OR recipient_party_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  -- 通知種類，格式「領域.動作」，與 Mailer 的 kind 同一套命名
  kind               text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  title              text NOT NULL CHECK (btrim(title) <> ''),
  body               text NOT NULL,
  -- 點通知要去的站內路徑。只收站內路徑，擋掉外部網址與 // 開頭的寫法
  link_path          text CHECK (link_path IS NULL OR (link_path ~ '^/' AND link_path !~ '^//' AND link_path !~ '[\\\s]')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  read_at            timestamptz,
  read_by_party_id   text CHECK (read_by_party_id IS NULL OR read_by_party_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  UNIQUE (org_id, id)
);

CREATE INDEX notifications_by_time ON org.notifications (org_id, id DESC);
CREATE INDEX notifications_unread ON org.notifications (org_id) WHERE read_at IS NULL;

ALTER TABLE org.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.notifications
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- 2. org.notification_emails：待寄與已寄的通知 email ---------------------------------------
-- from_name 是寄件名義，由呼叫端傳入（例如「○○管理公司」）。sent_at 與 mailer_message_id 寄出後才有。
CREATE TABLE org.notification_emails (
  id                text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id            text NOT NULL REFERENCES control.orgs (id),
  notification_id   text,
  kind              text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  to_email          text NOT NULL CHECK (to_email ~ '^[^@\s,;]+@[^@\s,;]+$'),
  from_name         text NOT NULL CHECK (btrim(from_name) <> '' AND from_name !~ '[\r\n]'),
  subject           text NOT NULL CHECK (btrim(subject) <> '' AND subject !~ '[\r\n]'),
  body_text         text NOT NULL CHECK (btrim(body_text) <> ''),
  created_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  mailer_message_id text,
  UNIQUE (org_id, id),
  -- 複合外鍵（ADR-0012 陷阱 5）：email 只能掛在同一個組織的通知上
  FOREIGN KEY (org_id, notification_id) REFERENCES org.notifications (org_id, id)
);

CREATE INDEX notification_emails_by_notification ON org.notification_emails (org_id, notification_id);

ALTER TABLE org.notification_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.notification_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.notification_emails
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- 3. outbox 新增動作 send_email -------------------------------------------------------
-- subject_type 固定 'notification_email'，subject_id 是 org.notification_emails.id。
-- 其他票（例如 MIL-87）也會放寬這個 CHECK：兩份 migration 合併時，以最後執行的那份為準，
-- 它的清單必須包含所有票新增的動作，否則先執行的那份新增的動作會被擋掉。
ALTER TABLE org.outbox DROP CONSTRAINT outbox_action_check;
ALTER TABLE org.outbox ADD CONSTRAINT outbox_action_check
  CHECK (action IN ('create_sign_task', 'void_sign_task', 'resend_sign_task', 'send_email'));
