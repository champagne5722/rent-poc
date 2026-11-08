-- 簽署任務、簽署人、文件紀錄、outbox 與簽署任務路由（MIL-85，ADR-0010、ADR-0012、ADR-0020）。
-- 由 runner 以 app_owner 執行。寫法照 0004：org_id、複合唯一鍵、複合外鍵、ENABLE 與 FORCE RLS。
--
-- subject_id 存簽署標的的 ULID（合約）。簽署標的是多型的（type 加 id），所以沒有外鍵指向合約。
-- 服務商任務編號只留在 org.sign_tasks 與 control.sign_task_routes，簽署模組是唯一持有者（ADR-0010）。
-- 舊 SQLite 的整數 id 放 legacy_id，只供 MIL-90 對照，切換穩定 2 週後移除（ADR-0012 決議 9，MIL-93）。

-- 1. org.sign_tasks：簽署任務 --------------------------------------------------------
CREATE TABLE org.sign_tasks (
  id                text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id            text NOT NULL REFERENCES control.orgs (id),
  provider          text NOT NULL CHECK (provider IN ('dottedsign', 'mock')),
  provider_task_ref text NOT NULL,
  subject_type      text NOT NULL,
  subject_id        text NOT NULL CHECK (subject_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  status            text NOT NULL DEFAULT 'in_progress'
                      CHECK (status IN ('in_progress', 'completed', 'declined', 'voided')),
  legacy_id         integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz,
  UNIQUE (org_id, id),
  -- 一個簽署標的最多一個簽署任務（ADR-0010 決議 2）。唯一鍵含 org_id（ADR-0012 陷阱 6）。
  -- 服務商任務編號跨組織的唯一性由 control.sign_task_routes 的主鍵保證
  UNIQUE (org_id, subject_type, subject_id),
  UNIQUE (org_id, provider, provider_task_ref),
  UNIQUE (org_id, legacy_id)
);

ALTER TABLE org.sign_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.sign_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.sign_tasks
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- 2. org.signers：簽署人 -----------------------------------------------------------
-- 當前簽署人由資料推導：順序最前面的待簽者。電話與身分證字號不得寫入這張表。
-- concurrent_roles：兼任角色，角色字串的 jsonb 陣列，沒有兼任時是 NULL（ADR-0018 決議 9）。
-- 新增角色時，擁有該角色的票在自己的 migration 放寬 role 的 CHECK。
CREATE TABLE org.signers (
  id               text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id           text NOT NULL REFERENCES control.orgs (id),
  sign_task_id     text NOT NULL,
  position         integer NOT NULL CHECK (position >= 0),
  role             text NOT NULL CHECK (role IN ('party_a', 'party_b', 'practitioner')),
  name             text NOT NULL,
  email            text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'declined')),
  signed_at        timestamptz,
  concurrent_roles jsonb CHECK (concurrent_roles IS NULL OR jsonb_typeof(concurrent_roles) = 'array'),
  legacy_id        integer,
  UNIQUE (org_id, id),
  UNIQUE (org_id, sign_task_id, position),
  UNIQUE (org_id, legacy_id),
  FOREIGN KEY (org_id, sign_task_id) REFERENCES org.sign_tasks (org_id, id)
);

ALTER TABLE org.signers ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.signers FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.signers
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- 3. org.sign_task_files：簽署任務的文件紀錄 (ADR-0010 決議 10) ---------------------------
-- 已簽 PDF 與 Audit Trail File 以簽署任務為鍵。保存結果一律入庫：成功記檔案資訊，失敗記錯誤訊息供補抓。
-- 檔案本體在 data/ 下，這裡只記相對路徑。MIL-87 的 FileStore 完成後改記儲存位置。
CREATE TABLE org.sign_task_files (
  id           text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id       text NOT NULL REFERENCES control.orgs (id),
  sign_task_id text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('signed_pdf', 'audit_trail')),
  status       text NOT NULL CHECK (status IN ('saved', 'failed')),
  file_name    text NOT NULL,
  rel_path     text,
  byte_size    integer,
  content_type text,
  error        text,
  legacy_id    integer,
  saved_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, sign_task_id, kind),
  UNIQUE (org_id, legacy_id),
  FOREIGN KEY (org_id, sign_task_id) REFERENCES org.sign_tasks (org_id, id)
);

