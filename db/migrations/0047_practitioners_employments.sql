-- 執業人員證書、任職與專任規則（MIL-111，ADR-0017 決議 4 到 7、11，ADR-0022 決議 9，ADR-0012 決議 8）。
-- 由 runner 以 app_owner 執行。registry 不掛組織 RLS，app_rw 沒有任何直接權限，所有讀寫都經下面的 SECURITY DEFINER 函式。
-- 在 0042（MIL-106）與 0043（MIL-109）上擴充，沿用 registry.review_items 與 registry.credential_checks，不另建一套。
-- 證據檔（證書影本、同意書）的 vault 部分在 0048。
--
-- 資料模型：
--   registry.practitioners             證書層。一個人（party）每種證書一列，驗證狀態全域一份，換公司時沿用（ADR-0017 決議 11）。
--   registry.practitioner_employments  任職層。一筆任職對應一個執業主體。新任職建新列，已結束的任職不回到 pending（決議 4）。
-- 業別層是 0042 的 practice_licenses。三層各自核對，順序不受限（決議 6）。
--
-- 專任排除約束（決議 7 第 2 點）：同一證號最多一筆「已驗證的管理人員任職」。用部分唯一索引實作，不用 btree_gist，
-- 避免正式資料庫與 PGlite 都要安裝擴充套件。已驗證代表任職進行中，結束時狀態轉 lapsed，所以不需要比對任職期間。
-- 約束只涵蓋 verified：兩家都 pending 時並存，由平台營運者判定哪一家相符。
--
-- 規則由 TypeScript 呼叫 src/lib/registry-rules 的純函式決定（decideEmploymentCreation、decideEmploymentVerification、
-- decideCredentialTransition）。函式只驗證傳入的 (目前狀態, 下一狀態, 結果) 是合法組合，並在狀態已被別的請求改掉時
-- 拒絕（SQLSTATE 40001）。排除約束是資料庫層的最後防線。

-- 1. practitioners：證書層 --------------------------------------------------
-- certificate_key = 證書種類:年:字:號。同一證號被兩個帳號登錄時，兩列並存（等營運者判定誰是本人），
-- 但已驗證的只能有一列（部分唯一索引）。這與任職的 pending 並存是同一個理由：否則別人能先登錄你的證號把你鎖住。
CREATE TABLE registry.practitioners (
  id               text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  party_id         text NOT NULL REFERENCES control.parties (id),
  certificate_kind text NOT NULL CHECK (certificate_kind IN ('rental_housing_manager', 'real_estate_broker', 'real_estate_sales_agent')),
  cert_year        text NOT NULL CHECK (cert_year ~ '^[0-9]{2,4}$'),
  cert_word        text NOT NULL CHECK (btrim(cert_word) <> '' AND char_length(cert_word) <= 20),
  cert_serial      text NOT NULL CHECK (cert_serial ~ '^[0-9]{1,10}$'),
  certificate_key  text NOT NULL,
  issued_on        date NOT NULL,
  -- 依 resim 登錄的效期為準（ADR-0017 決議 8）。送件時預填發證日加 4 年，營運者核對相符時登錄
  valid_until      date NOT NULL,
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'verified', 'lapsed')),
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  verified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz,
  UNIQUE (party_id, certificate_kind),
  UNIQUE (id, certificate_key, certificate_kind),
  CONSTRAINT practitioners_key_matches CHECK (certificate_key = certificate_kind || ':' || cert_year || ':' || cert_word || ':' || cert_serial),
  CONSTRAINT practitioners_valid_after_issue CHECK (valid_until > issued_on)
);
CREATE UNIQUE INDEX practitioners_one_verified_per_cert ON registry.practitioners (certificate_key) WHERE state = 'verified';
CREATE INDEX practitioners_key ON registry.practitioners (certificate_key);

-- 2. practitioner_employments：任職層 ----------------------------------------
-- started_on、ended_on 是任職期間（含頭含尾）。ended_on 空代表進行中。
-- 經紀人員為他家執行業務時 consent_required 為 true，所屬業者的同意書另有一筆 consent 審核項目。
-- consent_verified_at 有值且 consent_ended_at 空，任職標示「經所屬業者同意」。同意書失效由 MIL-112 的計時器寫 consent_ended_at。
CREATE TABLE registry.practitioner_employments (
  id                  text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  practitioner_id     text NOT NULL,
  certificate_key     text NOT NULL,
  certificate_kind    text NOT NULL,
  entity_id           text NOT NULL REFERENCES registry.practice_entities (id),
  state               text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'verified', 'lapsed')),
  started_on          date NOT NULL,
  ended_on            date,
  consent_required    boolean NOT NULL DEFAULT false,
  consent_verified_at timestamptz,
  consent_valid_until date,
  consent_ended_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz,
  -- 證號改了（補件時更正），任職跟著改
  FOREIGN KEY (practitioner_id, certificate_key, certificate_kind)
    REFERENCES registry.practitioners (id, certificate_key, certificate_kind) ON UPDATE CASCADE,
  CONSTRAINT employments_period_order CHECK (ended_on IS NULL OR ended_on >= started_on),
  CONSTRAINT employments_consent_only_when_required CHECK (consent_required OR (consent_verified_at IS NULL AND consent_ended_at IS NULL)),
  CONSTRAINT employments_consent_ended_after_verified CHECK (consent_ended_at IS NULL OR consent_verified_at IS NOT NULL)
);
-- 同一個人在同一個執業主體同時只有一筆未結束的任職
CREATE UNIQUE INDEX employments_one_live ON registry.practitioner_employments (practitioner_id, entity_id) WHERE state <> 'lapsed';
-- 專任排除約束：管理人員同一證號最多一筆已驗證任職
CREATE UNIQUE INDEX employments_exclusive_verified ON registry.practitioner_employments (certificate_key)
  WHERE state = 'verified' AND certificate_kind = 'rental_housing_manager';
CREATE INDEX employments_key ON registry.practitioner_employments (certificate_key);
CREATE INDEX employments_entity ON registry.practitioner_employments (entity_id);

-- 同一個對象同時只有一個待核對的證書、任職或同意書項目
CREATE UNIQUE INDEX review_items_one_open_per_subject ON registry.review_items (type, subject_id)
  WHERE status = 'open' AND type IN ('certificate', 'employment', 'consent');

REVOKE ALL ON registry.practitioners, registry.practitioner_employments FROM PUBLIC, app_rw;

