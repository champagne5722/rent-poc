-- practiceRegistry 真實 adapter 的查詢函式（MIL-113，ADR-0023 決議 8、ADR-0021 決議 3、ADR-0012 決議 8）。
-- 由 runner 以 app_owner 執行。編號用 0070：0046 排在 0047 之前，不能引用 0047 的表與函式。
-- registry 不掛組織 RLS，app_rw 沒有任何直接權限，所有讀取都經下面的 SECURITY DEFINER 函式。
-- 沒有新表。0047 的 registry.signing_facts() 不動：它仍只允許執業主體自己的組織與營運者呼叫，
-- 跨組織的情境改走這裡的 registry.signing_view()。
--
-- 呼叫者與執業主體的關係（registry.caller_relation，內部函式，不授權給 app_rw）：
--   own        呼叫者是該執業主體自己的組織，或是平台營運者。
--   bound      呼叫者的組織有案件成員（mandatary、practitioner、broker）屬於該執業主體的組織，
--              或呼叫者的組織有合約的指派指向該執業主體（過渡做法，等 MIL-116 把指派搬成案件成員）。
--   selecting  呼叫者的組織有至少一份草稿合約。過渡做法：委託管理合約尚未建案件，選人時還沒有任何綁定。
--   none       其他。與「執業主體不存在」不可區分。
--
-- 各關係看得到的資料：
--   own、bound  證號原文、三層最新核對紀錄 ID，以及全部任職（含失效的），讓判定能列出被拒的原因。
--   selecting   只看得到已驗證證書加已驗證任職的人員，沒有證號原文與核對紀錄 ID。
--   none        空。
-- 判定「可簽章」不在資料庫：這裡只提供事實，由 TypeScript 的 credentialStatusAt() 判定。

