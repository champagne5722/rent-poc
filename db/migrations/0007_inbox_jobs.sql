-- webhook 的 inbox 與計時器的冪等紀錄（MIL-86，ADR-0020 決議 5、7、9）。
-- 由 runner 以 app_owner 執行。兩張表都在 control：webhook 與排程 job 沒有組織脈絡，
-- control 不掛組織 RLS，權限逐表授予（ADR-0012 決議 3）。新表沒有任何預設權限。

-- 1. control.inbox_messages：服務商的簽署事件 ------------------------------------------------
-- webhook 驗簽後先寫這張表，同一個請求內再處理一次。寫入成功就回 2xx，處理失敗留給 drain-inbox。
-- 只存標準化的簽署事件與原始 body 的 SHA-256，不存原始 body（ADR-0020 決議 9）：
-- control 沒有組織 RLS，原始 body 可能夾帶個資。
--
-- status：
--   pending     等待處理或重試
--   processing  已認領、正在處理。停太久的列由程式視為失敗（recoverStaleInbox）
--   done        事件已套用
--   ignored     處理過，但事件不需要套用（重複、亂序、email 不符、簽署標的不存在）
--   dead        重試用完，轉人工處理清單
CREATE TABLE control.inbox_messages (
  id                text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  provider          text NOT NULL CHECK (provider IN ('dottedsign', 'mock')),
  -- 原始 body 的 SHA-256（小寫十六進位）。去重鍵是服務商加它：服務商重送的 body 一字不差
  body_sha256       text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  provider_task_ref text NOT NULL,
  event_type        text NOT NULL CHECK (event_type IN ('signed', 'completed', 'declined', 'voided')),
  event_email       text,
  event_reason      text,
  occurred_at       timestamptz,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'done', 'ignored', 'dead')),
  -- 已處理的次數，認領時加一。找不到路由列也算一次
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error        text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz,
  processed_at      timestamptz,
  UNIQUE (provider, body_sha256)
);

-- drain-inbox 依到達順序認領
CREATE INDEX inbox_messages_open ON control.inbox_messages (provider, id) WHERE status IN ('pending', 'processing');
-- 同一個服務商任務的較早事件還沒處理完時，較晚的事件要等
CREATE INDEX inbox_messages_task ON control.inbox_messages (provider, provider_task_ref, id)
  WHERE status IN ('pending', 'processing');

REVOKE ALL ON control.inbox_messages FROM PUBLIC;
REVOKE ALL ON control.inbox_messages FROM app_rw;
-- 不給 DELETE：事件到達的紀錄只增不刪，保存期限另行決定
GRANT SELECT, INSERT, UPDATE ON control.inbox_messages TO app_rw;

-- 2. control.timer_fires：計時器的冪等紀錄（ADR-0020 決議 7，ADR-0016 決議 18）------------------
-- 冪等鍵是「主體:事件:日期」。scan-timers 在執行效果的同一個交易寫入這一列：
-- 寫入成功才執行效果，鍵已存在就略過，效果失敗整筆回滾，下一次掃描會重試。
-- 全域計時器（執業主體、證書、任職，資料在 registry）沒有組織，所以 org_id 可為 NULL。
CREATE TABLE control.timer_fires (
  idempotency_key text PRIMARY KEY CHECK (char_length(idempotency_key) BETWEEN 1 AND 300),
  timer           text NOT NULL,
  subject_id      text NOT NULL,
  event           text NOT NULL,
  -- 當日觸發是 YYYY-MM-DD，每月重查是 YYYY-MM
  fire_date       text NOT NULL CHECK (fire_date ~ '^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$'),
  org_id          text REFERENCES control.orgs (id),
  fired_at        timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON control.timer_fires FROM PUBLIC;
REVOKE ALL ON control.timer_fires FROM app_rw;
-- 寫入後不變，也不刪
GRANT SELECT, INSERT ON control.timer_fires TO app_rw;