-- 3. 內部函式（不授權給 app_rw）-------------------------------------------------
-- assert_practice_member：呼叫者必須是目前執業主體組織的成員，回傳呼叫者的 party ID。
-- party 來自 withTx 設定的 app.party_id，成員資格另外查（與 assert_operator 同樣的信任模型）。
CREATE FUNCTION registry.assert_practice_member() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_org   text := nullif(current_setting('app.org_id', true), '');
  v_party text := nullif(current_setting('app.party_id', true), '');
BEGIN
  IF v_org IS NULL OR v_party IS NULL THEN
    RAISE EXCEPTION '必須在組織成員的脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control.orgs o WHERE o.id = v_org AND o.kind = 'practice') THEN
    RAISE EXCEPTION '只有執業主體組織的成員能登錄證書與任職' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control.org_memberships m JOIN control.users u ON u.id = m.user_id
     WHERE m.org_id = v_org AND u.party_id = v_party
  ) THEN
    RAISE EXCEPTION '呼叫者不是這個組織的成員' USING ERRCODE = '42501';
  END IF;
  RETURN v_party;
END
$$;

-- append_check：寫一筆核對紀錄。證書、任職、同意書三個核對函式共用。
-- 稽核事件由呼叫端先寫（同交易，平台組織的鏈），位置傳進來。
CREATE FUNCTION registry.append_check(
  p_check_id       text,
  p_subject_type   text,
  p_subject_id     text,
  p_channel        text,
  p_query_source   text,
  p_observed       jsonb,
  p_result         text,
  p_evidence_ids   text[],
  p_note           text,
  p_operator       text,
  p_audit_chain_id text,
  p_audit_seq      bigint
) RETURNS void
LANGUAGE plpgsql
SET search_path = registry, pg_temp
AS $$
BEGIN
  -- NULL 參數會讓下面的 NOT IN 與比較得到 NULL 而不是 FALSE，檢查等於沒做，所以先擋
  IF p_check_id IS NULL OR p_subject_type IS NULL OR p_subject_id IS NULL OR p_channel IS NULL OR p_query_source IS NULL
     OR p_result IS NULL OR p_audit_chain_id IS NULL OR p_audit_seq IS NULL THEN
    RAISE EXCEPTION '核對紀錄的必填參數不得為空' USING ERRCODE = '22004';
  END IF;
  IF p_channel NOT IN ('gcis_manual', 'resim_manual', 'document_review') THEN
    RAISE EXCEPTION '第一版的核對管道只有 gcis_manual、resim_manual、document_review' USING ERRCODE = '22023';
  END IF;
  IF p_result NOT IN ('match', 'mismatch', 'not_found', 'revoked') THEN
    RAISE EXCEPTION '核對結果不合法：%', p_result USING ERRCODE = '22023';
  END IF;
  IF p_result <> 'match' AND btrim(coalesce(p_note, '')) = '' THEN
    RAISE EXCEPTION '核對結果不是相符時必須寫判定理由，執業人員靠它補件' USING ERRCODE = '22023';
  END IF;
  INSERT INTO registry.credential_checks (
    id, subject_type, subject_id, channel, query_source, observed, result,
    evidence_version_ids, note, checked_by, audit_chain_id, audit_seq
  ) VALUES (
    p_check_id, p_subject_type, p_subject_id, p_channel, btrim(p_query_source), coalesce(p_observed, '{}'::jsonb), p_result,
    coalesce(p_evidence_ids, '{}'), coalesce(p_note, ''), p_operator, p_audit_chain_id, p_audit_seq
  );
END
$$;

-- 驗證三態的合法轉移（與 record_license_check 相同的四種組合）
CREATE FUNCTION registry.assert_check_transition(p_expected text, p_new text, p_result text) RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_expected IS NULL OR p_new IS NULL THEN
    RAISE EXCEPTION '目前狀態與下一狀態不得為空' USING ERRCODE = '22004';
  END IF;
  IF NOT (
       (p_expected = 'pending'  AND p_new = 'pending'  AND p_result <> 'match')
    OR (p_expected = 'pending'  AND p_new = 'verified' AND p_result = 'match')
    OR (p_expected = 'verified' AND p_new = 'verified' AND p_result = 'match')
    OR (p_expected = 'verified' AND p_new = 'lapsed'   AND p_result <> 'match')
  ) THEN
    RAISE EXCEPTION '不合法的狀態轉移：% 到 %（結果 %）', p_expected, p_new, p_result USING ERRCODE = '22023';
  END IF;
END
$$;

-- 4. 執業人員端（組織成員脈絡）---------------------------------------------------
-- my_practitioner：呼叫者自己的證書，以及目前組織的任職。只看得到自己的資料與目前組織的任職，
-- 不回其他組織的任職（ADR-0012 決議 8）。
-- phase：awaiting_review 待核對、needs_resubmission 待補件、verified 已驗證、lapsed 已失效。
-- last_note 是營運者的判定理由，只在最新一筆（送件之後）不是相符時回傳。
CREATE FUNCTION registry.my_practitioner() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_org    text := nullif(current_setting('app.org_id', true), '');
  v_party  text := nullif(current_setting('app.party_id', true), '');
  v_entity text;
  v_certs  jsonb;
  v_jobs   jsonb;
