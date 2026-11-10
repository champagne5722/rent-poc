-- 撞號送審核台、固定回應、頻率限制（MIL-144，ADR-0025 決議 7、9，ADR-0012 決議 8）。
-- 由 runner 以 app_owner 執行。
-- 編號是 0073 而不是 B 線區段的 0033：runner 依檔名排序，這個檔要用 0042 建的 registry.review_items 與 0047 的審核台函式，
-- 編號必須比它們大，否則全新資料庫（測試、本機）會在 0033 失敗。
--
-- 1. 設定值表：每個組織 24 小時內的撞號回應上限。
-- 2. 審核台項目種類：撞號、撞號超限。
-- 3. 補建號函式換成送審核台的流程（取代 0030 的固定錯誤）。
-- 4. 撞號超限的記錄函式，與宣稱方讀自己審核單號的函式。
-- 5. 審核台的佇列與詳情函式多列這兩種項目（沿用 0047 的做法，簽名與授權不變）。
--
-- 這個關係是誰能建立的：撞號項目只能由「自己有物件指向該錨點」的組織建立，宣稱方只是在自己的錨點上宣稱一個鍵。
-- 宣稱方得到的只有自己的審核單號。既有登錄方的錨點、物件、單位、通知都不被讀取或寫入（只讀鍵是否存在）。

