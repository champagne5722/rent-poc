-- 證據檔的中繼資料放 vault（MIL-109，ADR-0012 決議 3、4，ADR-0017 決議 10 與補充）。
-- 檔案本體在 FileStore，key 一律是 org/<org_id>/vault/credential-evidence/<檔案 ID>.<副檔名>（資料庫保證前綴）。
-- 由 runner 以 app_owner 執行。vault 的表與函式歸 vault_owner，app_rw 沒有任何直接權限，只能呼叫下面的 SECURITY DEFINER 函式。
-- 前半段用 app_owner 身分授權 vault_owner 讀必要的表，後半段 SET LOCAL ROLE vault_owner 建物件（比照 0010 的 audit）。
--
-- 存取規則：
-- - 登記：組織脈絡，只能掛在自己組織的業別或認領項目上。
-- - 列出中繼資料：營運者看全部，組織脈絡只看自己組織上傳的。
-- - 開啟（取得 key）、標記刪除：只有平台營運者。開啟與刪除的稽核事件由呼叫端在同交易寫（vault.read、vault.delete）。
-- 保留規則（待法務確認，MIL-62 Q14）：相符後刪除，不符時保留到補件相符或 30 日後由 worker 刪除。

-- 1. 授權 vault_owner 讀 registry 與 control 的必要欄位 ---------------------------
GRANT USAGE ON SCHEMA registry, control TO vault_owner;
GRANT SELECT ON registry.practice_entities, registry.practice_licenses, registry.review_items TO vault_owner;
GRANT EXECUTE ON FUNCTION registry.assert_operator() TO vault_owner;

SET LOCAL ROLE vault_owner;

-- 2. credential_evidence ---------------------------------------------------
-- state=deleted 時列留著，作為「何時、為何、怎麼刪」的證明。file_removed_at 空代表資料庫已標記刪除，
-- 但 FileStore 的檔案還沒確認刪掉，pending_file_removals() 列出它們供重試。
CREATE TABLE vault.credential_evidence (
  id              text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id          text NOT NULL,
  subject_type    text NOT NULL CHECK (subject_type IN ('license', 'claim')),
  subject_id      text NOT NULL,
  -- 認領方送件時掛在認領項目上，不知道是哪個業別的 ID，所以記業別種類，改歸屬時依它對回業別
  kind            text NOT NULL CHECK (kind IN ('management', 'master_lease', 'brokerage')),
  object_key      text NOT NULL,
  sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size       bigint NOT NULL CHECK (byte_size >= 0),
  content_type    text NOT NULL,
  file_name       text NOT NULL,
  uploaded_by     text NOT NULL,
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  state           text NOT NULL DEFAULT 'stored' CHECK (state IN ('stored', 'deleted')),
  deleted_at      timestamptz,
  delete_reason   text CHECK (delete_reason IN ('matched', 'expired', 'withdrawn', 'superseded')),
  delete_method   text CHECK (delete_method IN ('file_store_delete')),
  file_removed_at timestamptz,
  -- 組織前綴與 vault 區由資料庫保證，不只靠程式
  CONSTRAINT credential_evidence_key_prefix CHECK (starts_with(object_key, 'org/' || org_id || '/vault/credential-evidence/')),
  CONSTRAINT credential_evidence_deleted_complete CHECK (
    (state = 'stored' AND deleted_at IS NULL AND delete_reason IS NULL AND delete_method IS NULL AND file_removed_at IS NULL)
    OR (state = 'deleted' AND deleted_at IS NOT NULL AND delete_reason IS NOT NULL AND delete_method IS NOT NULL)
  )
);
CREATE INDEX credential_evidence_subject ON vault.credential_evidence (subject_type, subject_id) WHERE state = 'stored';
CREATE INDEX credential_evidence_pending_removal ON vault.credential_evidence (deleted_at) WHERE state = 'deleted' AND file_removed_at IS NULL;

REVOKE ALL ON vault.credential_evidence FROM PUBLIC, app_rw;

