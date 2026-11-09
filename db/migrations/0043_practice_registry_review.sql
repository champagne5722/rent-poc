-- 執業主體送件、審核台核對與核對紀錄（MIL-109，ADR-0017 決議 1、4、10、11，ADR-0012 決議 8）。
-- 由 runner 以 app_owner 執行。registry 不掛組織 RLS，app_rw 沒有任何直接權限，所有讀寫都經下面的 SECURITY DEFINER 函式。
-- 在 0042（MIL-106）上擴充，沿用 registry.review_items 當審核台佇列，不另建一套。
--
-- 函式分兩類：
-- 1. 執業主體端（組織脈絡）：my_registration、submit_license。只看得到自己組織的登錄。
-- 2. 審核台端（平台營運者脈絡）：review_queue、review_item_detail、record_license_check、resolve_entity_claim。
--    每個都先呼叫 assert_operator()：app.operator_id 必須是平台組織的成員，且 app.org_id 必須是平台組織。
-- 3. 批次查詢：lookup_practice_entities，任何組織脈絡都能呼叫，只回稱謂需要的欄位。
--
-- 狀態轉移由 TypeScript 呼叫 src/lib/registry-rules 的純函式決定，函式只驗證傳入的 (目前狀態, 下一狀態) 是合法組合，
-- 並在狀態已被別的請求改掉時拒絕（SQLSTATE 40001），不在 SQL 裡重寫業別規則。
-- 證據檔的中繼資料在 vault（0044）。

-- 1. 欄位 -----------------------------------------------------------------
-- 營業項目與登記狀態由平台營運者依商工登記登錄（ADR-0017 Consequences），不是執業主體自己填。
ALTER TABLE registry.practice_entities
  ADD COLUMN business_item_codes     text[] NOT NULL DEFAULT '{}',
  ADD COLUMN registration_status     text,
  ADD COLUMN registration_checked_at timestamptz;

-- permit_no：執業主體送出的許可或登記證字號。NULL 代表還沒送件，審核台佇列不列這一項。
ALTER TABLE registry.practice_licenses
  ADD COLUMN permit_no    text,
  ADD COLUMN submitted_at timestamptz,
  ADD CONSTRAINT practice_licenses_permit_no_not_blank CHECK (permit_no IS NULL OR btrim(permit_no) <> '');

-- resolution：項目結案的原因。match 代表相符，其餘是不符、查無、廢止、認領判定或被取代。
ALTER TABLE registry.review_items
  ADD COLUMN resolution text CHECK (resolution IN
    ('match', 'mismatch', 'not_found', 'revoked', 'claim_to_claimant', 'claim_keep_registrant', 'superseded')),
  ADD CONSTRAINT review_items_resolution_with_status CHECK ((status = 'resolved') = (resolution IS NOT NULL));

-- 2. credential_checks：核對紀錄，只增不改（ADR-0017 決議 10）----------------------
-- 更正只能新增一筆。UPDATE、DELETE、TRUNCATE 由觸發器擋下，擁有者也一樣。
-- audit_chain_id 與 audit_seq 指向同交易寫入的稽核事件（平台組織的鏈）。
-- evidence_version_ids 是核對當下參考的證據檔 ID。檔案相符後會刪除，ID 仍留在紀錄裡。
-- 系統不存查詢頁截圖，observed 只放 PRD P0-04 個資規則列的欄位。
CREATE TABLE registry.credential_checks (
  id                   text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  subject_type         text NOT NULL CHECK (subject_type IN ('license', 'practitioner', 'employment')),
  subject_id           text NOT NULL,
  channel              text NOT NULL CHECK (channel IN ('gcis_manual', 'gcis_api', 'resim_manual', 'document_review', 'resim_batch')),
  query_source         text NOT NULL CHECK (btrim(query_source) <> ''),
  observed             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(observed) = 'object'),
  result               text NOT NULL CHECK (result IN ('match', 'mismatch', 'not_found', 'revoked')),
  evidence_version_ids text[] NOT NULL DEFAULT '{}',
  note                 text NOT NULL DEFAULT '',
  checked_by           text NOT NULL,
  checked_at           timestamptz NOT NULL DEFAULT now(),
  audit_chain_id       text NOT NULL,
  audit_seq            bigint NOT NULL CHECK (audit_seq >= 1)
);
CREATE INDEX credential_checks_subject ON registry.credential_checks (subject_type, subject_id, checked_at DESC, id DESC);

CREATE FUNCTION registry.forbid_check_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '核對紀錄只增不改：不得對 % 執行 %，更正請新增一筆', TG_TABLE_NAME, TG_OP;
END
$$;

