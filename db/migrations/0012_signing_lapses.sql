-- 簽署中失效紀錄（MIL-75 在 SQLite 建立，第二次同步 main 時搬進 PostgreSQL；ADR-0018 決議 11 情況 B）。
-- 由 runner 以 app_owner 執行。寫法照 0009：org_id、複合唯一鍵、複合外鍵、ENABLE 與 FORCE RLS。
--
-- 一列代表「某個執業人員席位在簽署事件到達時不可簽章」這個事實，以及它目前的處理狀態。
-- 複合唯一鍵 (org_id, contract_id, rule_id) 讓同一個席位只有一列，重複的事件不會重複撤回。
-- 狀態轉移見 src/lib/signing-lapse/types.ts 的 SigningLapseState。
-- 沒有 legacy_id：這張表在 main 上只有 MIL-75 之後的資料，MIL-90 搬資料時靠合約與簽署人的 legacy_id 對應。

-- 1. org.signing_lapses ----------------------------------------------------------------
-- signer_id 參照 org.signers.id（ULID 文字）。reasons 是不可簽章原因的 jsonb 陣列，一項一句。
-- 沒有 ON DELETE CASCADE：失效紀錄只在送簽後才有，送簽後的合約不是草稿，不會被刪。
-- 紀錄存在時，刪除合約由資料庫擋下，而不是讓失效的依據無聲消失。
CREATE TABLE org.signing_lapses (
  id          text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id      text NOT NULL REFERENCES control.orgs (id),
  contract_id text NOT NULL,
  signer_id   text NOT NULL,
  rule_id     text NOT NULL,
  state       text NOT NULL
                CHECK (state IN ('void_pending', 'void_failed', 'voided', 'completed_lapsed', 'task_ended')),
  reasons     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  -- 簽署事件時間（服務商提供，沒有時是系統收到事件的時間）
  event_at    timestamptz NOT NULL,
  void_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  -- 同一份合約內，一個席位（rule_id）一列
  UNIQUE (org_id, contract_id, rule_id),
  FOREIGN KEY (org_id, contract_id) REFERENCES org.contracts (org_id, id),
  FOREIGN KEY (org_id, signer_id) REFERENCES org.signers (org_id, id)
);

CREATE INDEX signing_lapses_contract ON org.signing_lapses (org_id, contract_id);

ALTER TABLE org.signing_lapses ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.signing_lapses FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.signing_lapses
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- 2. 合約歷程的新事件類型 ---------------------------------------------------------------
-- MIL-75 加 credential_lapsed 與 auto_void_failed，MIL-76 加 signers_merged。
-- 0004 的 CHECK 沒有命名，PostgreSQL 預設名是 contract_events_type_check。0004 已存在，不改它，另在這裡換掉。
ALTER TABLE org.contract_events DROP CONSTRAINT contract_events_type_check;
ALTER TABLE org.contract_events ADD CONSTRAINT contract_events_type_check
  CHECK (type IN ('created', 'sent', 'tenant_signed', 'signer_signed', 'declined', 'completed', 'voided', 'copied',
                  'credential_lapsed', 'auto_void_failed', 'signers_merged'));
