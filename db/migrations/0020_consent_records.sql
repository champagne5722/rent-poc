-- 同意紀錄（MIL-84，PRD P0-24）。對象對某版告知表示同意或反對，只增不改。
-- 由 runner 以 app_owner 執行，表歸 app_owner，放在 org 區。
-- org 區預設給 app_rw 完整 DML（0001 的預設權限），這張表要收回 UPDATE 與 DELETE，只留 SELECT 與 INSERT。

CREATE TABLE org.consent_records (
  id               text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  -- 查「最新」的排序依據。同一個交易內 now() 相同，所以不用時間排序
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  org_id           text NOT NULL CHECK (org_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),

  -- 告知：類型、版本、當時文字的 SHA-256。文字本身在程式內，改版後舊文字仍可由版本號還原
  notice_type      text NOT NULL CHECK (notice_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  notice_version   integer NOT NULL CHECK (notice_version >= 1),
  text_sha256      text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),

  -- 對象：party ID 與 email 至少一個。沒有帳號的承租人只有 email，email 一律小寫
  subject_party_id text CHECK (subject_party_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  subject_email    text CHECK (subject_email = lower(subject_email) AND length(subject_email) <= 254
                               AND subject_email ~ '^[^@\s]+@[^@\s]+$'),
  CONSTRAINT consent_subject_present CHECK (subject_party_id IS NOT NULL OR subject_email IS NOT NULL),

  decision         text NOT NULL CHECK (decision IN ('agree', 'object')),
  -- 來源：in_app 登入後畫面、email_link 免登入回應頁、staff_recorded 人員代為登錄（如紙本）
  source           text NOT NULL CHECK (source IN ('in_app', 'email_link', 'staff_recorded')),

  -- 關聯標的（選填）：合約、簽署任務、案件、謄本等。兩個欄位同有或同無
  related_type     text CHECK (related_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  related_id       text CHECK (related_id <> '' AND length(related_id) <= 64),
  CONSTRAINT consent_related_both CHECK ((related_type IS NULL) = (related_id IS NULL)),

  -- 同交易寫入的稽核事件位置（audit.events 的 chain_id 與 seq）。鏈就是這個組織的鏈
  audit_chain_id   text NOT NULL,
  audit_seq        bigint NOT NULL CHECK (audit_seq >= 1),
  CONSTRAINT consent_audit_chain_is_org CHECK (audit_chain_id = org_id),

  recorded_at      timestamptz NOT NULL DEFAULT now()
);

-- latestConsent 的查詢：依對象與類型找最新一筆
CREATE INDEX consent_by_party ON org.consent_records (org_id, notice_type, subject_party_id, seq DESC)
  WHERE subject_party_id IS NOT NULL;
CREATE INDEX consent_by_email ON org.consent_records (org_id, notice_type, subject_email, seq DESC)
  WHERE subject_email IS NOT NULL;

-- 權限：只讀與新增
REVOKE ALL ON org.consent_records FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON org.consent_records FROM app_rw;
GRANT SELECT, INSERT ON org.consent_records TO app_rw;

-- 觸發器：擋下 superuser 與其他有權限的身分。superuser 的 UPDATE、DELETE、TRUNCATE 與擁有者的 TRUNCATE 會丟錯。
-- 擁有者 app_owner 在 FORCE RLS 下沒有政策，看不到任何列，所以它的 UPDATE 與 DELETE 影響 0 列，資料同樣不會變。
-- 沿用 audit.forbid_change 的做法，函式放 org 區。
CREATE FUNCTION org.forbid_consent_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '同意紀錄只增不改：不得對 % 執行 %', TG_TABLE_NAME, TG_OP;
END
$$;

CREATE TRIGGER consent_no_update_delete BEFORE UPDATE OR DELETE ON org.consent_records
  FOR EACH ROW EXECUTE FUNCTION org.forbid_consent_change();
CREATE TRIGGER consent_no_truncate BEFORE TRUNCATE ON org.consent_records
  FOR EACH STATEMENT EXECUTE FUNCTION org.forbid_consent_change();

-- RLS：ENABLE 加 FORCE，只看得到也只寫得進當下組織。沒有 UPDATE 與 DELETE 的政策
ALTER TABLE org.consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.consent_records FORCE  ROW LEVEL SECURITY;

CREATE POLICY org_isolation_select ON org.consent_records FOR SELECT TO app_rw
  USING (org_id = nullif(current_setting('app.org_id', true), ''));
CREATE POLICY org_isolation_insert ON org.consent_records FOR INSERT TO app_rw
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), ''));