CREATE TRIGGER credential_checks_no_update_delete BEFORE UPDATE OR DELETE ON registry.credential_checks
  FOR EACH ROW EXECUTE FUNCTION registry.forbid_check_change();
CREATE TRIGGER credential_checks_no_truncate BEFORE TRUNCATE ON registry.credential_checks
  FOR EACH STATEMENT EXECUTE FUNCTION registry.forbid_check_change();

REVOKE ALL ON registry.credential_checks FROM PUBLIC, app_rw;

-- 3. 權限檢查（內部函式，不授權給 app_rw）--------------------------------------
-- 平台營運者脈絡：withTx 的 operator 脈絡設定 app.operator_id 與 app.org_id（平台組織）。
-- 兩個設定 app_rw 自己也能 set_config，所以這裡另外查成員資格：operator_id 必須是平台組織的成員。
-- 這與組織 RLS 的信任模型相同（應用程式負責設定脈絡），差別是偽造要知道營運者的使用者 ID。
CREATE FUNCTION registry.assert_operator() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_op  text := nullif(current_setting('app.operator_id', true), '');
  v_org text := nullif(current_setting('app.org_id', true), '');
BEGIN
  IF v_op IS NULL OR v_org IS NULL OR NOT EXISTS (
    SELECT 1 FROM control.org_memberships m JOIN control.orgs o ON o.id = m.org_id
     WHERE m.user_id = v_op AND o.id = v_org AND o.kind = 'platform'
  ) THEN
    RAISE EXCEPTION '只有平台營運者能執行這個動作' USING ERRCODE = '42501';
  END IF;
  RETURN v_op;
END
$$;