-- 3. 函式 -------------------------------------------------------------------

-- 登記一個證據檔。組織脈絡：p_subject 必須屬於目前組織。
--   license 對象：業別所屬的執業主體 org_id 等於目前組織。
--   claim 對象：待核對的認領項目，claimant_org_id 等於目前組織。
-- 兩種對象的錯誤相同（42501），不讓認領方看出自己是認領方。每個對象最多 10 個未刪除的證據檔。
CREATE FUNCTION vault.register_credential_evidence(
  p_id           text,
  p_subject_type text,
  p_subject_id   text,
  p_kind         text,
  p_object_key   text,
  p_sha256       text,
  p_byte_size    bigint,
  p_content_type text,
  p_file_name    text,
  p_uploaded_by  text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vault, pg_temp
AS $$
DECLARE
  v_org text := nullif(current_setting('app.org_id', true), '');
  v_ok  boolean;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'vault.register_credential_evidence 必須在組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF p_subject_type = 'license' THEN
    SELECT EXISTS (
      SELECT 1 FROM registry.practice_licenses l JOIN registry.practice_entities e ON e.id = l.entity_id
       WHERE l.id = p_subject_id AND e.org_id = v_org AND l.kind = p_kind
    ) INTO v_ok;
  ELSIF p_subject_type = 'claim' THEN
    SELECT EXISTS (
      SELECT 1 FROM registry.review_items r
       WHERE r.id = p_subject_id AND r.type = 'entity_claim' AND r.status = 'open'
         AND r.payload ->> 'claimant_org_id' = v_org
    ) INTO v_ok;
  ELSE
    RAISE EXCEPTION '證據檔的對象種類不合法：%', p_subject_type USING ERRCODE = '22023';
  END IF;
  IF NOT v_ok THEN
    RAISE EXCEPTION '這個組織不能對該對象上傳證據檔' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM vault.credential_evidence c
       WHERE c.subject_type = p_subject_type AND c.subject_id = p_subject_id AND c.state = 'stored') >= 10 THEN
    RAISE EXCEPTION '每個對象最多 10 個證據檔' USING ERRCODE = '54000';
  END IF;

  INSERT INTO vault.credential_evidence (
    id, org_id, subject_type, subject_id, kind, object_key, sha256, byte_size, content_type, file_name, uploaded_by
  ) VALUES (
    p_id, v_org, p_subject_type, p_subject_id, p_kind, p_object_key, p_sha256, p_byte_size, p_content_type, p_file_name, p_uploaded_by
  );
  RETURN p_id;
END
$$;