BEGIN
  IF v_org IS NULL OR v_party IS NULL THEN
    RAISE EXCEPTION 'registry.my_practitioner 必須在組織成員的脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  SELECT e.id INTO v_entity FROM registry.practice_entities e WHERE e.org_id = v_org;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'certificate_kind', p.certificate_kind, 'cert_year', p.cert_year, 'cert_word', p.cert_word,
           'cert_serial', p.cert_serial, 'issued_on', p.issued_on, 'valid_until', p.valid_until, 'state', p.state,
           'phase', CASE
             WHEN p.state = 'verified' THEN 'verified'
             WHEN p.state = 'lapsed' THEN 'lapsed'
             WHEN EXISTS (SELECT 1 FROM registry.review_items r WHERE r.type = 'certificate' AND r.subject_id = p.id AND r.status = 'open') THEN 'awaiting_review'
             WHEN c.result IS NOT NULL AND c.result <> 'match' THEN 'needs_resubmission'
             ELSE 'awaiting_review' END,
           'last_result', c.result,
           'last_note', CASE WHEN c.result <> 'match' THEN c.note END,
           'last_checked_at', c.checked_at,
           'submitted_at', p.submitted_at) ORDER BY p.certificate_kind), '[]'::jsonb)
    INTO v_certs
    FROM registry.practitioners p
    LEFT JOIN LATERAL (
      SELECT k.result, k.note, k.checked_at FROM registry.credential_checks k
       WHERE k.subject_type = 'practitioner' AND k.subject_id = p.id AND k.checked_at >= p.submitted_at
       ORDER BY k.checked_at DESC, k.id DESC LIMIT 1
    ) c ON true
   WHERE p.party_id = v_party;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'practitioner_id', m.practitioner_id, 'certificate_kind', m.certificate_kind, 'state', m.state,
           'started_on', m.started_on, 'ended_on', m.ended_on,
           'phase', CASE
             WHEN m.state = 'verified' THEN 'verified'
             WHEN m.state = 'lapsed' THEN 'lapsed'
             WHEN EXISTS (SELECT 1 FROM registry.review_items r WHERE r.type = 'employment' AND r.subject_id = m.id AND r.status = 'open') THEN 'awaiting_review'
             WHEN c.result IS NOT NULL AND c.result <> 'match' THEN 'needs_resubmission'
             ELSE 'awaiting_review' END,
           'last_result', c.result,
           'last_note', CASE WHEN c.result <> 'match' THEN c.note END,
           'consent_required', m.consent_required,
           'consent_phase', CASE
             WHEN NOT m.consent_required THEN NULL
             WHEN m.consent_ended_at IS NOT NULL THEN 'ended'
             WHEN m.consent_verified_at IS NOT NULL THEN 'verified'
             WHEN EXISTS (SELECT 1 FROM registry.review_items r WHERE r.type = 'consent' AND r.subject_id = m.id AND r.status = 'open') THEN 'awaiting_review'
             WHEN cc.result IS NOT NULL AND cc.result <> 'match' THEN 'needs_resubmission'
             ELSE 'not_submitted' END,
           'consent_note', CASE WHEN cc.result <> 'match' AND m.consent_verified_at IS NULL THEN cc.note END,
           'consent_valid_until', m.consent_valid_until,
           'consented_by_entity', (m.consent_required AND m.consent_verified_at IS NOT NULL AND m.consent_ended_at IS NULL))
           ORDER BY m.created_at DESC, m.id DESC), '[]'::jsonb)
    INTO v_jobs
    FROM registry.practitioner_employments m
    JOIN registry.practitioners p ON p.id = m.practitioner_id
    LEFT JOIN LATERAL (
      SELECT k.result, k.note FROM registry.credential_checks k
       WHERE k.subject_type = 'employment' AND k.subject_id = m.id AND coalesce(k.observed ->> 'document', '') <> 'consent_letter'
       ORDER BY k.checked_at DESC, k.id DESC LIMIT 1
    ) c ON true
    LEFT JOIN LATERAL (
      SELECT k.result, k.note FROM registry.credential_checks k
       WHERE k.subject_type = 'employment' AND k.subject_id = m.id AND k.observed ->> 'document' = 'consent_letter'
       ORDER BY k.checked_at DESC, k.id DESC LIMIT 1
    ) cc ON true
   WHERE p.party_id = v_party AND m.entity_id = v_entity;

  RETURN jsonb_build_object('entity_registered', v_entity IS NOT NULL, 'certificates', v_certs, 'employments', v_jobs);
END
$$;

-- org_employments：目前執業主體組織的任職清單，組織成員都看得到。
-- 證號只回年與字，序號由 TypeScript 遮罩。不回別的組織的資料。
CREATE FUNCTION registry.org_employments() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_org    text := nullif(current_setting('app.org_id', true), '');
  v_party  text := nullif(current_setting('app.party_id', true), '');
  v_entity text;
  v_result jsonb;
BEGIN
  IF v_org IS NULL OR v_party IS NULL THEN
    RAISE EXCEPTION 'registry.org_employments 必須在組織成員的脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control.org_memberships m JOIN control.users u ON u.id = m.user_id WHERE m.org_id = v_org AND u.party_id = v_party
  ) THEN
    RAISE EXCEPTION '呼叫者不是這個組織的成員' USING ERRCODE = '42501';
  END IF;
  SELECT e.id INTO v_entity FROM registry.practice_entities e WHERE e.org_id = v_org;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'display_name', pa.display_name, 'certificate_kind', m.certificate_kind,
           'cert_year', p.cert_year, 'cert_word', p.cert_word, 'cert_serial', p.cert_serial,
           'state', m.state, 'started_on', m.started_on, 'ended_on', m.ended_on,
           'practitioner_state', p.state, 'valid_until', p.valid_until,
           'consent_required', m.consent_required,
           'consented_by_entity', (m.consent_required AND m.consent_verified_at IS NOT NULL AND m.consent_ended_at IS NULL),
           'is_self', (p.party_id = v_party))
           ORDER BY (m.state = 'lapsed'), m.started_on DESC, m.id), '[]'::jsonb)
    INTO v_result
    FROM registry.practitioner_employments m
    JOIN registry.practitioners p ON p.id = m.practitioner_id
    JOIN control.parties pa ON pa.id = p.party_id
   WHERE m.entity_id = v_entity;
  RETURN v_result;
END
$$;