-- 1. 設定值 ---------------------------------------------------------------------
-- 為什麼放資料庫：頻率限制必須在寫入函式內檢查，上限若由呼叫端傳入，呼叫端就能自己放寬。
-- 調整的方式是營運人員以資料庫擁有者身分改 int_value，app_rw 沒有任何權限。demo 預設 50，pilot 得調整。
CREATE TABLE registry.platform_settings (
  key        text PRIMARY KEY CHECK (key IN ('anchor_collision_daily_limit')),
  int_value  integer NOT NULL CHECK (int_value >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO registry.platform_settings (key, int_value) VALUES ('anchor_collision_daily_limit', 50);
REVOKE ALL ON registry.platform_settings FROM PUBLIC, app_rw;

-- 2. 審核台項目種類 ---------------------------------------------------------------
-- anchor_collision：宣稱方的鍵撞到別的組織已登錄的鍵。subject 是宣稱方的錨點。
--   payload：claimant_org_id、existing_anchor_id（撞到的錨點，給 MIL-146 判定與合併用，只給營運者）、
--   claimed_key（宣稱的五欄鍵，不進唯一索引）。
-- anchor_collision_limit：宣稱方 24 小時內的撞號回應用完額度。subject 是宣稱方組織。
--   這是通知平台營運者的管道：notify() 只寫呼叫者交易所屬組織的站內通知，而營運者身分沒有可讀的通知清單，
--   所以改排審核台項目。payload：claimant_org_id、limit、window_hours、hits、last_hit_at。
ALTER TABLE registry.review_items DROP CONSTRAINT review_items_type_check;
ALTER TABLE registry.review_items ADD CONSTRAINT review_items_type_check CHECK (type IN (
  'license', 'certificate', 'employment', 'consent',
  'entity_recheck', 'employment_recheck', 'entity_claim',
  'anchor_collision', 'anchor_collision_limit'));

-- 同一個錨點同時只有一張待審的撞號項目；同一個組織同時只有一張待審的撞號超限項目
CREATE UNIQUE INDEX review_items_one_open_collision ON registry.review_items (subject_id)
  WHERE status = 'open' AND type = 'anchor_collision';
CREATE UNIQUE INDEX review_items_one_open_collision_limit ON registry.review_items (subject_id)
  WHERE status = 'open' AND type = 'anchor_collision_limit';
-- 頻率限制的計數用：某組織最近的撞號項目（含已結案與被取代的）
CREATE INDEX review_items_collision_claimant ON registry.review_items ((payload ->> 'claimant_org_id'), created_at)
  WHERE type = 'anchor_collision';

-- 3. 補建號 -----------------------------------------------------------------------
-- 0030 的版本遇到撞號一律丟固定錯誤。這個版本回傳結果，由呼叫端決定交易要不要回滾。
-- 簽名多一個 p_item_id（審核單號，由應用程式產生 ULID），所以先刪掉舊函式。
--
-- 誰能呼叫：app_rw，且必須在組織脈絡內。呼叫者組織必須有物件指向 p_anchor_id 的單位：
--   別的組織的錨點與不存在的錨點，錯誤完全相同（P0002）。
-- 回傳一列 (outcome, item_id, property_id)：
--   keyed            鍵沒人用，錨點轉已建號。item_id、property_id 都是 NULL。
--   collision_queued 鍵已被別的組織登錄。錨點維持待驗證，宣稱的鍵存進審核項目 p_item_id（審核單號）。
--   own_existing     鍵已被自己組織登錄。property_id 是自己的物件，不建審核項目，不算進額度。
--   rate_limited     24 小時內的撞號回應已達上限。什麼都不寫，由呼叫端記錄（record_collision_limit_hit）。
-- 為什麼回傳而不是 RAISE：RAISE 會讓同一個交易的稽核事件回滾，撞號必須留下稽核。
-- 回傳值只有呼叫者自己的 ID，不含對方組織的名稱、統編、人員、物件與 ID。
-- 頻率限制在這裡檢查：先用組織為單位的 advisory lock 排隊，再數，再寫，並行請求無法同時通過。
-- 兩個交易搶同一個鍵時，後到的在 UPDATE 遇到唯一索引衝突（23505），改走撞號流程，不外露索引的錯誤。
DROP FUNCTION registry.assign_anchor_key(text, text, text, text, text, text);

CREATE FUNCTION registry.assign_anchor_key(
  p_anchor_id   text,
  p_city_code   text,
  p_town_code   text,
  p_section     text,
  p_building_no text,
  p_sub_no      text,
  p_item_id     text
)
RETURNS TABLE (outcome text, item_id text, property_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org      text := nullif(current_setting('app.org_id', true), '');
  v_status   text;
  v_building text;
  v_sub      text;
  v_canceled boolean;
  v_holder   text;
  v_own      text;
  v_limit    integer;
  v_count    integer;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'registry.assign_anchor_key 必須在組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;

  -- 鎖住錨點，同時確認呼叫者組織有物件指向它（org.properties 的 RLS 在這裡仍然生效）
  SELECT a.status INTO v_status
    FROM registry.anchors a
   WHERE a.id = p_anchor_id
     AND EXISTS (
       SELECT 1 FROM registry.rental_units u
         JOIN org.properties p ON p.rental_unit_id = u.id
        WHERE u.anchor_id = a.id)
     FOR UPDATE OF a;
  IF NOT FOUND THEN
    RAISE EXCEPTION '產權錨點不存在' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'pending_verification' THEN
    RAISE EXCEPTION '產權錨點已建號，不能再補建號' USING ERRCODE = '55000';
  END IF;

  IF p_city_code IS NULL OR p_city_code !~ '^[A-Z]$'
     OR p_town_code IS NULL OR p_town_code !~ '^[0-9]{2}$'
     OR p_section IS NULL OR p_section !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION '縣市、鄉鎮市區或段碼的格式有誤' USING ERRCODE = '22023';
  END IF;
  IF p_building_no IS NULL OR p_building_no !~ '^[0-9]{1,5}$' OR p_building_no ~ '^0+$' THEN
    RAISE EXCEPTION '建號必須是 1 到 5 位數字，且不得全為零' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_sub_no, '') <> '' AND p_sub_no !~ '^[0-9]{1,3}$' THEN
    RAISE EXCEPTION '分號必須是 1 到 3 位數字' USING ERRCODE = '22023';
  END IF;
  v_building := lpad(p_building_no, 5, '0');
  v_sub := lpad(coalesce(nullif(p_sub_no, ''), '0'), 3, '0');

  SELECT s.canceled INTO v_canceled
    FROM registry.sections s
   WHERE s.city_code = p_city_code AND s.town_code = p_town_code AND s.code = p_section;
  IF NOT FOUND THEN
    RAISE EXCEPTION '段小段不存在，鍵必須用主行政區的段碼' USING ERRCODE = '22023';
  END IF;
  IF v_canceled THEN
    RAISE EXCEPTION '段碼已註銷，必須改選現行的段' USING ERRCODE = '22023';
  END IF;

  -- 先看鍵有沒有人用。沒人用就直接登錄；兩個交易同時搶時，後到的在 UPDATE 撞唯一索引，改走下面的撞號流程
  SELECT a.id INTO v_holder
    FROM registry.anchors a
   WHERE a.city_code = p_city_code AND a.town_code = p_town_code AND a.section_code = p_section
     AND a.building_no = v_building AND a.sub_no = v_sub
     AND a.status IN ('pending_verification', 'keyed')
     AND a.id <> p_anchor_id;

  IF v_holder IS NULL THEN
    BEGIN
      UPDATE registry.anchors
         SET city_code = p_city_code, town_code = p_town_code, section_code = p_section,
             building_no = v_building, sub_no = v_sub, status = 'keyed', updated_at = now()
       WHERE id = p_anchor_id;
      -- 先前撞號待審的項目已不適用：這個錨點登錄了沒人用的鍵
      UPDATE registry.review_items r
         SET status = 'resolved', resolved_at = now(), resolution = 'superseded'
       WHERE r.type = 'anchor_collision' AND r.subject_id = p_anchor_id AND r.status = 'open';
      RETURN QUERY SELECT 'keyed'::text, NULL::text, NULL::text;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      -- 子交易已回滾。鍵剛被別的交易登錄，重新找出是誰
      SELECT a.id INTO v_holder
        FROM registry.anchors a
       WHERE a.city_code = p_city_code AND a.town_code = p_town_code AND a.section_code = p_section
         AND a.building_no = v_building AND a.sub_no = v_sub
         AND a.status IN ('pending_verification', 'keyed')
         AND a.id <> p_anchor_id;
      IF v_holder IS NULL THEN
        RAISE EXCEPTION '產權登錄暫時失敗，請重試' USING ERRCODE = '40001';
      END IF;
    END;
  END IF;

  -- 撞到自己的組織：回自己的物件。org.properties 的 RLS 只讓呼叫者看到自己組織的列，
  -- 所以這裡找得到物件，就代表持有者是自己（對方組織的物件在這裡是 0 列）。整戶、未封存的優先
  SELECT p.id INTO v_own
    FROM registry.rental_units u
    JOIN org.properties p ON p.rental_unit_id = u.id
   WHERE u.anchor_id = v_holder
   ORDER BY (p.archived_at IS NOT NULL), u.suffix, p.id
   LIMIT 1;
  IF v_own IS NOT NULL THEN
    RETURN QUERY SELECT 'own_existing'::text, NULL::text, v_own;
    RETURN;
  END IF;

  -- 撞到別的組織。額度以組織為單位：同一個組織的並行請求在這裡排隊，數的時候看得到前一個已寫的項目
  PERFORM pg_advisory_xact_lock(hashtextextended('registry.anchor_collision:' || v_org, 0));
  SELECT s.int_value INTO v_limit FROM registry.platform_settings s WHERE s.key = 'anchor_collision_daily_limit';
  v_limit := coalesce(v_limit, 50);
  SELECT count(*) INTO v_count
    FROM registry.review_items r
   WHERE r.type = 'anchor_collision'
     AND r.payload ->> 'claimant_org_id' = v_org
     AND r.created_at > now() - interval '24 hours';
  IF v_count >= v_limit THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- 同一個錨點先前待審的撞號項目被這一張取代（仍算進額度，改宣稱不能繞過上限）
  UPDATE registry.review_items r
     SET status = 'resolved', resolved_at = now(), resolution = 'superseded'
   WHERE r.type = 'anchor_collision' AND r.subject_id = p_anchor_id AND r.status = 'open';
  INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
  VALUES (
    p_item_id, 'anchor_collision', 'anchor', p_anchor_id,
    jsonb_build_object(
      'claimant_org_id', v_org,
      'existing_anchor_id', v_holder,
      'claimed_key', jsonb_build_object(
        'city_code', p_city_code, 'town_code', p_town_code, 'section_code', p_section,
        'building_no', v_building, 'sub_no', v_sub)));
  RETURN QUERY SELECT 'collision_queued'::text, p_item_id, NULL::text;
END
$$;

REVOKE ALL ON FUNCTION registry.assign_anchor_key(text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.assign_anchor_key(text, text, text, text, text, text, text) TO app_rw;

-- 4. 撞號超限的記錄與宣稱方讀審核單號 -------------------------------------------------
-- record_collision_limit_hit：assign_anchor_key 回 rate_limited 之後，由呼叫端在回滾自己的半成品之後呼叫。
-- 誰能呼叫：app_rw，組織脈絡內。回傳：呼叫者組織待審的「撞號超限」項目 ID。
-- 為什麼要有：通知平台營運者。同一個組織反覆被擋時只累計次數，不增加項目，超過 24 小時沒人處理的舊項目被取代。
-- 為什麼安全：呼叫者組織的額度真的用完才會寫（否則 55000），所以額度沒用完的組織不能往營運者佇列塞項目。
-- 只寫呼叫者自己組織的項目，payload 只放呼叫者自己的資料與上限。
CREATE FUNCTION registry.record_collision_limit_hit(p_item_id text) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_org      text := nullif(current_setting('app.org_id', true), '');
  v_limit    integer;
  v_count    integer;
  v_existing text;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'registry.record_collision_limit_hit 必須在組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('registry.anchor_collision:' || v_org, 0));
  SELECT s.int_value INTO v_limit FROM registry.platform_settings s WHERE s.key = 'anchor_collision_daily_limit';
  v_limit := coalesce(v_limit, 50);
  SELECT count(*) INTO v_count
    FROM registry.review_items r
   WHERE r.type = 'anchor_collision'
     AND r.payload ->> 'claimant_org_id' = v_org
     AND r.created_at > now() - interval '24 hours';
  IF v_count < v_limit THEN
    RAISE EXCEPTION '撞號額度還沒用完' USING ERRCODE = '55000';
  END IF;

  SELECT r.id INTO v_existing
    FROM registry.review_items r
   WHERE r.type = 'anchor_collision_limit' AND r.subject_id = v_org AND r.status = 'open'
     AND r.created_at > now() - interval '24 hours'
   ORDER BY r.created_at DESC
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    UPDATE registry.review_items r
       SET payload = r.payload || jsonb_build_object(
             'hits', coalesce((r.payload ->> 'hits')::integer, 0) + 1, 'limit', v_limit, 'last_hit_at', now())
     WHERE r.id = v_existing;
    RETURN v_existing;
  END IF;

  UPDATE registry.review_items r
     SET status = 'resolved', resolved_at = now(), resolution = 'superseded'
   WHERE r.type = 'anchor_collision_limit' AND r.subject_id = v_org AND r.status = 'open';
  INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
  VALUES (
    p_item_id, 'anchor_collision_limit', 'org', v_org,
    jsonb_build_object('claimant_org_id', v_org, 'limit', v_limit, 'window_hours', 24, 'hits', 1, 'last_hit_at', now()));
  RETURN p_item_id;
END
$$;

REVOKE ALL ON FUNCTION registry.record_collision_limit_hit(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.record_collision_limit_hit(text) TO app_rw;

-- get_collision_reviews：物件頁顯示「已送審核」與審核單號用，也是 MIL-150 判斷「租賃單位有待審的撞號」的接點。
-- 誰能呼叫：app_rw。回傳：p_unit_ids 之中，呼叫者組織有物件指向的單位，各自待審的撞號項目 ID 與建立時間。
-- 為什麼安全：只回呼叫者組織自己提出的項目（payload 的宣稱方是自己）。別的組織的單位 ID 與不存在的 ID 同樣得到空結果。
-- 不回宣稱的鍵，也不回撞到的錨點。
CREATE FUNCTION registry.get_collision_reviews(p_unit_ids text[])
RETURNS TABLE (unit_id text, item_id text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
  SELECT u.id, r.id, r.created_at
    FROM registry.rental_units u
    JOIN registry.review_items r
      ON r.type = 'anchor_collision' AND r.status = 'open' AND r.subject_id = u.anchor_id
   WHERE u.id = ANY (p_unit_ids)
     AND r.payload ->> 'claimant_org_id' = nullif(current_setting('app.org_id', true), '')
     AND EXISTS (SELECT 1 FROM org.properties p WHERE p.rental_unit_id = u.id)
$$;

REVOKE ALL ON FUNCTION registry.get_collision_reviews(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.get_collision_reviews(text[]) TO app_rw;

-- 5. 審核台 -----------------------------------------------------------------------
-- 在 0047 的基礎上多列撞號與撞號超限兩種項目。簽名、授權與 0043、0047 相同，只加 CASE 分支與 JOIN。
-- 營運者是平台方，看得到宣稱方的名稱。這兩個函式只給營運者（先呼叫 assert_operator()）。
-- 佇列與詳情不回既有登錄方的任何資料：existing_anchor_id 只留在項目的 payload，等 MIL-146 判定時才讀。

-- review_queue
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
           WHEN 'anchor_collision' THEN jsonb_build_object(
             'claimant_org_name', oc.name, 'claimed_key', r.payload -> 'claimed_key',
             'city_name', ar.city_name, 'town_name', ar.town_name,
             'section_name', se.name, 'section_sub_name', se.sub_name)
           WHEN 'anchor_collision_limit' THEN jsonb_build_object(
             'claimant_org_name', oc.name, 'limit', r.payload -> 'limit', 'hits', r.payload -> 'hits')
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
    LEFT JOIN control.orgs oc ON r.type IN ('anchor_collision', 'anchor_collision_limit') AND oc.id = r.payload ->> 'claimant_org_id'
    LEFT JOIN registry.areas ar ON r.type = 'anchor_collision'
           AND ar.city_code = r.payload #>> '{claimed_key,city_code}' AND ar.town_code = r.payload #>> '{claimed_key,town_code}'
    LEFT JOIN registry.sections se ON r.type = 'anchor_collision'
           AND se.city_code = r.payload #>> '{claimed_key,city_code}' AND se.town_code = r.payload #>> '{claimed_key,town_code}'
           AND se.code = r.payload #>> '{claimed_key,section_code}'
   WHERE r.status = p_status
     AND (r.type <> 'license' OR l.permit_no IS NOT NULL)
   ORDER BY CASE WHEN p_status = 'open' THEN r.created_at END ASC,
            CASE WHEN p_status = 'resolved' THEN r.resolved_at END DESC,
            r.id
   LIMIT least(greatest(p_limit, 1), 500);
END
$$;

-- review_item_detail：多回 collision（宣稱方、宣稱的鍵與段名）
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
    'collision', CASE WHEN v_item.type = 'anchor_collision' THEN jsonb_build_object(
      'claimant_org_id', v_item.payload ->> 'claimant_org_id',
      'claimant_org_name', (SELECT o.name FROM control.orgs o WHERE o.id = v_item.payload ->> 'claimant_org_id'),
      'claimed_key', v_item.payload -> 'claimed_key',
      'city_name', (SELECT ar.city_name FROM registry.areas ar
                     WHERE ar.city_code = v_item.payload #>> '{claimed_key,city_code}' AND ar.town_code = v_item.payload #>> '{claimed_key,town_code}'),
      'town_name', (SELECT ar.town_name FROM registry.areas ar
                     WHERE ar.city_code = v_item.payload #>> '{claimed_key,city_code}' AND ar.town_code = v_item.payload #>> '{claimed_key,town_code}'),
      'section_name', (SELECT se.name FROM registry.sections se
                        WHERE se.city_code = v_item.payload #>> '{claimed_key,city_code}' AND se.town_code = v_item.payload #>> '{claimed_key,town_code}'
                          AND se.code = v_item.payload #>> '{claimed_key,section_code}'),
      'section_sub_name', (SELECT se.sub_name FROM registry.sections se
                            WHERE se.city_code = v_item.payload #>> '{claimed_key,city_code}' AND se.town_code = v_item.payload #>> '{claimed_key,town_code}'
                              AND se.code = v_item.payload #>> '{claimed_key,section_code}'))
      WHEN v_item.type = 'anchor_collision_limit' THEN jsonb_build_object(
      'claimant_org_id', v_item.payload ->> 'claimant_org_id',
      'claimant_org_name', (SELECT o.name FROM control.orgs o WHERE o.id = v_item.payload ->> 'claimant_org_id'),
      'limit', v_item.payload -> 'limit', 'hits', v_item.payload -> 'hits', 'last_hit_at', v_item.payload ->> 'last_hit_at') END,
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
