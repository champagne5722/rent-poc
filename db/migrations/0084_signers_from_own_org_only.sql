-- 簽章人員只從自家指派（MIL-200，ADR-0029 決議 3，ADR-0023 決議 8 修訂）。由 runner 以 app_owner 執行。
--
-- 起因：任何屋主或執業主體組織建約時，都能列出全平台已驗證的執業主體與他們的人員，
-- 也能把別家的人存成簽章人員，再讀到對方真實的 email 與核對紀錄 ID。
-- 第 1 到 5 節用 CREATE OR REPLACE 改寫 0070 的四個函式，把洞關掉：
--   1. caller_relation：拿掉 selecting，拿掉「呼叫者自己存的合約指派」那一段。非自家的執業主體一律 none。
--   2. list_practice_entities：只列呼叫者自己組織的執業主體。
--   3. party_signer_candidates：列出成員時一律回遮罩的 email。用成員 ID 查單筆時，只有 own 拿到真實 email。
--   4. signing_view：列出任職時一律回遮罩的 email。用任職 ID 查單筆時，只有 own 拿到真實 email。
-- 四個函式的簽名、回傳形狀、SECURITY DEFINER、search_path 都不變，第 5 節重述權限。
--
-- 呼叫者與執業主體的關係（registry.caller_relation，內部函式，不授權給 app_rw）：
--   own   呼叫者是該執業主體自己的組織，或是平台營運者。
--   bound 呼叫者的組織有案件成員（mandatary、practitioner、broker）屬於該執業主體的組織。
--   none  其他。與「執業主體不存在」不可區分。
--
-- 各關係看得到的資料：
--   own   證號原文與真實 email（只在用 ID 查單筆時）、三層最新核對紀錄 ID、全部任職（含失效的）。
--   bound 遮罩後的證號、遮罩後的 email、三層最新核對紀錄 ID。列出任職時只回證書與任職都已驗證的人。
--         用任職 ID 查單筆時回那一筆的完整狀態，送簽前檢查才能說明被拒的原因。
--   none  空。
-- 證號遮罩規則與 src/lib/signature-records/snapshot.ts 的 maskCertificateNo 一致。
-- 判定「可簽章」不在資料庫：這裡只提供事實，由 TypeScript 的 credentialStatusAt() 判定。
--
-- 第 6 節：簽章人員存成案件成員。org.case_members 加四個席位欄，合約上既有的指派搬成案件成員。
-- 第 7 節：搬資料。只搬合約有案件、而且執業主體屬於同一個組織的列，其他列留在舊表，不擋 migration。

-- 1. 呼叫者與執業主體的關係 ---------------------------------------------------------
CREATE OR REPLACE FUNCTION registry.caller_relation(p_entity_id text) RETURNS text
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
  -- 平台組織與執業主體組織以外的呼叫者，只有屋主與執業主體組織能有綁定
  IF NOT EXISTS (SELECT 1 FROM control.orgs o WHERE o.id = v_org AND o.kind IN ('owner', 'practice')) THEN
    RETURN 'none';
  END IF;
  -- org 的表有 FORCE RLS，函式擁有者也只看得到 app.org_id 的列，所以下面只會比對呼叫者自己組織的案件成員
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
  ) THEN
    RETURN 'bound';
  END IF;
  RETURN 'none';
END
$$;