-- employment_exclusivity_facts：同一證號在各執業主體的任職事實，給 decideEmploymentCreation 用。
-- 只回「自己這家」與「別家」的標記、狀態與任職期間，不回別家的 ID、名稱或人員（ADR-0012 決議 8）。
-- 呼叫者必須是證號本人的成員脈絡，所以不能拿來探測別人的證號。
CREATE FUNCTION registry.employment_exclusivity_facts(p_certificate_key text)
RETURNS TABLE (whose text, state text, started_on text, ended_on text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org    text := nullif(current_setting('app.org_id', true), '');
  v_entity text;
BEGIN
  PERFORM registry.assert_practice_member();
  SELECT e.id INTO v_entity FROM registry.practice_entities e WHERE e.org_id = v_org;
  RETURN QUERY
  SELECT CASE WHEN m.entity_id = v_entity THEN 'self' ELSE 'other' END, m.state, m.started_on::text, m.ended_on::text
    FROM registry.practitioner_employments m
   WHERE m.certificate_key = p_certificate_key;
END
$$;

-- submit_practitioner：本人登錄或補件證書。證據檔的中繼資料由 vault 的函式在同一個交易登記。
-- 狀態轉移由呼叫端用 decideCredentialTransition 算好傳入：新證書 expected 是 NULL，已失效換證是 lapsed，補件是 pending，
-- 下一狀態一律是 pending。已驗證的證書不接受送件。
-- 回傳證據檔該掛的對象 ('practitioner', 證書 ID) 與審核項目。
CREATE FUNCTION registry.submit_practitioner(
  p_practitioner_id text,
  p_kind            text,
  p_year            text,
  p_word            text,
  p_serial          text,
  p_issued_on       date,
  p_valid_until     date,
  p_expected_state  text,
  p_new_state       text,
  p_item_id         text
)
RETURNS TABLE (practitioner_id text, item_id text, state text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_party     text := registry.assert_practice_member();
  v_word      text := btrim(coalesce(p_word, ''));
  v_key       text;
  v_row       registry.practitioners;
  v_open_item text;
  v_item      text;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('rental_housing_manager', 'real_estate_broker', 'real_estate_sales_agent') THEN
    RAISE EXCEPTION '證書種類不合法：%', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_year IS NULL OR p_year !~ '^[0-9]{2,4}$' OR v_word = '' OR p_serial IS NULL OR p_serial !~ '^[0-9]{1,10}$' THEN
    RAISE EXCEPTION '證號的年、字、號格式不合法' USING ERRCODE = '22023';
  END IF;
  IF p_issued_on IS NULL OR p_valid_until IS NULL OR p_valid_until <= p_issued_on THEN
    RAISE EXCEPTION '發證日與效期必填，且效期必須晚於發證日' USING ERRCODE = '22023';
  END IF;
  IF p_new_state IS NULL OR p_new_state <> 'pending' OR (p_expected_state IS NOT NULL AND p_expected_state NOT IN ('pending', 'lapsed')) THEN
    RAISE EXCEPTION '送件只能把證書轉成 pending，來源只能是無、pending 或 lapsed' USING ERRCODE = '22023';
  END IF;
  v_key := p_kind || ':' || p_year || ':' || v_word || ':' || p_serial;

  SELECT p.* INTO v_row FROM registry.practitioners p WHERE p.party_id = v_party AND p.certificate_kind = p_kind FOR UPDATE;
  IF v_row.id IS NULL THEN
    IF p_expected_state IS NOT NULL THEN
      RAISE EXCEPTION '證書的狀態已被改動，請重新整理後再送件' USING ERRCODE = '40001';
    END IF;
    INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until)
    VALUES (p_practitioner_id, v_party, p_kind, p_year, v_word, p_serial, v_key, p_issued_on, p_valid_until);
    v_row.id := p_practitioner_id;
  ELSE
    IF v_row.state IS DISTINCT FROM p_expected_state THEN
      RAISE EXCEPTION '證書的狀態已被改動，請重新整理後再送件' USING ERRCODE = '40001';
    END IF;
    -- 已驗證的任職是以舊證號核對的，證號改了就不能沿用
    IF v_row.certificate_key <> v_key AND EXISTS (
      SELECT 1 FROM registry.practitioner_employments m WHERE m.practitioner_id = v_row.id AND m.state = 'verified'
    ) THEN
      RAISE EXCEPTION '還有已驗證的任職，不能更改證號' USING ERRCODE = '23514';
    END IF;
    UPDATE registry.practitioners p
       SET cert_year = p_year, cert_word = v_word, cert_serial = p_serial, certificate_key = v_key,
           issued_on = p_issued_on, valid_until = p_valid_until, state = 'pending', submitted_at = now(), updated_at = now()
     WHERE p.id = v_row.id;
  END IF;

  SELECT r.id INTO v_open_item FROM registry.review_items r
   WHERE r.type = 'certificate' AND r.subject_id = v_row.id AND r.status = 'open' LIMIT 1 FOR UPDATE;
  IF v_open_item IS NOT NULL THEN
    UPDATE registry.review_items r SET created_at = now() WHERE r.id = v_open_item;
    v_item := v_open_item;
  ELSE
    INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
    VALUES (p_item_id, 'certificate', 'practitioner', v_row.id, jsonb_build_object('certificate_kind', p_kind));
    v_item := p_item_id;
  END IF;
  RETURN QUERY SELECT v_row.id, v_item, 'pending'::text;
END
$$;

-- create_employment：本人在目前執業主體建立待驗證任職，同時排一筆 employment 審核項目。
-- 阻擋與提示的判定在 TypeScript（decideEmploymentCreation），這裡只負責寫入。
-- 同一個人在同一個執業主體已有未結束的任職時，部分唯一索引擋下（23505）。
CREATE FUNCTION registry.create_employment(
  p_employment_id    text,
  p_practitioner_id  text,
  p_started_on       date,
  p_consent_required boolean,
  p_item_id          text
)
RETURNS TABLE (employment_id text, item_id text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_party  text := registry.assert_practice_member();
  v_org    text := nullif(current_setting('app.org_id', true), '');
  v_entity text;
  v_cert   registry.practitioners;
BEGIN
  SELECT e.id INTO v_entity FROM registry.practice_entities e WHERE e.org_id = v_org;
  IF v_entity IS NULL THEN
    RAISE EXCEPTION '這個組織的執業主體還在審核中，審核完成後才能登錄任職' USING ERRCODE = '42501';
  END IF;
  SELECT p.* INTO v_cert FROM registry.practitioners p WHERE p.id = p_practitioner_id AND p.party_id = v_party;
  IF v_cert.id IS NULL THEN
    RAISE EXCEPTION '只能為自己的證書登錄任職' USING ERRCODE = '42501';
  END IF;
  IF p_started_on IS NULL THEN
    RAISE EXCEPTION '到職日必填' USING ERRCODE = '22023';
  END IF;

  INSERT INTO registry.practitioner_employments (id, practitioner_id, certificate_key, certificate_kind, entity_id, started_on, consent_required)
  VALUES (p_employment_id, v_cert.id, v_cert.certificate_key, v_cert.certificate_kind, v_entity, p_started_on, coalesce(p_consent_required, false));
  INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
  VALUES (p_item_id, 'employment', 'employment', p_employment_id, jsonb_build_object('certificate_kind', v_cert.certificate_kind));
  RETURN QUERY SELECT p_employment_id, p_item_id;
END
$$;

-- submit_consent：本人為需要同意書的任職送出同意書，排一筆 consent 審核項目。
-- 證據檔由 vault 的函式在同一個交易登記，對象是 ('employment_consent', 任職 ID)。
-- 同意書不符後補件，是同一個任職的新項目。
CREATE FUNCTION registry.submit_consent(p_employment_id text, p_item_id text)
RETURNS TABLE (employment_id text, item_id text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_party     text := registry.assert_practice_member();
  v_org       text := nullif(current_setting('app.org_id', true), '');
  v_emp       registry.practitioner_employments;
  v_open_item text;
  v_item      text;
BEGIN
  SELECT m.* INTO v_emp
    FROM registry.practitioner_employments m
    JOIN registry.practitioners p ON p.id = m.practitioner_id
    JOIN registry.practice_entities e ON e.id = m.entity_id
   WHERE m.id = p_employment_id AND p.party_id = v_party AND e.org_id = v_org
     FOR UPDATE OF m;
  IF v_emp.id IS NULL THEN
    RAISE EXCEPTION '找不到這個任職' USING ERRCODE = '42501';
  END IF;
  IF NOT v_emp.consent_required OR v_emp.state = 'lapsed' THEN
    RAISE EXCEPTION '這個任職不需要同意書' USING ERRCODE = '22023';
  END IF;
  IF v_emp.consent_verified_at IS NOT NULL AND v_emp.consent_ended_at IS NULL THEN
    RAISE EXCEPTION '同意書已核對' USING ERRCODE = '22023';
  END IF;

  SELECT r.id INTO v_open_item FROM registry.review_items r
   WHERE r.type = 'consent' AND r.subject_id = v_emp.id AND r.status = 'open' LIMIT 1 FOR UPDATE;
  IF v_open_item IS NOT NULL THEN
    UPDATE registry.review_items r SET created_at = now() WHERE r.id = v_open_item;
    v_item := v_open_item;
  ELSE
    INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
    VALUES (p_item_id, 'consent', 'employment', v_emp.id, jsonb_build_object('certificate_kind', v_emp.certificate_kind));
    v_item := p_item_id;
  END IF;
  RETURN QUERY SELECT v_emp.id, v_item;
END
$$;

-- end_employment：結束任職（已驗證 -> 已失效，事件 employment_ended）。
-- 執業主體的 admin 與任職本人能結束。其他成員不行。結束後同一個人才能在別家建立新任職（P0-05 規則 3）。
CREATE FUNCTION registry.end_employment(p_employment_id text, p_ended_on date, p_expected_state text, p_new_state text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_party text := registry.assert_practice_member();
  v_org   text := nullif(current_setting('app.org_id', true), '');
  v_emp   registry.practitioner_employments;
  v_owner text;
  v_role  text;
BEGIN
  IF p_expected_state IS DISTINCT FROM 'verified' OR p_new_state IS DISTINCT FROM 'lapsed' OR p_ended_on IS NULL THEN
    RAISE EXCEPTION '只有已驗證的任職能結束，且結束日必填' USING ERRCODE = '22023';
  END IF;
  SELECT m.* INTO v_emp
    FROM registry.practitioner_employments m JOIN registry.practice_entities e ON e.id = m.entity_id
   WHERE m.id = p_employment_id AND e.org_id = v_org FOR UPDATE OF m;
  IF v_emp.id IS NULL THEN
    RAISE EXCEPTION '找不到這個任職' USING ERRCODE = '42501';
  END IF;
  SELECT p.party_id INTO v_owner FROM registry.practitioners p WHERE p.id = v_emp.practitioner_id;
  SELECT m.role INTO v_role FROM control.org_memberships m JOIN control.users u ON u.id = m.user_id
   WHERE m.org_id = v_org AND u.party_id = v_party;
  IF v_party <> v_owner AND v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION '只有執業主體的管理員與任職本人能結束任職' USING ERRCODE = '42501';
  END IF;
  IF v_emp.state <> p_expected_state THEN
    RAISE EXCEPTION '任職的狀態已被改動，請重新整理後再操作' USING ERRCODE = '40001';
  END IF;
  IF p_ended_on < v_emp.started_on THEN
    RAISE EXCEPTION '結束日不得早於到職日' USING ERRCODE = '22023';
  END IF;
  UPDATE registry.practitioner_employments m
     SET state = p_new_state, ended_on = p_ended_on, updated_at = now()
   WHERE m.id = v_emp.id;
  RETURN v_emp.id;
END
$$;

-- 5. 審核台端（平台營運者脈絡）--------------------------------------------------
-- record_practitioner_check：登錄一筆證書核對。相符時 p_valid_until 必填（營運者依 resim 登錄的效期，ADR-0017 決議 8）。
-- p_item_id 不是 NULL 時結案該審核項目。p_certificate_key 是營運者看到的證號，核對期間本人改了證號就拒絕（40001）。
-- 同一證號已有別人的已驗證證書時，部分唯一索引擋下（23505，practitioners_one_verified_per_cert）。
CREATE FUNCTION registry.record_practitioner_check(
  p_check_id         text,
  p_item_id          text,
  p_practitioner_id  text,
  p_channel          text,
  p_query_source     text,
  p_observed         jsonb,
  p_result           text,
  p_evidence_ids     text[],
  p_note             text,
  p_expected_state   text,
  p_new_state        text,
  p_valid_until      date,
  p_certificate_key  text,
  p_audit_chain_id   text,
  p_audit_seq        bigint
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_op  text := registry.assert_operator();
  v_row registry.practitioners;
BEGIN
  PERFORM registry.assert_check_transition(p_expected_state, p_new_state, p_result);
  IF p_result = 'match' AND p_valid_until IS NULL THEN
    RAISE EXCEPTION '相符時必須登錄 resim 的效期' USING ERRCODE = '22004';
  END IF;

  SELECT p.* INTO v_row FROM registry.practitioners p WHERE p.id = p_practitioner_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION '找不到這個證書' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.state <> p_expected_state THEN
    RAISE EXCEPTION '證書的狀態已被改動，請重新整理後再登錄' USING ERRCODE = '40001';
  END IF;
  IF p_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM registry.review_items r
     WHERE r.id = p_item_id AND r.type = 'certificate' AND r.subject_id = p_practitioner_id AND r.status = 'open'
  ) THEN
    RAISE EXCEPTION '這個審核項目已結案，或不屬於這個證書' USING ERRCODE = '40001';
  END IF;
  IF p_item_id IS NOT NULL AND v_row.certificate_key IS DISTINCT FROM p_certificate_key THEN
    RAISE EXCEPTION '執業人員在核對期間更新了證號，請重新整理後再核對' USING ERRCODE = '40001';
  END IF;

  UPDATE registry.practitioners p
     SET state = p_new_state,
         valid_until = CASE WHEN p_result = 'match' THEN p_valid_until ELSE p.valid_until END,
         verified_at = CASE WHEN p_result = 'match' THEN now() ELSE p.verified_at END,
         updated_at = now()
   WHERE p.id = v_row.id;
  PERFORM registry.append_check(p_check_id, 'practitioner', p_practitioner_id, p_channel, p_query_source, p_observed, p_result,
                                p_evidence_ids, p_note, v_op, p_audit_chain_id, p_audit_seq);
  IF p_item_id IS NOT NULL THEN
    UPDATE registry.review_items r
       SET status = 'resolved', resolved_at = now(), resolved_by = v_op, resolution = p_result
     WHERE r.id = p_item_id;
  END IF;
  RETURN p_check_id;
END
$$;

-- record_employment_check：登錄一筆任職核對（resim 任職查詢）。
-- 轉成 verified 前，呼叫端已用 decideEmploymentVerification 判定專任。部分唯一索引 employments_exclusive_verified
-- 是最後防線：兩個營運者同時核對同一證號的兩家任職時，後提交的拿到 23505。
CREATE FUNCTION registry.record_employment_check(
  p_check_id         text,
  p_item_id          text,
  p_employment_id    text,
  p_channel          text,
  p_query_source     text,
  p_observed         jsonb,
  p_result           text,
  p_note             text,
  p_expected_state   text,
  p_new_state        text,
  p_certificate_key  text,
  p_audit_chain_id   text,
  p_audit_seq        bigint
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_op  text := registry.assert_operator();
  v_row registry.practitioner_employments;
BEGIN
  PERFORM registry.assert_check_transition(p_expected_state, p_new_state, p_result);

  SELECT m.* INTO v_row FROM registry.practitioner_employments m WHERE m.id = p_employment_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION '找不到這個任職' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.state <> p_expected_state THEN
    RAISE EXCEPTION '任職的狀態已被改動，請重新整理後再登錄' USING ERRCODE = '40001';
  END IF;
  IF p_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM registry.review_items r
     WHERE r.id = p_item_id AND r.type = 'employment' AND r.subject_id = p_employment_id AND r.status = 'open'
  ) THEN
    RAISE EXCEPTION '這個審核項目已結案，或不屬於這個任職' USING ERRCODE = '40001';
  END IF;
  IF p_item_id IS NOT NULL AND v_row.certificate_key IS DISTINCT FROM p_certificate_key THEN
    RAISE EXCEPTION '執業人員在核對期間更新了證號，請重新整理後再核對' USING ERRCODE = '40001';
  END IF;

  IF p_new_state <> v_row.state THEN
    UPDATE registry.practitioner_employments m SET state = p_new_state, updated_at = now() WHERE m.id = v_row.id;
  END IF;
  PERFORM registry.append_check(p_check_id, 'employment', p_employment_id, p_channel, p_query_source, p_observed, p_result,
                                '{}'::text[], p_note, v_op, p_audit_chain_id, p_audit_seq);
  IF p_item_id IS NOT NULL THEN
    UPDATE registry.review_items r
       SET status = 'resolved', resolved_at = now(), resolved_by = v_op, resolution = p_result
     WHERE r.id = p_item_id;
  END IF;
  RETURN p_check_id;
END
$$;

-- record_consent_check：登錄一筆同意書核對。核對紀錄的 subject 是任職，observed.document 是 consent_letter。
-- 相符：任職標示「經所屬業者同意」，p_valid_until 是同意書的有效期限（可空，代表未載明）。
-- 不符、查無、廢止：任職維持原狀，執業人員看到判定理由並補件。
CREATE FUNCTION registry.record_consent_check(
  p_check_id       text,
  p_item_id        text,
  p_employment_id  text,
  p_channel        text,
  p_query_source   text,
  p_observed       jsonb,
  p_result         text,
  p_evidence_ids   text[],
  p_note           text,
  p_valid_until    date,
  p_audit_chain_id text,
  p_audit_seq      bigint
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_op  text := registry.assert_operator();
  v_row registry.practitioner_employments;
BEGIN
  SELECT m.* INTO v_row FROM registry.practitioner_employments m WHERE m.id = p_employment_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION '找不到這個任職' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_row.consent_required OR v_row.state = 'lapsed' THEN
    RAISE EXCEPTION '這個任職不需要同意書' USING ERRCODE = '22023';
  END IF;
  IF p_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM registry.review_items r
     WHERE r.id = p_item_id AND r.type = 'consent' AND r.subject_id = p_employment_id AND r.status = 'open'
  ) THEN
    RAISE EXCEPTION '這個審核項目已結案，或不屬於這個任職' USING ERRCODE = '40001';
  END IF;

  PERFORM registry.append_check(p_check_id, 'employment', p_employment_id, p_channel, p_query_source,
                                coalesce(p_observed, '{}'::jsonb) || jsonb_build_object('document', 'consent_letter'),
                                p_result, p_evidence_ids, p_note, v_op, p_audit_chain_id, p_audit_seq);
  IF p_result = 'match' THEN
    UPDATE registry.practitioner_employments m
       SET consent_verified_at = now(), consent_valid_until = p_valid_until, consent_ended_at = NULL, updated_at = now()
     WHERE m.id = v_row.id;
  END IF;
  IF p_item_id IS NOT NULL THEN
    UPDATE registry.review_items r
       SET status = 'resolved', resolved_at = now(), resolved_by = v_op, resolution = p_result
     WHERE r.id = p_item_id;
  END IF;
  RETURN p_check_id;
END
$$;

-- practitioner_party：證書所屬的 party ID。只給營運者，補件通知要寄給本人。
CREATE FUNCTION registry.practitioner_party(p_practitioner_id text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_party text;
BEGIN
  PERFORM registry.assert_operator();
  SELECT p.party_id INTO v_party FROM registry.practitioners p WHERE p.id = p_practitioner_id;
  RETURN v_party;
END
$$;

-- review_queue：在 0043 的基礎上多列證書、任職、同意書三種項目。
-- 證書與任職項目帶人員姓名與證書種類，任職項目帶執業主體名稱。營運者是平台方，看得到這些。
CREATE OR REPLACE FUNCTION registry.review_queue(p_status text DEFAULT 'open', p_limit int DEFAULT 200)
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
           WHEN 'certificate' THEN jsonb_build_object(
             'party_name', pa.display_name, 'certificate_kind', pr.certificate_kind, 'state', pr.state)
           WHEN 'employment' THEN jsonb_build_object(
             'party_name', pa2.display_name, 'certificate_kind', em.certificate_kind, 'entity_name', e2.name,
             'state', em.state, 'consent_required', em.consent_required)
           WHEN 'consent' THEN jsonb_build_object(
             'party_name', pa2.display_name, 'certificate_kind', em.certificate_kind, 'entity_name', e2.name,
             'state', em.state, 'consent_required', em.consent_required)
           ELSE '{}'::jsonb
         END
    FROM registry.review_items r
    LEFT JOIN registry.practice_licenses l ON r.type = 'license' AND l.id = r.subject_id
    LEFT JOIN registry.practice_entities e ON e.id = CASE r.type WHEN 'license' THEN l.entity_id WHEN 'entity_claim' THEN r.subject_id END
    LEFT JOIN registry.practitioners pr ON r.type = 'certificate' AND pr.id = r.subject_id
    LEFT JOIN control.parties pa ON pa.id = pr.party_id
    LEFT JOIN registry.practitioner_employments em ON r.type IN ('employment', 'consent') AND em.id = r.subject_id
    LEFT JOIN registry.practitioners pr2 ON pr2.id = em.practitioner_id
    LEFT JOIN control.parties pa2 ON pa2.id = pr2.party_id
    LEFT JOIN registry.practice_entities e2 ON e2.id = em.entity_id
   WHERE r.status = p_status
     AND (r.type <> 'license' OR l.permit_no IS NOT NULL)
   ORDER BY CASE WHEN p_status = 'open' THEN r.created_at END ASC,
            CASE WHEN p_status = 'resolved' THEN r.resolved_at END DESC,
            r.id
   LIMIT least(greatest(p_limit, 1), 500);
END
$$;

-- review_item_detail：在 0043 的基礎上多回證書、任職與「同一證號的其他任職」。
-- competing_employments 讓營運者在兩家都待驗證時判定哪一家相符（ADR-0017 決議 7 第 2 點）。
-- 營運者是平台方，看得到兩家的名稱。這個函式只給營運者。
CREATE OR REPLACE FUNCTION registry.review_item_detail(p_item_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_item      registry.review_items;
  v_entity_id text;
  v_pract_id  text;
  v_emp       registry.practitioner_employments;
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
  ELSIF v_item.type = 'certificate' THEN
    v_pract_id := v_item.subject_id;
  ELSIF v_item.type IN ('employment', 'consent') THEN
    SELECT m.* INTO v_emp FROM registry.practitioner_employments m WHERE m.id = v_item.subject_id;
    v_pract_id := v_emp.practitioner_id;
    v_entity_id := v_emp.entity_id;
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
    'practitioner', (
      SELECT jsonb_build_object(
        'id', p.id, 'party_name', pa.display_name, 'certificate_kind', p.certificate_kind,
        'cert_year', p.cert_year, 'cert_word', p.cert_word, 'cert_serial', p.cert_serial, 'certificate_key', p.certificate_key,
        'issued_on', p.issued_on, 'valid_until', p.valid_until, 'state', p.state, 'submitted_at', p.submitted_at)
        FROM registry.practitioners p JOIN control.parties pa ON pa.id = p.party_id WHERE p.id = v_pract_id),
    'employment', (
      SELECT jsonb_build_object(
        'id', m.id, 'state', m.state, 'started_on', m.started_on, 'ended_on', m.ended_on,
        'certificate_key', m.certificate_key, 'entity_name', e.name,
        'consent_required', m.consent_required, 'consent_verified_at', m.consent_verified_at,
        'consent_valid_until', m.consent_valid_until, 'consent_ended_at', m.consent_ended_at)
        FROM registry.practitioner_employments m JOIN registry.practice_entities e ON e.id = m.entity_id
       WHERE v_item.type IN ('employment', 'consent') AND m.id = v_item.subject_id),
    'competing_employments', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', m.id, 'entity_name', e.name, 'state', m.state, 'started_on', m.started_on, 'ended_on', m.ended_on,
               'consent_required', m.consent_required,
               'consented_by_entity', (m.consent_required AND m.consent_verified_at IS NOT NULL AND m.consent_ended_at IS NULL),
               'party_name', pa.display_name)
             ORDER BY m.created_at, m.id)
        FROM registry.practitioner_employments m
        JOIN registry.practice_entities e ON e.id = m.entity_id
        JOIN registry.practitioners p ON p.id = m.practitioner_id
        JOIN control.parties pa ON pa.id = p.party_id
       WHERE v_item.type IN ('employment', 'consent') AND m.certificate_key = v_emp.certificate_key AND m.id <> v_emp.id
         AND m.state <> 'lapsed'), '[]'::jsonb),
    'checks', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', c.id, 'subject_type', c.subject_type, 'subject_id', c.subject_id, 'channel', c.channel,
               'query_source', c.query_source, 'observed', c.observed, 'result', c.result, 'note', c.note,
               'checked_by', c.checked_by, 'checked_at', c.checked_at) ORDER BY c.checked_at DESC, c.id DESC)
        FROM registry.credential_checks c
       WHERE (c.subject_type = 'license'
              AND c.subject_id IN (SELECT l.id FROM registry.practice_licenses l WHERE l.entity_id = v_entity_id)
              AND v_item.type IN ('license', 'entity_claim'))
          OR (c.subject_type = 'practitioner' AND c.subject_id = v_pract_id)
          OR (c.subject_type = 'employment' AND v_item.type IN ('employment', 'consent') AND c.subject_id = v_item.subject_id)), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END