-- 1. 內部函式：呼叫者與執業主體的關係 --------------------------------------------
CREATE FUNCTION registry.caller_relation(p_entity_id text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_org    text := nullif(current_setting('app.org_id', true), '');
  v_is_op  boolean := nullif(current_setting('app.operator_id', true), '') IS NOT NULL;
  v_entity registry.practice_entities;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION '必須在組織或營運者脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF v_is_op THEN
    PERFORM registry.assert_operator();
    RETURN 'own';
  END IF;
  SELECT e.* INTO v_entity FROM registry.practice_entities e WHERE e.id = p_entity_id;
  IF v_entity.id IS NULL THEN
    RETURN 'none';
  END IF;
  IF v_entity.org_id = v_org THEN
    RETURN 'own';
  END IF;
  -- 平台組織與執業主體組織以外的呼叫者，只有屋主與執業主體組織能選人
  IF NOT EXISTS (SELECT 1 FROM control.orgs o WHERE o.id = v_org AND o.kind IN ('owner', 'practice')) THEN
    RETURN 'none';
  END IF;
  -- org 的表有 FORCE RLS，函式擁有者也只看得到 app.org_id 的列，所以下面只會比對呼叫者自己組織的案件與合約
  IF EXISTS (
    SELECT 1
      FROM org.case_members m
     WHERE m.org_id = v_org
       AND m.relation IN ('mandatary', 'practitioner', 'broker')
       AND m.valid_period @> now()
       AND EXISTS (
         SELECT 1 FROM control.users u
           JOIN control.org_memberships om ON om.user_id = u.id
          WHERE u.party_id = m.party_id AND om.org_id = v_entity.org_id)
  ) OR EXISTS (
    SELECT 1 FROM org.contract_practitioner_assignments a WHERE a.org_id = v_org AND a.entity_id = v_entity.id
  ) THEN
    RETURN 'bound';
  END IF;
  IF EXISTS (SELECT 1 FROM org.contracts c WHERE c.org_id = v_org AND c.status = 'draft') THEN
    RETURN 'selecting';
  END IF;
  RETURN 'none';
END
$$;

-- 2. 依業別列出執業主體 -----------------------------------------------------------------
-- 任何屋主或執業主體組織都能呼叫。只列至少有一個已驗證業別的執業主體，只回 ID、名稱與已登錄的業別，
-- 不回統編、組織 ID、人員。p_license_kind 有值時只列該業別已驗證的執業主體。
CREATE FUNCTION registry.list_practice_entities(p_license_kind text DEFAULT NULL)
RETURNS TABLE (entity_id text, name text, license_kinds text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org text := nullif(current_setting('app.org_id', true), '');
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'registry.list_practice_entities 必須在組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF p_license_kind IS NOT NULL AND p_license_kind NOT IN ('management', 'master_lease', 'brokerage') THEN
    RAISE EXCEPTION '不認得的業別：%', p_license_kind USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control.orgs o WHERE o.id = v_org AND o.kind IN ('owner', 'practice', 'platform')) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT e.id, e.name,
         (SELECT array_agg(l.kind ORDER BY l.kind) FROM registry.practice_licenses l WHERE l.entity_id = e.id)
    FROM registry.practice_entities e
   WHERE EXISTS (
           SELECT 1 FROM registry.practice_licenses l
            WHERE l.entity_id = e.id AND l.state = 'verified'
              AND (p_license_kind IS NULL OR l.kind = p_license_kind))
   ORDER BY e.name, e.id
   LIMIT 500;
END
$$;

-- 3. 當事人簽署人候選：執業主體組織的成員 -------------------------------------------------
-- 關係為 none 時回空。p_membership_id 有值時只回那一位（getPartySigner 用），這時執業主體取自成員關係，p_entity_id 可為空。
-- 候選的 ID 是成員關係的 ID：同一個人離開再加入會換 ID，舊的指派因此失效。
CREATE FUNCTION registry.party_signer_candidates(p_entity_id text, p_membership_id text DEFAULT NULL)
RETURNS TABLE (membership_id text, party_id text, entity_id text, name text, email text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_entity text := p_entity_id;
BEGIN
  IF v_entity IS NULL AND p_membership_id IS NOT NULL THEN
    SELECT e.id INTO v_entity
      FROM registry.practice_entities e JOIN control.org_memberships om ON om.org_id = e.org_id
     WHERE om.id = p_membership_id;
  END IF;
  IF v_entity IS NULL OR registry.caller_relation(v_entity) = 'none' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT om.id, p.id, e.id, p.display_name, p.email
    FROM registry.practice_entities e
    JOIN control.org_memberships om ON om.org_id = e.org_id
    JOIN control.users u ON u.id = om.user_id
    JOIN control.parties p ON p.id = u.party_id
   WHERE e.id = v_entity
     AND (p_membership_id IS NULL OR om.id = p_membership_id)
   ORDER BY p.display_name, om.id
   LIMIT 500;
END
$$;

-- 4. 簽章事實：業別與人員 ---------------------------------------------------------------
-- p_employment_id 有值時只回那一筆任職，執業主體取自任職（p_entity_id 忽略）。
-- 沒有值時，列出該執業主體的任職：own、bound 回全部，selecting 只回證書與任職都已驗證的人員。
-- 每筆任職一列事實（ID 是任職 ID），一個人在同一執業主體的每種證書各一列。
-- 證號原文與核對紀錄 ID 只給 own、bound。
-- 關係為 none、執業主體不存在、任職不屬於呼叫者看得到的執業主體，都回同一個空結果。
CREATE FUNCTION registry.signing_view(p_entity_id text DEFAULT NULL, p_employment_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_empty    constant jsonb := jsonb_build_object('licenses', '[]'::jsonb, 'practitioners', '[]'::jsonb);
  v_entity   text := p_entity_id;
  v_relation text;
  v_full     boolean;
  v_result   jsonb;
BEGIN
  IF p_employment_id IS NOT NULL THEN
    SELECT m.entity_id INTO v_entity FROM registry.practitioner_employments m WHERE m.id = p_employment_id;
  END IF;
  IF v_entity IS NULL THEN
    PERFORM registry.caller_relation('');   -- 沒有組織脈絡時照樣拒絕
    RETURN v_empty;
  END IF;
  v_relation := registry.caller_relation(v_entity);
  IF v_relation = 'none' THEN
    RETURN v_empty;
  END IF;
  v_full := v_relation IN ('own', 'bound');

  SELECT jsonb_build_object(
    'entity_id', v_entity,
    'licenses', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'kind', l.kind, 'state', l.state,
               'last_check_id', CASE WHEN v_full THEN
                 (SELECT k.id FROM registry.credential_checks k
                   WHERE k.subject_type = 'license' AND k.subject_id = l.id ORDER BY k.checked_at DESC, k.id DESC LIMIT 1)
               END) ORDER BY l.kind)
        FROM registry.practice_licenses l WHERE l.entity_id = v_entity), '[]'::jsonb),
    'practitioners', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
          'employment_id', m.id,
          'party_id', p.party_id,
          'name', pa.display_name,
          'account_email', pa.email,
          'certificate_kind', p.certificate_kind,
          'certificate_no', CASE WHEN v_full THEN
            jsonb_build_object('year', p.cert_year, 'word', p.cert_word, 'serial', p.cert_serial) END,
          'practitioner_state', p.state,
          'valid_until', p.valid_until,
          'practitioner_last_check_id', CASE WHEN v_full THEN
            (SELECT k.id FROM registry.credential_checks k
              WHERE k.subject_type = 'practitioner' AND k.subject_id = p.id ORDER BY k.checked_at DESC, k.id DESC LIMIT 1) END,
          'employment_state', m.state,
          'employment_started_on', m.started_on,
          'employment_ended_on', m.ended_on,
          'employment_last_check_id', CASE WHEN v_full THEN
            (SELECT k.id FROM registry.credential_checks k
              WHERE k.subject_type = 'employment' AND k.subject_id = m.id
                AND coalesce(k.observed ->> 'document', '') <> 'consent_letter'
              ORDER BY k.checked_at DESC, k.id DESC LIMIT 1) END
        ) ORDER BY pa.display_name, m.id)
        FROM registry.practitioner_employments m
        JOIN registry.practitioners p ON p.id = m.practitioner_id
        JOIN control.parties pa ON pa.id = p.party_id
       WHERE m.entity_id = v_entity
         AND (p_employment_id IS NULL OR m.id = p_employment_id)
         AND (v_full OR (p.state = 'verified' AND m.state = 'verified'))), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END
$$;

-- 5. 權限 ---------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  registry.caller_relation(text),
  registry.list_practice_entities(text),
  registry.party_signer_candidates(text, text),
  registry.signing_view(text, text)
  FROM PUBLIC;

-- caller_relation 是內部函式，不授權給 app_rw
GRANT EXECUTE ON FUNCTION
  registry.list_practice_entities(text),
  registry.party_signer_candidates(text, text),
  registry.signing_view(text, text)
  TO app_rw;