-- 2. 列出執業主體 -------------------------------------------------------------------
-- 呼叫者只看得到自己組織的執業主體，包含業別還沒驗證的（自己的登錄，自己看得到）。不回統編、組織 ID、人員。
-- license_kinds 是已登錄的業別，不論狀態。p_license_kind 有值時只列該業別已驗證的執業主體。
-- 平台營運者維持原樣：列出全平台至少有一個已驗證業別的執業主體。
CREATE OR REPLACE FUNCTION registry.list_practice_entities(p_license_kind text DEFAULT NULL)
RETURNS TABLE (entity_id text, name text, license_kinds text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org   text := nullif(current_setting('app.org_id', true), '');
  v_is_op boolean := nullif(current_setting('app.operator_id', true), '') IS NOT NULL;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'registry.list_practice_entities 必須在組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF p_license_kind IS NOT NULL AND p_license_kind NOT IN ('management', 'master_lease', 'brokerage') THEN
    RAISE EXCEPTION '不認得的業別：%', p_license_kind USING ERRCODE = '22023';
  END IF;
  IF v_is_op THEN
    PERFORM registry.assert_operator();
    RETURN QUERY
    SELECT e.id, e.name,
           coalesce((SELECT array_agg(l.kind ORDER BY l.kind) FROM registry.practice_licenses l WHERE l.entity_id = e.id), '{}'::text[])
      FROM registry.practice_entities e
     WHERE EXISTS (
             SELECT 1 FROM registry.practice_licenses l
              WHERE l.entity_id = e.id AND l.state = 'verified'
                AND (p_license_kind IS NULL OR l.kind = p_license_kind))
     ORDER BY e.name, e.id
     LIMIT 500;
    RETURN;
  END IF;
  RETURN QUERY
  SELECT e.id, e.name,
         coalesce((SELECT array_agg(l.kind ORDER BY l.kind) FROM registry.practice_licenses l WHERE l.entity_id = e.id), '{}'::text[])
    FROM registry.practice_entities e
   WHERE e.org_id = v_org
     AND (p_license_kind IS NULL
          OR EXISTS (
               SELECT 1 FROM registry.practice_licenses l
                WHERE l.entity_id = e.id AND l.state = 'verified' AND l.kind = p_license_kind))
   ORDER BY e.name, e.id
   LIMIT 500;
END
$$;

-- 3. 當事人簽署人候選：執業主體組織的成員 -------------------------------------------
-- 關係為 none 時回空。列出成員（p_membership_id 為空）時，email 一律遮罩，連 own 也一樣：選單不需要 email。
-- 用成員 ID 查單筆時，只有 own 拿到真實 email（送簽要寄信，合約欄位的 email 由伺服端依選到的人補）。bound 拿到遮罩的 email。
-- 單筆查詢時執業主體取自成員關係，p_entity_id 可為空。
-- 候選的 ID 是成員關係的 ID：同一個人離開再加入會換 ID，舊的指派因此失效。
CREATE OR REPLACE FUNCTION registry.party_signer_candidates(p_entity_id text, p_membership_id text DEFAULT NULL)
RETURNS TABLE (membership_id text, party_id text, entity_id text, name text, email text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_entity   text := p_entity_id;
  v_relation text;
  v_real     boolean;
BEGIN
  IF v_entity IS NULL AND p_membership_id IS NOT NULL THEN
    SELECT e.id INTO v_entity
      FROM registry.practice_entities e JOIN control.org_memberships om ON om.org_id = e.org_id
     WHERE om.id = p_membership_id;
  END IF;
  IF v_entity IS NULL THEN
    PERFORM registry.caller_relation('');   -- 沒有組織脈絡時照樣拒絕
    RETURN;
  END IF;
  v_relation := registry.caller_relation(v_entity);
  IF v_relation = 'none' THEN
    RETURN;
  END IF;
  v_real := v_relation = 'own' AND p_membership_id IS NOT NULL;
  RETURN QUERY
  SELECT om.id, p.id, e.id, p.display_name,
         CASE WHEN v_real THEN p.email ELSE registry.mask_email(p.email) END
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
-- 沒有值時，列出該執業主體的任職：own 回全部，bound 只回證書與任職都已驗證的人員。
-- 每筆任職一列事實（ID 是任職 ID），一個人在同一執業主體的每種證書各一列。
-- 證號原文只給 own，其他關係回遮罩後的證號。核對紀錄 ID 給 own 與 bound。
-- 真實 email 只給 own，而且只在用任職 ID 查單筆時回。列出任職時一律遮罩。
-- 關係為 none、執業主體不存在、任職不屬於呼叫者看得到的執業主體，都回同一個空結果。
CREATE OR REPLACE FUNCTION registry.signing_view(p_entity_id text DEFAULT NULL, p_employment_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_empty    constant jsonb := jsonb_build_object('licenses', '[]'::jsonb, 'practitioners', '[]'::jsonb);
  v_entity   text := p_entity_id;
  v_relation text;
  v_full     boolean;
  v_own      boolean;
  v_real     boolean;
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
  v_own := v_relation = 'own';
  v_real := v_own AND p_employment_id IS NOT NULL;

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
          'account_email', CASE WHEN v_real THEN pa.email ELSE registry.mask_email(pa.email) END,
          'certificate_kind', p.certificate_kind,
          'certificate_no', CASE WHEN v_own THEN
            jsonb_build_object('year', p.cert_year, 'word', p.cert_word, 'serial', p.cert_serial) END,
          'certificate_no_masked', registry.mask_certificate_no(p.cert_year, p.cert_word, p.cert_serial),
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
         AND (v_own
              OR (v_relation = 'bound' AND p_employment_id IS NOT NULL)
              OR (p.state = 'verified' AND m.state = 'verified'))), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END
$$;

-- 5. 權限 ---------------------------------------------------------------------------------
-- CREATE OR REPLACE 不改權限，這裡照 0070 重述：PUBLIC 不能執行，只授權給 app_rw。
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

-- 6. org.case_members 的席位欄 ---------------------------------------------------------
-- 簽章人員（執業人員席位與當事人簽署人）存成案件成員（ADR-0021 決議 4 的過渡條件由此取代，有案件的合約適用）。
--   slot             席位的 rule_id（簽章分流規則列），一個席位同時只有一列有效。
--   entity_id        執業主體，registry.practice_entities.id。registry 是全域表，不能建外鍵。
--   employment_id    任職 ID，registry.practitioner_employments.id。執業人員席位的候選 ID 就是它。
--   party_signer_id  當事人簽署人，control.org_memberships.id。執業主體不是當事人（經紀人席位）時為空。
-- party_id 是執業人員自己的 party，relation 是 practitioner 或 broker。四個席位欄要嘛都沒有（一般成員），要嘛有前三個。
-- 沒有案件的合約不適用，仍用 org.contract_practitioner_assignments（MIL-203 移除）。
ALTER TABLE org.case_members
  ADD COLUMN slot            text,
  ADD COLUMN entity_id       text,
  ADD COLUMN employment_id   text,
  ADD COLUMN party_signer_id text;

ALTER TABLE org.case_members ADD CONSTRAINT case_members_seat_columns CHECK (
  (slot IS NULL AND entity_id IS NULL AND employment_id IS NULL AND party_signer_id IS NULL)
  OR (slot IS NOT NULL AND entity_id IS NOT NULL AND employment_id IS NOT NULL AND relation IN ('practitioner', 'broker'))
);

-- 唯一鍵含 org_id（系統目錄檢查要求）。一個案件的一個席位，同時只有一列有效
CREATE UNIQUE INDEX case_members_active_slot ON org.case_members (org_id, case_id, slot)
  WHERE slot IS NOT NULL AND upper_inf(valid_period);

-- 7. 搬資料：合約上既有的指派搬成案件成員 --------------------------------------------------
-- org.contracts、org.case_members 與指派表都是 FORCE RLS，沒有組織脈絡的 app_owner 讀不到任何列，所以逐組織設定脈絡。
-- 整批在 migration 的同一個交易內。重跑不會重複寫：已存在的席位不再寫（ON CONFLICT DO NOTHING），已搬的舊列才刪。
-- 搬的條件（三個都要成立）：
--   1. 合約有案件。沒有案件的合約，指派留在舊表。
--   2. 任職查得到，取得執業人員的 party。查不到的列留在舊表。
--   3. 執業主體屬於同一個組織。別的組織的執業主體是這張票要關掉的洞，不搬，也不讓它再被讀到。
-- 搬不動的列不擋 migration，留在舊表，數字用 NOTICE 記錄。
DO $$
DECLARE
  prev_org text := coalesce(current_setting('app.org_id', true), '');
  one_org  record;
  moved    integer;
  deleted  integer;
  total_moved   integer := 0;
  total_left    integer := 0;
BEGIN
  FOR one_org IN SELECT id FROM control.orgs ORDER BY id LOOP
    PERFORM set_config('app.org_id', one_org.id, true);

    INSERT INTO org.case_members (id, org_id, case_id, party_id, relation, slot, entity_id, employment_id, party_signer_id)
    SELECT a.id, a.org_id, c.case_id, pr.party_id,
           CASE WHEN pr.certificate_kind IN ('real_estate_broker', 'real_estate_sales_agent') THEN 'broker' ELSE 'practitioner' END,
           a.slot, a.entity_id, a.practitioner_id, a.party_signer_id
      FROM org.contract_practitioner_assignments a
      JOIN org.contracts c ON c.org_id = a.org_id AND c.id = a.contract_id AND c.case_id IS NOT NULL
      JOIN registry.practitioner_employments m ON m.id = a.practitioner_id
      JOIN registry.practitioners pr ON pr.id = m.practitioner_id
      JOIN registry.practice_entities e ON e.id = a.entity_id AND e.org_id = a.org_id
     WHERE m.entity_id = a.entity_id
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS moved = ROW_COUNT;
    total_moved := total_moved + moved;

    -- 已搬的舊列：案件成員已有同一席位、同一個人。用同一個 ID 搬，所以以 ID 對應
    DELETE FROM org.contract_practitioner_assignments a
     WHERE EXISTS (SELECT 1 FROM org.case_members m WHERE m.org_id = a.org_id AND m.id = a.id);
    GET DIAGNOSTICS deleted = ROW_COUNT;

    total_left := total_left + (SELECT count(*)::integer FROM org.contract_practitioner_assignments);
  END LOOP;
  PERFORM set_config('app.org_id', prev_org, true);
  RAISE NOTICE '指派搬成案件成員：搬了 % 筆，留在舊表 % 筆（沒有案件、任職查不到、或執業主體不屬於同一個組織）', total_moved, total_left;
END
$$;