ALTER TABLE org.sign_task_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.sign_task_files FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.sign_task_files
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- 4. org.outbox：對外呼叫的紀錄與重試（ADR-0020 決議 5、6）----------------------------------
-- 業務資料與 outbox 列同交易寫入，提交後在同一請求內派送一次。排程的 drain-outbox（MIL-86）只負責重試。
-- 列只記意圖與結果，不存文件與簽署人個資：撤回、重寄的參數從簽署任務取，建立任務的文件只在記憶體。
--
-- status：
--   pending  等待派送或重試
--   sending  已認領、正在呼叫服務商。停太久的列由程式視為失敗（recoverStaleOutbox）
--   done     完成
--   failed   不自動重試的失敗（建立簽署任務。點點簽沒有冪等鍵，重試會多建任務）
--   dead     重試用完，轉人工處理清單（撤回、重寄）
--   skipped  派送時已不需要（例如撤回之前簽署任務已完成）
CREATE TABLE org.outbox (
  id                text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id            text NOT NULL REFERENCES control.orgs (id),
  action            text NOT NULL CHECK (action IN ('create_sign_task', 'void_sign_task', 'resend_sign_task')),
  subject_type      text NOT NULL,
  subject_id        text NOT NULL CHECK (subject_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sending', 'done', 'failed', 'dead', 'skipped')),
  -- 已派送的次數，認領時加一
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error        text,
  -- 建立任務成功但平台沒記下來時，留下服務商任務編號供人工清理孤兒任務
  provider_task_ref text,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz,
  completed_at      timestamptz,
  UNIQUE (org_id, id)
);

-- 同一個簽署標的、同一種動作，同時只有一列在進行。防止同時送簽多建任務，也讓撤回與重寄不重複排隊
CREATE UNIQUE INDEX outbox_one_open_per_action
  ON org.outbox (org_id, subject_type, subject_id, action)
  WHERE status IN ('pending', 'sending');
-- drain-outbox 認領到期的列
CREATE INDEX outbox_due ON org.outbox (org_id, next_attempt_at) WHERE status = 'pending';

ALTER TABLE org.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.outbox
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- 5. control.sign_task_routes：服務商任務編號對應組織（ADR-0012 決議 5）-------------------------
-- webhook 沒有組織脈絡，靠這張表查出 org_id，再開組織交易。與簽署任務同交易寫入。
-- control 不掛組織 RLS，權限逐表授予：app_rw 只能讀與新增，不能改、不能刪（路由列寫入後不變）。
-- 不能改用定義者函式查 org.sign_tasks：FORCE 讓函式 owner 也受 RLS 限制，結果是空值。
-- 主鍵 (provider, provider_task_ref) 保證服務商任務編號跨組織唯一，撞號由資料庫擋下。
CREATE TABLE control.sign_task_routes (
  provider          text NOT NULL CHECK (provider IN ('dottedsign', 'mock')),
  provider_task_ref text NOT NULL,
  org_id            text NOT NULL REFERENCES control.orgs (id),
  sign_task_id      text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_task_ref),
  UNIQUE (sign_task_id),
  FOREIGN KEY (org_id, sign_task_id) REFERENCES org.sign_tasks (org_id, id)
);

REVOKE ALL ON control.sign_task_routes FROM PUBLIC;
REVOKE ALL ON control.sign_task_routes FROM app_rw;
GRANT SELECT, INSERT ON control.sign_task_routes TO app_rw;