-- 4. 執業主體端 -----------------------------------------------------------------
-- my_registration：目前組織的登錄與各業別的進度。
-- 第二個組織認領同一統編時沒有 practice_entities 列，改由 entity_claim 項目合成同樣形狀的回應，
-- 畫面不得區分兩者（ADR-0012 決議 8）。認領方看到的 phase 與登錄者一致：未送件、待核對、待補件。
-- phase 的值：not_submitted 尚未送件、awaiting_review 待核對、needs_resubmission 待補件、verified 已驗證、lapsed 已失效。
-- last_note 是平台營運者的判定理由，只在最新一筆不是相符時回傳，執業主體據此補件。
CREATE FUNCTION registry.my_registration()
RETURNS TABLE (
  tax_id          text,
  name            text,
  entity_type     text,
  kind            text,
  license_id      text,
  state           text,
  permit_no       text,
  phase           text,
  last_result     text,
  last_note       text,
  last_checked_at timestamptz,
  submitted_at    timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org    text := nullif(current_setting('app.org_id', true), '');
  v_entity text;
  v_claim  registry.review_items;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'registry.my_registration 必須在組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;

  SELECT e.id INTO v_entity FROM registry.practice_entities e WHERE e.org_id = v_org;
  IF v_entity IS NOT NULL THEN
    RETURN QUERY
    SELECT e.tax_id, e.name, e.entity_type, l.kind, l.id, l.state, l.permit_no,
           CASE
             WHEN l.state = 'verified' THEN 'verified'
             WHEN l.state = 'lapsed' THEN 'lapsed'
             WHEN l.permit_no IS NULL THEN 'not_submitted'
             WHEN EXISTS (SELECT 1 FROM registry.review_items r
                           WHERE r.type = 'license' AND r.subject_id = l.id AND r.status = 'open') THEN 'awaiting_review'
             WHEN c.result IS NOT NULL AND c.result <> 'match' THEN 'needs_resubmission'
             ELSE 'awaiting_review'
           END,
           c.result,
           CASE WHEN c.result <> 'match' THEN c.note END,
           c.checked_at,
           l.submitted_at
      FROM registry.practice_entities e
      JOIN registry.practice_licenses l ON l.entity_id = e.id
      LEFT JOIN LATERAL (
        -- 只算目前這一次送件之後的核對。改歸屬後，原登錄者時期的判定理由不得讓認領方看到
        SELECT k.result, k.note, k.checked_at FROM registry.credential_checks k
         WHERE k.subject_type = 'license' AND k.subject_id = l.id
           AND l.submitted_at IS NOT NULL AND k.checked_at >= l.submitted_at
         ORDER BY k.checked_at DESC, k.id DESC LIMIT 1
      ) c ON true
     WHERE e.id = v_entity
     ORDER BY l.kind;
    RETURN;
  END IF;

  SELECT r.* INTO v_claim FROM registry.review_items r
   WHERE r.type = 'entity_claim' AND r.payload ->> 'claimant_org_id' = v_org
   ORDER BY r.created_at DESC, r.id DESC LIMIT 1;
  IF v_claim.id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT v_claim.payload ->> 'tax_id', v_claim.payload ->> 'name', v_claim.payload ->> 'entity_type',
         k.kind, NULL::text, 'pending'::text,
         v_claim.payload -> 'submissions' -> k.kind ->> 'permit_no',
         CASE
           WHEN v_claim.payload -> 'submissions' -> k.kind IS NULL THEN 'not_submitted'
           WHEN v_claim.status = 'open' THEN 'awaiting_review'
           ELSE 'needs_resubmission'
         END,
         CASE WHEN v_claim.status = 'resolved' THEN 'mismatch' END,
         CASE WHEN v_claim.status = 'resolved' THEN v_claim.payload ->> 'resolution_note' END,
         v_claim.resolved_at,
         (v_claim.payload -> 'submissions' -> k.kind ->> 'submitted_at')::timestamptz
    FROM jsonb_array_elements_text(v_claim.payload -> 'kinds') AS k(kind)
   ORDER BY k.kind;
END
$$;

-- submit_license：執業主體送出業別、證字號。證據檔的中繼資料由 vault 的函式在同一個交易登記。
-- 狀態轉移由呼叫端用 decideCredentialTransition 算好傳入：新業別 expected 是 NULL，已失效換證 expected 是 lapsed，
-- 補件 expected 是 pending，下一狀態一律是 pending。已驗證的業別不接受送件。
-- 回傳證據檔該掛的對象：登錄者是 ('license', 業別 ID)，認領方是 ('claim', 認領項目 ID)。
-- 兩條路徑的回傳形狀與錯誤相同，不讓認領方看出差別。
CREATE FUNCTION registry.submit_license(
  p_kind           text,
  p_permit_no      text,
  p_license_id     text,
  p_item_id        text,
  p_expected_state text,
  p_new_state      text
)
RETURNS TABLE (subject_type text, subject_id text, item_id text, state text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org        text := nullif(current_setting('app.org_id', true), '');
  v_entity     registry.practice_entities;
  v_license    registry.practice_licenses;
  v_claim      registry.review_items;
  v_open_item  text;
  v_item       text;
  v_kinds      jsonb;
  v_permit     text := btrim(coalesce(p_permit_no, ''));
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'registry.submit_license 必須在組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control.orgs o WHERE o.id = v_org AND o.kind = 'practice') THEN
    RAISE EXCEPTION '只有執業主體組織能送件' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('management', 'master_lease', 'brokerage') THEN
    RAISE EXCEPTION '業別不合法：%', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_new_state IS NULL THEN
    RAISE EXCEPTION '下一狀態不得為空' USING ERRCODE = '22004';
  END IF;
  IF v_permit = '' THEN
    RAISE EXCEPTION '許可或登記證字號不得為空' USING ERRCODE = '22023';
  END IF;
  IF p_new_state <> 'pending' OR p_expected_state IS NOT NULL AND p_expected_state NOT IN ('pending', 'lapsed') THEN
    RAISE EXCEPTION '送件只能把業別轉成 pending，來源只能是無、pending 或 lapsed' USING ERRCODE = '22023';
  END IF;

  SELECT e.* INTO v_entity FROM registry.practice_entities e WHERE e.org_id = v_org;
  IF v_entity.id IS NOT NULL THEN
    SELECT l.* INTO v_license FROM registry.practice_licenses l
     WHERE l.entity_id = v_entity.id AND l.kind = p_kind FOR UPDATE;
    IF v_license.id IS NOT NULL THEN
      IF v_license.state IS DISTINCT FROM p_expected_state THEN
        RAISE EXCEPTION '業別的狀態已被改動，請重新整理後再送件' USING ERRCODE = '40001';
      END IF;
      UPDATE registry.practice_licenses l
         SET permit_no = v_permit, submitted_at = now(), state = p_new_state, updated_at = now()
       WHERE l.id = v_license.id;
    ELSE
      IF p_expected_state IS NOT NULL THEN
        RAISE EXCEPTION '業別的狀態已被改動，請重新整理後再送件' USING ERRCODE = '40001';
      END IF;
      INSERT INTO registry.practice_licenses (id, entity_id, kind, state, permit_no, submitted_at)
      VALUES (p_license_id, v_entity.id, p_kind, p_new_state, v_permit, now());
      v_license.id := p_license_id;
    END IF;

    -- 同一個業別同時只有一個待核對項目。MIL-106 登錄時已排了一筆，送件時把等待時間的起點移到現在
    SELECT r.id INTO v_open_item FROM registry.review_items r
     WHERE r.type = 'license' AND r.subject_id = v_license.id AND r.status = 'open' LIMIT 1 FOR UPDATE;
    IF v_open_item IS NOT NULL THEN
      UPDATE registry.review_items r
         SET created_at = now(), payload = r.payload || jsonb_build_object('kind', p_kind)
       WHERE r.id = v_open_item;
      v_item := v_open_item;
    ELSE
      INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
      VALUES (p_item_id, 'license', 'license', v_license.id, jsonb_build_object('kind', p_kind));
      v_item := p_item_id;
    END IF;
    RETURN QUERY SELECT 'license'::text, v_license.id, v_item, p_new_state;
    RETURN;
  END IF;

  -- 認領方：沒有 practice_entities 列。送件內容記在認領項目裡，營運者判定歸屬時一併看
  IF p_expected_state IS NOT NULL AND p_expected_state <> 'pending' THEN
    RAISE EXCEPTION '業別的狀態已被改動，請重新整理後再送件' USING ERRCODE = '40001';
  END IF;
  SELECT r.* INTO v_claim FROM registry.review_items r
   WHERE r.type = 'entity_claim' AND r.payload ->> 'claimant_org_id' = v_org
   ORDER BY r.created_at DESC, r.id DESC LIMIT 1 FOR UPDATE;
  IF v_claim.id IS NULL THEN
    RAISE EXCEPTION '這個組織沒有執業主體登錄' USING ERRCODE = '42501';
  END IF;

  v_kinds := v_claim.payload -> 'kinds';
  IF NOT (v_kinds ? p_kind) THEN
    v_kinds := v_kinds || to_jsonb(p_kind);
  END IF;

  IF v_claim.status = 'open' THEN
    UPDATE registry.review_items r
       SET payload = jsonb_set(
             jsonb_set(r.payload || jsonb_build_object('submissions', coalesce(r.payload -> 'submissions', '{}'::jsonb)), '{kinds}', v_kinds),
             ARRAY['submissions', p_kind],
             jsonb_build_object('permit_no', v_permit, 'submitted_at', now()),
             true)
     WHERE r.id = v_claim.id;
    v_item := v_claim.id;
  ELSE
    -- 上一次判定不通過，重新送件就是一筆新的認領項目
    INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
    VALUES (
      p_item_id, 'entity_claim', 'entity', v_claim.subject_id,
      jsonb_set(
        jsonb_set((v_claim.payload - 'resolution_note') || jsonb_build_object('submissions', coalesce(v_claim.payload -> 'submissions', '{}'::jsonb)), '{kinds}', v_kinds),
        ARRAY['submissions', p_kind],
        jsonb_build_object('permit_no', v_permit, 'submitted_at', now()),
        true)
    );
    v_item := p_item_id;
  END IF;
  RETURN QUERY SELECT 'claim'::text, v_item, v_item, 'pending'::text;
END
$$;

-- 5. 審核台端 -------------------------------------------------------------------
-- review_queue：佇列。預設列待核對項目，最久的在前。summary 只放畫面判定需要的欄位。
-- license 項目沒有 permit_no（還沒送件）時不列，因為沒有東西可核對。entity_claim 一排進來就列。
CREATE FUNCTION registry.review_queue(p_status text DEFAULT 'open', p_limit int DEFAULT 200)
RETURNS TABLE (
  id           text,
  type         text,
  subject_type text,
  subject_id   text,
  status       text,
  created_at   timestamptz,
  resolved_at  timestamptz,
  resolution   text,
  summary      jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM registry.assert_operator();
  IF p_status NOT IN ('open', 'resolved') THEN
    RAISE EXCEPTION 'p_status 必須是 open 或 resolved' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT r.id, r.type, r.subject_type, r.subject_id, r.status, r.created_at, r.resolved_at, r.resolution,
         CASE r.type
           WHEN 'license' THEN jsonb_build_object(
             'entity_name', e.name, 'tax_id', e.tax_id, 'entity_type', e.entity_type,
             'kind', l.kind, 'permit_no', l.permit_no, 'state', l.state)
           WHEN 'entity_claim' THEN jsonb_build_object(
             'entity_name', e.name, 'tax_id', e.tax_id, 'entity_type', e.entity_type,
             'kinds', r.payload -> 'kinds')
           ELSE '{}'::jsonb
         END
    FROM registry.review_items r
    LEFT JOIN registry.practice_licenses l ON r.type = 'license' AND l.id = r.subject_id
    LEFT JOIN registry.practice_entities e ON e.id = CASE r.type WHEN 'license' THEN l.entity_id ELSE r.subject_id END
   WHERE r.status = p_status
     AND (r.type <> 'license' OR l.permit_no IS NOT NULL)
   ORDER BY CASE WHEN p_status = 'open' THEN r.created_at END ASC,
            CASE WHEN p_status = 'resolved' THEN r.resolved_at END DESC,
            r.id
   LIMIT least(greatest(p_limit, 1), 500);
END
$$;

-- review_item_detail：核對表單與歸屬判定需要的全部資料，一個 jsonb。找不到項目回 NULL。
-- 營運者是平台方，看得到兩個組織的名稱。這個函式只給營運者，執業主體端看不到。
CREATE FUNCTION registry.review_item_detail(p_item_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_item      registry.review_items;
  v_entity_id text;
  v_result    jsonb;
BEGIN
  PERFORM registry.assert_operator();
  SELECT r.* INTO v_item FROM registry.review_items r WHERE r.id = p_item_id;
  IF v_item.id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_item.type = 'license' THEN
    SELECT l.entity_id INTO v_entity_id FROM registry.practice_licenses l WHERE l.id = v_item.subject_id;
  ELSIF v_item.type = 'entity_claim' THEN
    v_entity_id := v_item.subject_id;
  END IF;

  SELECT jsonb_build_object(
    'item', jsonb_build_object(
      'id', v_item.id, 'type', v_item.type, 'subject_type', v_item.subject_type, 'subject_id', v_item.subject_id,
      'status', v_item.status, 'resolution', v_item.resolution, 'created_at', v_item.created_at,
      'resolved_at', v_item.resolved_at),
    'entity', (
      SELECT jsonb_build_object(
        'id', e.id, 'tax_id', e.tax_id, 'name', e.name, 'entity_type', e.entity_type,
        'org_id', e.org_id, 'org_name', o.name,
        'business_item_codes', to_jsonb(e.business_item_codes),
        'registration_status', e.registration_status, 'registration_checked_at', e.registration_checked_at,
        'licenses', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
                   'id', l.id, 'kind', l.kind, 'state', l.state, 'permit_no', l.permit_no, 'submitted_at', l.submitted_at)
                 ORDER BY l.kind)
            FROM registry.practice_licenses l WHERE l.entity_id = e.id), '[]'::jsonb))
        FROM registry.practice_entities e JOIN control.orgs o ON o.id = e.org_id
       WHERE e.id = v_entity_id),
    'license', (
      SELECT jsonb_build_object('id', l.id, 'kind', l.kind, 'state', l.state, 'permit_no', l.permit_no, 'submitted_at', l.submitted_at)
        FROM registry.practice_licenses l WHERE v_item.type = 'license' AND l.id = v_item.subject_id),
    'claim', CASE WHEN v_item.type = 'entity_claim' THEN jsonb_build_object(
      'claimant_org_id', v_item.payload ->> 'claimant_org_id',
      'claimant_org_name', (SELECT o.name FROM control.orgs o WHERE o.id = v_item.payload ->> 'claimant_org_id'),
      'tax_id', v_item.payload ->> 'tax_id', 'name', v_item.payload ->> 'name',
      'entity_type', v_item.payload ->> 'entity_type',
      'kinds', v_item.payload -> 'kinds',
      'submissions', coalesce(v_item.payload -> 'submissions', '{}'::jsonb),
      'resolution_note', v_item.payload ->> 'resolution_note') END,
    'checks', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', c.id, 'subject_id', c.subject_id, 'channel', c.channel, 'query_source', c.query_source,
               'observed', c.observed, 'result', c.result, 'note', c.note,
               'checked_by', c.checked_by, 'checked_at', c.checked_at) ORDER BY c.checked_at DESC, c.id DESC)
        FROM registry.credential_checks c
       WHERE c.subject_type = 'license'
         AND c.subject_id IN (SELECT l.id FROM registry.practice_licenses l WHERE l.entity_id = v_entity_id)), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END