$$;

-- 6. 給其他線的查詢 -------------------------------------------------------------
-- signing_facts：判定「可簽章」需要的事實（ADR-0017 決議 6，給 MIL-113 的 practiceRegistry 真實 adapter）。
-- 回傳一個 jsonb：該執業主體的各業別，以及指定人員（party）各自最新的任職與證書。
-- 每個人員一筆：三層狀態、valid_until、任職期間、三層最新核對紀錄 ID、party_id、employment_id、證號（遮罩前，adapter 負責遮罩）。
-- 因為有未遮罩的證號，只允許該執業主體自己的組織與平台營運者呼叫。屋主組織送簽等跨組織情境，
-- 由 MIL-113 加案件成員檢查後再放寬。
-- 「可簽章」本身由 D 線的 credentialStatusAt 判定，這裡只提供事實。
CREATE FUNCTION registry.signing_facts(p_entity_id text, p_party_ids text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_org     text := nullif(current_setting('app.org_id', true), '');
  v_is_op   boolean := nullif(current_setting('app.operator_id', true), '') IS NOT NULL;
  v_entity  registry.practice_entities;
  v_result  jsonb;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'registry.signing_facts 必須在組織或營運者脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF coalesce(array_length(p_party_ids, 1), 0) > 200 THEN
    RAISE EXCEPTION '一次最多查 200 位人員' USING ERRCODE = '22023';
  END IF;
  IF v_is_op THEN
    PERFORM registry.assert_operator();
  END IF;
  SELECT e.* INTO v_entity FROM registry.practice_entities e WHERE e.id = p_entity_id;
  -- 不是自己的執業主體與不存在回同一個結果：空
  IF v_entity.id IS NULL OR (NOT v_is_op AND v_entity.org_id <> v_org) THEN
    RETURN jsonb_build_object('licenses', '[]'::jsonb, 'practitioners', '[]'::jsonb);
  END IF;

  SELECT jsonb_build_object(
    'licenses', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'kind', l.kind, 'state', l.state,
               'last_check_id', (SELECT k.id FROM registry.credential_checks k
                                  WHERE k.subject_type = 'license' AND k.subject_id = l.id ORDER BY k.checked_at DESC, k.id DESC LIMIT 1))
             ORDER BY l.kind)
        FROM registry.practice_licenses l WHERE l.entity_id = v_entity.id), '[]'::jsonb),
    'practitioners', coalesce((
      SELECT jsonb_agg(f.fact ORDER BY f.party_id) FROM (
        SELECT DISTINCT ON (p.party_id, p.certificate_kind) p.party_id, jsonb_build_object(
          'party_id', p.party_id,
          'employment_id', m.id,
          'practitioner_id', p.id,
          'certificate_kind', p.certificate_kind,
          'certificate_no', jsonb_build_object('year', p.cert_year, 'word', p.cert_word, 'serial', p.cert_serial),
          'practitioner_state', p.state,
          'valid_until', p.valid_until,
          'practitioner_last_check_id', (SELECT k.id FROM registry.credential_checks k
                                          WHERE k.subject_type = 'practitioner' AND k.subject_id = p.id ORDER BY k.checked_at DESC, k.id DESC LIMIT 1),
          'employment_state', m.state,
          'employment_started_on', m.started_on,
          'employment_ended_on', m.ended_on,
          'employment_last_check_id', (SELECT k.id FROM registry.credential_checks k
                                        WHERE k.subject_type = 'employment' AND k.subject_id = m.id
                                          AND coalesce(k.observed ->> 'document', '') <> 'consent_letter'
                                        ORDER BY k.checked_at DESC, k.id DESC LIMIT 1),
          'consent_required', m.consent_required,
          'consented_by_entity', (m.consent_required AND m.consent_verified_at IS NOT NULL AND m.consent_ended_at IS NULL),
          'consent_valid_until', m.consent_valid_until
        ) AS fact
          FROM registry.practitioner_employments m
          JOIN registry.practitioners p ON p.id = m.practitioner_id
         WHERE m.entity_id = v_entity.id AND p.party_id = ANY (p_party_ids)
         ORDER BY p.party_id, p.certificate_kind, (m.state = 'verified') DESC, m.created_at DESC, m.id DESC
      ) f), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END
$$;

-- certificate_badges：標章投影（ADR-0017 決議 11，給 F 線 MIL-102 與案件頁）。
-- 證書層已驗證才有標章。只回 party_id、證書種類與核對日（台灣日期），不回證號與任何組織資料。
-- 任何組織脈絡都能呼叫。標章文字取自 registry-rules 的 certificateBadge()。
CREATE FUNCTION registry.certificate_badges(p_party_ids text[]) RETURNS TABLE (party_id text, certificate_kind text, checked_on text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF nullif(current_setting('app.org_id', true), '') IS NULL THEN
    RAISE EXCEPTION 'registry.certificate_badges 必須在組織或營運者脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF coalesce(array_length(p_party_ids, 1), 0) > 500 THEN
    RAISE EXCEPTION '一次最多查 500 位人員' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT p.party_id, p.certificate_kind,
         (SELECT ((k.checked_at AT TIME ZONE 'Asia/Taipei')::date)::text FROM registry.credential_checks k
           WHERE k.subject_type = 'practitioner' AND k.subject_id = p.id AND k.result = 'match'
           ORDER BY k.checked_at DESC, k.id DESC LIMIT 1)
    FROM registry.practitioners p
   WHERE p.party_id = ANY (p_party_ids) AND p.state = 'verified'
   ORDER BY p.party_id, p.certificate_kind;
END
$$;

-- 7. 權限 -------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  registry.assert_practice_member(),
  registry.append_check(text, text, text, text, text, jsonb, text, text[], text, text, text, bigint),
  registry.assert_check_transition(text, text, text),
  registry.my_practitioner(),
  registry.org_employments(),
  registry.employment_exclusivity_facts(text),
  registry.submit_practitioner(text, text, text, text, text, date, date, text, text, text),
  registry.create_employment(text, text, date, boolean, text),
  registry.submit_consent(text, text),
  registry.end_employment(text, date, text, text),
  registry.record_practitioner_check(text, text, text, text, text, jsonb, text, text[], text, text, text, date, text, text, bigint),
  registry.record_employment_check(text, text, text, text, text, jsonb, text, text, text, text, text, text, bigint),
  registry.record_consent_check(text, text, text, text, text, jsonb, text, text[], text, date, text, bigint),
  registry.practitioner_party(text),
  registry.signing_facts(text, text[]),
  registry.certificate_badges(text[])
  FROM PUBLIC;

-- append_check、assert_check_transition、assert_practice_member 是內部函式，不授權給 app_rw
GRANT EXECUTE ON FUNCTION
  registry.my_practitioner(),
  registry.org_employments(),
  registry.employment_exclusivity_facts(text),
  registry.submit_practitioner(text, text, text, text, text, date, date, text, text, text),
  registry.create_employment(text, text, date, boolean, text),
  registry.submit_consent(text, text),
  registry.end_employment(text, date, text, text),
  registry.record_practitioner_check(text, text, text, text, text, jsonb, text, text[], text, text, text, date, text, text, bigint),
  registry.record_employment_check(text, text, text, text, text, jsonb, text, text, text, text, text, text, bigint),
  registry.record_consent_check(text, text, text, text, text, jsonb, text, text[], text, date, text, bigint),
  registry.practitioner_party(text),
  registry.signing_facts(text, text[]),
  registry.certificate_badges(text[])
  TO app_rw;
