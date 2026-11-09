-- 證書影本與所屬業者同意書放 vault（MIL-111，ADR-0017 決議 10 與補充，ADR-0012 決議 3、4）。
-- 沿用 0044 的 vault.credential_evidence 與函式，只擴充兩個 CHECK 與登記函式的對象種類：
--   practitioner         證書影本。對象是 registry.practitioners，相符後刪除（delete_reason = matched）。
--   employment_consent   所屬業者的同意書。對象是 registry.practitioner_employments，在任職有效期間保留，
--                        任職結束或同意書到期後 30 日由 worker 刪除（屬 MIL-112，待法務確認 MIL-62 Q14）。
-- 由 runner 以 app_owner 執行。前半段用 app_owner 身分授權 vault_owner，後半段 SET LOCAL ROLE vault_owner 改物件（比照 0044）。

-- 1. 授權 vault_owner 讀新表、呼叫成員檢查 -----------------------------------------
GRANT SELECT ON registry.practitioners, registry.practitioner_employments TO vault_owner;
GRANT EXECUTE ON FUNCTION registry.assert_practice_member() TO vault_owner;

SET LOCAL ROLE vault_owner;

-- 2. 擴充 CHECK ---------------------------------------------------------------
ALTER TABLE vault.credential_evidence DROP CONSTRAINT credential_evidence_subject_type_check;
ALTER TABLE vault.credential_evidence ADD CONSTRAINT credential_evidence_subject_type_check
  CHECK (subject_type IN ('license', 'claim', 'practitioner', 'employment_consent'));

-- kind：業別證據檔記業別種類，證書影本與同意書記證書種類
ALTER TABLE vault.credential_evidence DROP CONSTRAINT credential_evidence_kind_check;
ALTER TABLE vault.credential_evidence ADD CONSTRAINT credential_evidence_kind_check
  CHECK (kind IN ('management', 'master_lease', 'brokerage', 'rental_housing_manager', 'real_estate_broker', 'real_estate_sales_agent'));

-- 3. 登記函式：加兩種對象 -------------------------------------------------------------
-- 規則同 0044：對象必須屬於目前組織，各種對象的錯誤相同（42501）。
--   practitioner：證書屬於呼叫者本人（app.party_id），呼叫者是目前執業主體組織的成員。
--   employment_consent：任職是呼叫者本人在目前組織的任職，且需要同意書。
CREATE OR REPLACE FUNCTION vault.register_credential_evidence(
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
  v_org   text := nullif(current_setting('app.org_id', true), '');
  v_party text := nullif(current_setting('app.party_id', true), '');
  v_ok    boolean;
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
  ELSIF p_subject_type = 'practitioner' THEN
    PERFORM registry.assert_practice_member();
    SELECT EXISTS (
      SELECT 1 FROM registry.practitioners p
       WHERE p.id = p_subject_id AND p.party_id = v_party AND p.certificate_kind = p_kind
    ) INTO v_ok;
  ELSIF p_subject_type = 'employment_consent' THEN
    PERFORM registry.assert_practice_member();
    SELECT EXISTS (
      SELECT 1 FROM registry.practitioner_employments m
        JOIN registry.practitioners p ON p.id = m.practitioner_id
        JOIN registry.practice_entities e ON e.id = m.entity_id
       WHERE m.id = p_subject_id AND p.party_id = v_party AND e.org_id = v_org
         AND m.consent_required AND m.state <> 'lapsed' AND m.certificate_kind = p_kind
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