$$;

-- record_license_check：登錄一筆業別核對紀錄，並依傳入的狀態轉移更新業別與項目。
-- 合法的 (目前狀態, 下一狀態, 結果)：
--   pending  -> pending   結果不是 match（不符、查無、廢止都維持待驗證，等補件）
--   pending  -> verified  結果 match
--   verified -> verified  結果 match（重查仍相符）
--   verified -> lapsed    結果不是 match（重查不符、登記狀態不是核准設立）
-- 是否允許 verified 由呼叫端用 decideCredentialTransition 與 checkLicenseEligibility 決定，這裡不重寫規則。
-- p_business_item_codes、p_registration_status 不是 NULL 時一併更新執業主體的營業項目與登記狀態。
-- p_item_id 不是 NULL 時結案該審核項目（項目必須是這個業別的待核對 license 項目）。
-- 稽核事件由呼叫端先寫（同交易），位置傳進來存在紀錄裡。
CREATE FUNCTION registry.record_license_check(
  p_check_id            text,
  p_item_id             text,
  p_license_id          text,
  p_channel             text,
  p_query_source        text,
  p_observed            jsonb,
  p_result              text,
  p_evidence_ids        text[],
  p_note                text,
  p_expected_state      text,
  p_new_state           text,
  p_business_item_codes text[],
  p_registration_status text,
  p_audit_chain_id      text,
  p_audit_seq           bigint,
  p_permit_no           text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_op      text := registry.assert_operator();
  v_license registry.practice_licenses;
BEGIN
  -- NULL 參數會讓下面的 NOT IN 與比較得到 NULL 而不是 FALSE，檢查等於沒做，所以先擋
  IF p_check_id IS NULL OR p_license_id IS NULL OR p_channel IS NULL OR p_query_source IS NULL OR p_result IS NULL
     OR p_expected_state IS NULL OR p_new_state IS NULL OR p_audit_chain_id IS NULL OR p_audit_seq IS NULL THEN
    RAISE EXCEPTION '核對紀錄的必填參數不得為空' USING ERRCODE = '22004';
  END IF;
  IF p_channel NOT IN ('gcis_manual', 'resim_manual', 'document_review') THEN
    RAISE EXCEPTION '第一版的核對管道只有 gcis_manual、resim_manual、document_review' USING ERRCODE = '22023';
  END IF;
  IF p_result NOT IN ('match', 'mismatch', 'not_found', 'revoked') THEN
    RAISE EXCEPTION '核對結果不合法：%', p_result USING ERRCODE = '22023';
  END IF;
  IF p_result <> 'match' AND btrim(coalesce(p_note, '')) = '' THEN
    RAISE EXCEPTION '核對結果不是相符時必須寫判定理由，執業主體靠它補件' USING ERRCODE = '22023';
  END IF;
  IF NOT (
       (p_expected_state = 'pending'  AND p_new_state = 'pending'  AND p_result <> 'match')
    OR (p_expected_state = 'pending'  AND p_new_state = 'verified' AND p_result = 'match')
    OR (p_expected_state = 'verified' AND p_new_state = 'verified' AND p_result = 'match')
    OR (p_expected_state = 'verified' AND p_new_state = 'lapsed'   AND p_result <> 'match')
  ) THEN
    RAISE EXCEPTION '不合法的狀態轉移：% 到 %（結果 %）', p_expected_state, p_new_state, p_result USING ERRCODE = '22023';
  END IF;

  SELECT l.* INTO v_license FROM registry.practice_licenses l WHERE l.id = p_license_id FOR UPDATE;
  IF v_license.id IS NULL THEN
    RAISE EXCEPTION '找不到這個業別' USING ERRCODE = 'P0002';
  END IF;
  IF v_license.state <> p_expected_state THEN
    RAISE EXCEPTION '業別的狀態已被改動，請重新整理後再登錄' USING ERRCODE = '40001';
  END IF;

  IF p_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM registry.review_items r
     WHERE r.id = p_item_id AND r.type = 'license' AND r.subject_id = p_license_id AND r.status = 'open'
  ) THEN
    RAISE EXCEPTION '這個審核項目已結案，或不屬於這個業別' USING ERRCODE = '40001';
  END IF;
  -- 營運者核對的是他看到的證字號。執業主體在這之間改了字號，新字號沒人核對過，不得轉成已驗證
  IF p_item_id IS NOT NULL AND v_license.permit_no IS DISTINCT FROM p_permit_no THEN
    RAISE EXCEPTION '執業主體在核對期間更新了證字號，請重新整理後再核對' USING ERRCODE = '40001';
  END IF;

  IF p_business_item_codes IS NOT NULL THEN
    UPDATE registry.practice_entities e SET business_item_codes = p_business_item_codes WHERE e.id = v_license.entity_id;
  END IF;
  IF p_registration_status IS NOT NULL THEN
    UPDATE registry.practice_entities e
       SET registration_status = p_registration_status, registration_checked_at = now()
     WHERE e.id = v_license.entity_id;
  END IF;

  IF p_new_state <> v_license.state THEN
    UPDATE registry.practice_licenses l SET state = p_new_state, updated_at = now() WHERE l.id = p_license_id;
  END IF;

  INSERT INTO registry.credential_checks (
    id, subject_type, subject_id, channel, query_source, observed, result,
    evidence_version_ids, note, checked_by, audit_chain_id, audit_seq
  ) VALUES (
    p_check_id, 'license', p_license_id, p_channel, btrim(p_query_source), coalesce(p_observed, '{}'::jsonb), p_result,
    coalesce(p_evidence_ids, '{}'), coalesce(p_note, ''), v_op, p_audit_chain_id, p_audit_seq
  );

  IF p_item_id IS NOT NULL THEN
    UPDATE registry.review_items r
       SET status = 'resolved', resolved_at = now(), resolved_by = v_op, resolution = p_result
     WHERE r.id = p_item_id;
  END IF;
  RETURN p_check_id;