-- 列出證據檔的中繼資料（不含 key）。營運者看全部，組織脈絡只看自己上傳的。
CREATE FUNCTION vault.list_credential_evidence(p_subject_type text, p_subject_ids text[], p_include_deleted boolean DEFAULT false)
RETURNS TABLE (
  id text, subject_type text, subject_id text, kind text, file_name text, content_type text, byte_size bigint,
  uploaded_at timestamptz, state text, deleted_at timestamptz, delete_reason text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = vault, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org text := nullif(current_setting('app.org_id', true), '');
  v_is_operator boolean := nullif(current_setting('app.operator_id', true), '') IS NOT NULL;
BEGIN
  IF v_is_operator THEN
    PERFORM registry.assert_operator();
  ELSIF v_org IS NULL THEN
    RAISE EXCEPTION 'vault.list_credential_evidence 必須在組織或營運者脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT c.id, c.subject_type, c.subject_id, c.kind, c.file_name, c.content_type, c.byte_size,
         c.uploaded_at, c.state, c.deleted_at, c.delete_reason
    FROM vault.credential_evidence c
   WHERE c.subject_type = p_subject_type
     AND c.subject_id = ANY (p_subject_ids)
     AND (p_include_deleted OR c.state = 'stored')
     AND (v_is_operator OR c.org_id = v_org)
   ORDER BY c.uploaded_at, c.id;
END
$$;

-- 開啟一個證據檔：只有營運者，只能開未刪除的。回傳 key 與檔案資訊，呼叫端同交易寫 vault.read 事件後再讀 FileStore。
CREATE FUNCTION vault.open_credential_evidence(p_id text)
RETURNS TABLE (id text, subject_type text, subject_id text, object_key text, sha256 text, content_type text, file_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = vault, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM registry.assert_operator();
  RETURN QUERY
  SELECT c.id, c.subject_type, c.subject_id, c.object_key, c.sha256, c.content_type, c.file_name
    FROM vault.credential_evidence c WHERE c.id = p_id AND c.state = 'stored';
END
$$;

-- 標記刪除：只有營運者。只轉換 stored 的列，回傳實際轉換的列與 key，呼叫端提交後刪 FileStore 的檔案。
-- 重複呼叫不會再回傳同一列，所以稽核事件只會寫一次。
CREATE FUNCTION vault.mark_credential_evidence_deleted(p_ids text[], p_reason text)
RETURNS TABLE (id text, subject_type text, subject_id text, object_key text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vault, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM registry.assert_operator();
  IF p_reason NOT IN ('matched', 'expired', 'withdrawn', 'superseded') THEN
    RAISE EXCEPTION '刪除原因不合法：%', p_reason USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  UPDATE vault.credential_evidence c
     SET state = 'deleted', deleted_at = now(), delete_reason = p_reason, delete_method = 'file_store_delete'
   WHERE c.id = ANY (p_ids) AND c.state = 'stored'
  RETURNING c.id, c.subject_type, c.subject_id, c.object_key;
END
$$;

-- FileStore 的檔案確認刪掉之後登記。
CREATE FUNCTION vault.confirm_credential_evidence_file_removed(p_ids text[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vault, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM registry.assert_operator();
  UPDATE vault.credential_evidence c SET file_removed_at = now()
   WHERE c.id = ANY (p_ids) AND c.state = 'deleted' AND c.file_removed_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- 資料庫已標記刪除、FileStore 檔案還沒確認刪掉的證據檔，供重試。
CREATE FUNCTION vault.pending_file_removals(p_limit integer DEFAULT 100)
RETURNS TABLE (id text, object_key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = vault, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM registry.assert_operator();
  RETURN QUERY
  SELECT c.id, c.object_key FROM vault.credential_evidence c
   WHERE c.state = 'deleted' AND c.file_removed_at IS NULL
   ORDER BY c.deleted_at, c.id LIMIT least(greatest(p_limit, 1), 500);
END
$$;

-- 認領歸屬改給認領方時，把認領項目上的證據檔改掛到對應的業別。p_license_map 是 {業別種類: 業別 ID}。
CREATE FUNCTION vault.transfer_claim_evidence(p_claim_item_id text, p_license_map jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = vault, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM registry.assert_operator();
  UPDATE vault.credential_evidence c
     SET subject_type = 'license', subject_id = p_license_map ->> c.kind
   WHERE c.subject_type = 'claim' AND c.subject_id = p_claim_item_id AND c.state = 'stored'
     AND p_license_map ? c.kind;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- 4. 權限 -------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  vault.register_credential_evidence(text, text, text, text, text, text, bigint, text, text, text),
  vault.list_credential_evidence(text, text[], boolean),
  vault.open_credential_evidence(text),
  vault.mark_credential_evidence_deleted(text[], text),
  vault.confirm_credential_evidence_file_removed(text[]),
  vault.pending_file_removals(integer),
  vault.transfer_claim_evidence(text, jsonb)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  vault.register_credential_evidence(text, text, text, text, text, text, bigint, text, text, text),
  vault.list_credential_evidence(text, text[], boolean),
  vault.open_credential_evidence(text),
  vault.mark_credential_evidence_deleted(text[], text),
  vault.confirm_credential_evidence_file_removed(text[]),
  vault.pending_file_removals(integer),
  vault.transfer_claim_evidence(text, jsonb)
  TO app_rw;
