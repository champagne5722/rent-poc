-- 專任判定搬進寫入函式，收回 employment_exclusivity_facts 的授權（MIL-186，ADR-0017 決議 7，P0-05 AC1、AC6）。
-- 由 runner 以 app_owner 執行。
--
-- 問題：0047 的 employment_exclusivity_facts 讓應用程式先查別家的任職事實，再用純函式判定。事實一旦回到應用程式，
-- app_rw 就能單獨呼叫它。0071 收斂成只回已驗證的列，仍有三個揭露：任何執業主體組織的成員能探測某個證書鍵在別家有沒有
-- 已驗證在職、回傳值含起訖日、直接呼叫沒有稽核紀錄。證書鍵由種類、年、字、序號組成，可以枚舉。
--
-- 做法：判定在資料庫內，與寫入同一個函式呼叫。別家的任職事實只在函式內部讀取，不回給呼叫者。
--   registry.exclusivity_verdict   內部函式，不授權給 app_rw。回傳 blocked、consent_required、clear 三種結論。
--   registry.submit_practitioner   登錄證書前判定。被阻擋時什麼都不寫，回傳 outcome = 'blocked'。
--   registry.create_employment     建立任職前判定。被阻擋時什麼都不寫，回傳 outcome = 'blocked'。
--   registry.employment_exclusivity_facts  移除（DROP）。
--
-- 阻擋用回傳值表示，不用 RAISE EXCEPTION。例外會讓同一個交易回滾，應用程式在同一個交易寫的稽核事件
-- （rule.full_time_block、rule.full_time_notice）也會一起消失（P0-05 AC6）。
--
-- 回給呼叫者的只有結論：outcome（blocked、registered、created）、consent_required 與物件 ID。
-- 不回別家任職的起訖日、狀態、筆數或任何能推出日期的值。
--
-- 「今天」取資料庫的台灣日期，不收參數。呼叫者若能指定日期，就能用二分法從阻擋與否推出別家任職的起訖日。
--
-- 規則的參考實作是 src/lib/registry-rules/exclusivity.ts 的 classifyEmploymentCreation。
-- exclusivity-sql.test.ts 固定兩者對同一組輸入的結論相同。
--
-- 為什麼 DROP 而不是 REVOKE：移除後沒有任何應用程式程式碼會呼叫它。留著一個沒有授權的定義者函式，
-- 之後任何一支「GRANT 整個 schema」的 migration 都會悄悄把探測入口開回去。
--
-- 殘餘風險（待法務確認）：從阻擋結果仍能推出「此證書鍵在別家有已驗證在職」。這與 ADR-0017 決議 7 的訊息
-- 「此證號已有在職紀錄」揭露的資訊相同，是「建立任職時判定」本身帶來的。登錄嘗試的頻率上限另案處理。