END
$$;

-- resolve_entity_claim：判定第二個組織認領同一統編的歸屬（ADR-0017 決議 11，ADR-0012 決議 8）。
--   keep_registrant  維持原登錄者。認領方看到「核對未通過」與判定理由，可以補件重送。
--   to_claimant      歸屬改給認領方。只在沒有任何已驗證的業別時允許，已驗證的要先以核對紀錄（revoked）轉成失效。
--                    執業主體名稱與組織型態改成認領方送出的值，業別的證字號改成認領方送的（沒送就清空），
--                    認領方送的業別若執業主體還沒有就建立，原登錄者留下的待核對項目標為 superseded，
--                    有證字號的業別重新排一筆待核對項目。
-- p_license_ids、p_item_ids 是新業別與新項目要用的 ID，數量要夠用（多給無妨）。
-- 回傳 to_claimant 的前登錄者組織與認領方組織，呼叫端據此處理證據檔與通知。keep_registrant 回傳空集合。
CREATE FUNCTION registry.resolve_entity_claim(
  p_item_id        text,
  p_decision       text,
  p_note           text,
  p_license_ids    text[],
  p_item_ids       text[],
  p_audit_chain_id text,
  p_audit_seq      bigint
)
RETURNS TABLE (claimant_org_id text, previous_org_id text, entity_id text, license_ids jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_op        text := registry.assert_operator();
  v_item      registry.review_items;
  v_entity    registry.practice_entities;
  v_claimant  text;
  v_kind      text;
  v_license   registry.practice_licenses;
  v_license_n int := 0;
  v_item_n    int := 0;
  v_map       jsonb := '{}'::jsonb;
  v_permit    text;
  v_old_item  text;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('keep_registrant', 'to_claimant') THEN
    RAISE EXCEPTION 'p_decision 必須是 keep_registrant 或 to_claimant' USING ERRCODE = '22023';
  END IF;
  IF btrim(coalesce(p_note, '')) = '' THEN
    RAISE EXCEPTION '判定歸屬必須寫理由' USING ERRCODE = '22023';
  END IF;

  SELECT r.* INTO v_item FROM registry.review_items r
   WHERE r.id = p_item_id AND r.type = 'entity_claim' FOR UPDATE;
  IF v_item.id IS NULL THEN
    RAISE EXCEPTION '找不到這個認領項目' USING ERRCODE = 'P0002';
  END IF;
  IF v_item.status <> 'open' THEN
    RAISE EXCEPTION '這個認領項目已結案' USING ERRCODE = '40001';
  END IF;
  v_claimant := v_item.payload ->> 'claimant_org_id';

  IF p_decision = 'keep_registrant' THEN
    UPDATE registry.review_items r
       SET status = 'resolved', resolved_at = now(), resolved_by = v_op, resolution = 'claim_keep_registrant',
           payload = r.payload || jsonb_build_object('resolution_note', btrim(p_note), 'audit_chain_id', p_audit_chain_id, 'audit_seq', p_audit_seq)
     WHERE r.id = p_item_id;
    RETURN;
  END IF;

  SELECT e.* INTO v_entity FROM registry.practice_entities e WHERE e.id = v_item.subject_id FOR UPDATE;
  -- 鎖住所有業別列再檢查：同時進行的核對（record_license_check 也鎖業別列）要嘛先提交讓這裡看到已驗證，要嘛等這裡結束
  PERFORM 1 FROM registry.practice_licenses l WHERE l.entity_id = v_entity.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM registry.practice_licenses l WHERE l.entity_id = v_entity.id AND l.state = 'verified') THEN
    RAISE EXCEPTION '執業主體還有已驗證的業別，請先以核對紀錄轉成失效再改歸屬' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control.orgs o WHERE o.id = v_claimant AND o.kind = 'practice') THEN
    RAISE EXCEPTION '認領方不是執業主體組織' USING ERRCODE = '22023';
  END IF;

  claimant_org_id := v_claimant;
  previous_org_id := v_entity.org_id;
  entity_id := v_entity.id;

  UPDATE registry.practice_entities e
     SET org_id = v_claimant,
         name = v_item.payload ->> 'name',
         entity_type = v_item.payload ->> 'entity_type'
   WHERE e.id = v_entity.id;

  -- 原登錄者排著的待核對項目不再有效
  UPDATE registry.review_items r
     SET status = 'resolved', resolved_at = now(), resolved_by = v_op, resolution = 'superseded'
   WHERE r.type = 'license' AND r.status = 'open'
     AND r.subject_id IN (SELECT l.id FROM registry.practice_licenses l WHERE l.entity_id = v_entity.id);

  -- 先建認領方送的、執業主體還沒有的業別
  FOR v_kind IN SELECT jsonb_array_elements_text(v_item.payload -> 'kinds') LOOP
    IF NOT EXISTS (SELECT 1 FROM registry.practice_licenses l WHERE l.entity_id = v_entity.id AND l.kind = v_kind) THEN
      v_license_n := v_license_n + 1;
      IF v_license_n > coalesce(array_length(p_license_ids, 1), 0) THEN
        RAISE EXCEPTION '業別 ID 數量不夠' USING ERRCODE = '22023';
      END IF;
      INSERT INTO registry.practice_licenses (id, entity_id, kind) VALUES (p_license_ids[v_license_n], v_entity.id, v_kind);
    END IF;
  END LOOP;

  -- 所有業別的證字號改成認領方送的。沒送的清空，狀態維持（已失效的要重新送件）
  FOR v_license IN SELECT l.* FROM registry.practice_licenses l WHERE l.entity_id = v_entity.id ORDER BY l.kind LOOP
    v_permit := v_item.payload -> 'submissions' -> v_license.kind ->> 'permit_no';
    UPDATE registry.practice_licenses l
       -- submitted_at 設成現在：my_registration 只算送件之後的核對，原登錄者時期的判定理由因此不會外露
       SET permit_no = v_permit,
           submitted_at = CASE WHEN v_permit IS NOT NULL THEN now() END,
           state = CASE WHEN v_permit IS NOT NULL AND l.state = 'lapsed' THEN 'pending' ELSE l.state END,
           updated_at = now()
     WHERE l.id = v_license.id;
    v_map := v_map || jsonb_build_object(v_license.kind, v_license.id);
    IF v_permit IS NOT NULL THEN
      v_item_n := v_item_n + 1;
      IF v_item_n > coalesce(array_length(p_item_ids, 1), 0) THEN
        RAISE EXCEPTION '項目 ID 數量不夠' USING ERRCODE = '22023';
      END IF;
      INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
      VALUES (p_item_ids[v_item_n], 'license', 'license', v_license.id, jsonb_build_object('kind', v_license.kind));
    END IF;
  END LOOP;

  UPDATE registry.review_items r
     SET status = 'resolved', resolved_at = now(), resolved_by = v_op, resolution = 'claim_to_claimant',
         payload = r.payload || jsonb_build_object('resolution_note', btrim(p_note), 'audit_chain_id', p_audit_chain_id, 'audit_seq', p_audit_seq)
   WHERE r.id = p_item_id;
  license_ids := v_map;
  RETURN NEXT;
END
$$;

-- 6. 批次查詢 -------------------------------------------------------------------
-- lookup_practice_entities：以執業主體 ID 清單一次查出名稱與各業別的驗證狀態（F 線資產總覽的需求，MIL-94）。
-- 法定稱謂由呼叫端用 src/lib/labels 的 statutoryTitle 組，這裡只回業別與狀態。
-- 只回 ID、名稱、業別、狀態。不回統編、組織 ID、人員（ADR-0012 決議 8）。查無的 ID 不出現在結果裡，
-- 與「ID 不存在」不可區分。任何組織脈絡都能呼叫，單次最多 500 個 ID。
CREATE FUNCTION registry.lookup_practice_entities(p_ids text[])
RETURNS TABLE (entity_id text, name text, kind text, state text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF nullif(current_setting('app.org_id', true), '') IS NULL THEN
    RAISE EXCEPTION 'registry.lookup_practice_entities 必須在組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF coalesce(array_length(p_ids, 1), 0) > 500 THEN
    RAISE EXCEPTION '一次最多查 500 個執業主體' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT e.id, e.name, l.kind, l.state
    FROM registry.practice_entities e
    LEFT JOIN registry.practice_licenses l ON l.entity_id = e.id
   WHERE e.id = ANY (p_ids)
   ORDER BY e.id, l.kind;
END
$$;

-- 7. 權限 -----------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  registry.forbid_check_change(),
  registry.assert_operator(),
  registry.my_registration(),
  registry.submit_license(text, text, text, text, text, text),
  registry.review_queue(text, int),
  registry.review_item_detail(text),
  registry.record_license_check(text, text, text, text, text, jsonb, text, text[], text, text, text, text[], text, text, bigint, text),
  registry.resolve_entity_claim(text, text, text, text[], text[], text, bigint),
  registry.lookup_practice_entities(text[])
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  registry.my_registration(),
  registry.submit_license(text, text, text, text, text, text),
  registry.review_queue(text, int),
  registry.review_item_detail(text),
  registry.record_license_check(text, text, text, text, text, jsonb, text, text[], text, text, text, text[], text, text, bigint, text),
  registry.resolve_entity_claim(text, text, text, text[], text[], text, bigint),
  registry.lookup_practice_entities(text[])
  TO app_rw;