-- 1. 內部函式：專任判定 -------------------------------------------------------------
-- 誰能呼叫：只有同一個 owner 的定義者函式（submit_practitioner、create_employment）。不授權給 app_rw。
-- 即使被誤授權，開頭仍檢查呼叫者是執業主體組織的成員（assert_practice_member）。
-- 回傳什麼：blocked、consent_required、clear 三選一。
-- 規則：別家（entity_id 不是 p_entity_id）有一筆狀態是 verified、任職期間涵蓋今天的任職時，
--   管理人員（rental_housing_manager）得 blocked，其他證書種類得 consent_required。沒有時得 clear。
--   已驗證代表進行中，任職結束時轉已失效（0047），所以待驗證與已失效的別家任職不影響結論。
-- p_entity_id 為 NULL 時，所有已驗證的任職都算別家。
CREATE FUNCTION registry.exclusivity_verdict(p_certificate_key text, p_certificate_kind text, p_entity_id text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Taipei')::date;
BEGIN
  PERFORM registry.assert_practice_member();
  IF NOT EXISTS (
    SELECT 1 FROM registry.practitioner_employments m
     WHERE m.certificate_key = p_certificate_key
       AND m.state = 'verified'
       AND m.entity_id IS DISTINCT FROM p_entity_id
       AND m.started_on <= v_today
       AND (m.ended_on IS NULL OR v_today <= m.ended_on)
  ) THEN
    RETURN 'clear';
  END IF;
  IF p_certificate_kind = 'rental_housing_manager' THEN
    RETURN 'blocked';
  END IF;
  RETURN 'consent_required';
END
$$;

-- 2. submit_practitioner：登錄或補件證書，必要時先判定專任 ------------------------------
-- 誰能呼叫：執業主體組織的成員（assert_practice_member），只登錄呼叫者本人的證書。
-- 回傳什麼：practitioner_id、item_id、state 與 outcome。outcome 是 registered 或 blocked。
--   blocked 時前三欄是 NULL，什麼都沒寫。其餘情況與 0047 相同。
-- 何時判定：呼叫者在目前執業主體還沒有未結束的任職時（第一次登錄，或舊任職已失效後換證）。補件時任職早就存在，不再判定。
--   與 applicant.ts 舊的 hasLiveEmployment 相同。目前組織還沒有執業主體登錄時不判定，因為這時建不了任職（create_employment 會拒絕），
--   不判定也不會回傳任何別家的資訊。
-- 為什麼：第一次登錄時呼叫者還沒有這個證書鍵的證書列，所以不能用「呼叫者持有證書鍵」限制判定（MIL-165）。
--   判定與寫入在同一個函式呼叫內，應用程式拿不到別家的任職事實。
-- 狀態轉移由呼叫端用 decideCredentialTransition 算好傳入，這裡只驗證組合合法（與 0047 相同）。
DROP FUNCTION registry.submit_practitioner(text, text, text, text, text, date, date, text, text, text);
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
RETURNS TABLE (practitioner_id text, item_id text, state text, outcome text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_party     text := registry.assert_practice_member();
  v_org       text := nullif(current_setting('app.org_id', true), '');
  v_entity    text;
  v_live      boolean;
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
  END IF;

  -- 專任判定（MIL-186）。在寫任何東西之前。被阻擋時回傳結果，不丟例外，讓應用程式的稽核事件跟著交易提交
  SELECT e.id INTO v_entity FROM registry.practice_entities e WHERE e.org_id = v_org;
  IF v_entity IS NOT NULL THEN
    v_live := v_row.id IS NOT NULL AND EXISTS (
      SELECT 1 FROM registry.practitioner_employments m
       WHERE m.practitioner_id = v_row.id AND m.entity_id = v_entity AND m.state <> 'lapsed'
    );
    IF NOT v_live AND registry.exclusivity_verdict(v_key, p_kind, v_entity) = 'blocked' THEN
      RETURN QUERY SELECT NULL::text, NULL::text, NULL::text, 'blocked'::text;
      RETURN;
    END IF;
  END IF;

  IF v_row.id IS NULL THEN
    INSERT INTO registry.practitioners (id, party_id, certificate_kind, cert_year, cert_word, cert_serial, certificate_key, issued_on, valid_until)
    VALUES (p_practitioner_id, v_party, p_kind, p_year, v_word, p_serial, v_key, p_issued_on, p_valid_until);
    v_row.id := p_practitioner_id;
  ELSE
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
  RETURN QUERY SELECT v_row.id, v_item, 'pending'::text, 'registered'::text;
END
$$;

-- 3. create_employment：本人在目前執業主體建立待驗證任職，建立前先判定專任 ----------------
-- 誰能呼叫：執業主體組織的成員（assert_practice_member），而且目前組織有執業主體登錄，只為呼叫者本人的證書建立任職。
-- 回傳什麼：employment_id、item_id、outcome 與 consent_required。outcome 是 created 或 blocked。
--   blocked 時 employment_id 與 item_id 是 NULL，consent_required 是 false，什麼都沒寫。
--   created 且 consent_required 為 true，代表經紀人員掛第二家，應用程式要提示並要求同意書（P0-05 AC3）。
-- 為什麼：0047 的 p_consent_required 由應用程式查事實後傳入。事實不再回給應用程式，所以由這裡自己判定，
--   參數拿掉。證書鍵與證書種類取自呼叫者本人的證書列，呼叫者不能指定別人的證書鍵。
-- 同一個人在同一個執業主體已有未結束的任職時，部分唯一索引擋下（23505），與 0047 相同。
DROP FUNCTION registry.create_employment(text, text, date, boolean, text);
CREATE FUNCTION registry.create_employment(
  p_employment_id   text,
  p_practitioner_id text,
  p_started_on      date,
  p_item_id         text
)
RETURNS TABLE (employment_id text, item_id text, outcome text, consent_required boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_party   text := registry.assert_practice_member();
  v_org     text := nullif(current_setting('app.org_id', true), '');
  v_entity  text;
  v_cert    registry.practitioners;
  v_verdict text;
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

  v_verdict := registry.exclusivity_verdict(v_cert.certificate_key, v_cert.certificate_kind, v_entity);
  IF v_verdict = 'blocked' THEN
    RETURN QUERY SELECT NULL::text, NULL::text, 'blocked'::text, false;
    RETURN;
  END IF;

  INSERT INTO registry.practitioner_employments (id, practitioner_id, certificate_key, certificate_kind, entity_id, started_on, consent_required)
  VALUES (p_employment_id, v_cert.id, v_cert.certificate_key, v_cert.certificate_kind, v_entity, p_started_on, v_verdict = 'consent_required');
  INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
  VALUES (p_item_id, 'employment', 'employment', p_employment_id, jsonb_build_object('certificate_kind', v_cert.certificate_kind));
  RETURN QUERY SELECT p_employment_id, p_item_id, 'created'::text, v_verdict = 'consent_required';
END
$$;

-- 4. 移除探測入口 ---------------------------------------------------------------------
DROP FUNCTION registry.employment_exclusivity_facts(text);

-- 5. 權限 -----------------------------------------------------------------------------
-- DROP 後再 CREATE 的函式不繼承舊授權，這裡完整重寫。exclusivity_verdict 是內部函式，不授權給 app_rw。
REVOKE ALL ON FUNCTION
  registry.exclusivity_verdict(text, text, text),
  registry.submit_practitioner(text, text, text, text, text, date, date, text, text, text),
  registry.create_employment(text, text, date, text)
  FROM PUBLIC, app_rw;

GRANT EXECUTE ON FUNCTION
  registry.submit_practitioner(text, text, text, text, text, date, date, text, text, text),
  registry.create_employment(text, text, date, text)
  TO app_rw;
