-- 登錄回應一律相同，建號必填（MIL-196，ADR-0028 決議 1、2、6、9，ADR-0027 決議 1）。
-- 由 runner 以 app_owner 執行。檔名接在全域最大號之後（0075）。
-- 不改 0073：它已套用，這裡用 DROP 與 CREATE 換掉函式。審核台的佇列與詳情函式不動，審核台仍看得到鍵重複、宣稱的鍵與雙方的資料。
--
-- 對外要消除的差別：呼叫者不得從回傳值、錯誤、狀態或自己讀得到的任何一張表，分辨別的組織是否登錄過同一個鍵。
--   1. 補建號函式：不再回 rate_limited。超過次數時登錄照常成立，只在審核台建立內部警示。
--   2. 補建號函式：待驗證與已建號的物件都能修正建號。過去已建號的物件得到固定錯誤，撞號的物件卻能再宣稱，兩者的差別洩漏撞號。
--   3. 讀取函式：鍵撞到別的組織時，回傳呼叫者宣稱的鍵，不回空值。顯示編碼也用宣稱的縣市與鄉鎮市區。
--   4. 稽核事件：鍵重複的事件改寫在平台組織的鏈。宣稱方的鏈只留 TypeScript 側寫的一筆登錄事件，內容與不重複時相同。
--   5. 刪除 get_collision_reviews：它讓宣稱方讀到自己撞號的審核單號。
--   6. 刪除 record_collision_limit_hit：超過次數的警示改由補建號函式在內部建立，app_rw 不再有入口。
--
-- 這份檔建立與換掉的函式，例外訊息與註解一律稱「物件」。

-- 1. 平台鏈的寫入口 ----------------------------------------------------------------
-- audit.append 的鏈由 app.org_id 決定，組織脈絡內寫不到平台鏈。這裡開一個窄的入口，只給補建號函式使用。
-- 誰能呼叫：只有 app_owner（補建號函式的擁有者）。app_rw 與 PUBLIC 都沒有 EXECUTE，所以應用程式碼不能直接寫平台鏈。
-- 寫什麼：固定動作 property.anchor_collision，行為者是 system，物件是租賃單位。payload 只放宣稱方組織 ID 與審核單號。
-- 不放鍵、地址與對方的任何資料：事件寫入後刪不掉。
-- 回傳：無。
-- 鎖的順序：呼叫者先在自己組織的鏈寫登錄事件，再進補建號函式寫平台鏈，所以固定是組織鏈、平台鏈。
SET LOCAL ROLE audit_owner;

GRANT USAGE ON SCHEMA audit TO app_owner;

CREATE FUNCTION audit.append_platform_anchor_collision(p_claimant_org text, p_rental_unit_id text, p_item_id text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_platform text;
BEGIN
  SELECT o.id INTO v_platform FROM control.orgs o WHERE o.kind = 'platform';
  IF v_platform IS NULL THEN
    RAISE EXCEPTION '找不到平台組織，無法寫入平台鏈';
  END IF;
  PERFORM audit.write_event(
    v_platform, 'system', NULL, 'property.anchor_collision', 'rental_unit', p_rental_unit_id,
    jsonb_build_object('claimant_org_id', p_claimant_org, 'review_item_id', p_item_id));
END
$$;

REVOKE ALL ON FUNCTION audit.append_platform_anchor_collision(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.append_platform_anchor_collision(text, text, text) TO app_owner;

-- 回到 app_owner（不是 RESET ROLE：runner 用 SET LOCAL ROLE 切成 app_owner，RESET 會回到管理者，之後的函式就歸管理者，RLS 不再生效）
SET LOCAL ROLE app_owner;

-- 2. 超過次數的內部警示 ------------------------------------------------------------
-- 只給 registry.assign_anchor_key 呼叫，app_rw 沒有 EXECUTE。
-- 同一個組織反覆超過次數時只累計 hits，不增加項目。超過 24 小時沒人處理的舊項目被取代。
CREATE FUNCTION registry.raise_collision_limit_alert(p_org text, p_limit integer, p_alert_id text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_existing text;
BEGIN
  SELECT r.id INTO v_existing
    FROM registry.review_items r
   WHERE r.type = 'anchor_collision_limit' AND r.subject_id = p_org AND r.status = 'open'
     AND r.created_at > now() - interval '24 hours'
   ORDER BY r.created_at DESC
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    UPDATE registry.review_items r
       SET payload = r.payload || jsonb_build_object(
             'hits', coalesce((r.payload ->> 'hits')::integer, 0) + 1, 'limit', p_limit, 'last_hit_at', now())
     WHERE r.id = v_existing;
    RETURN;
  END IF;

  UPDATE registry.review_items r
     SET status = 'resolved', resolved_at = now(), resolution = 'superseded'
   WHERE r.type = 'anchor_collision_limit' AND r.subject_id = p_org AND r.status = 'open';
  INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
  VALUES (
    p_alert_id, 'anchor_collision_limit', 'org', p_org,
    jsonb_build_object('claimant_org_id', p_org, 'limit', p_limit, 'window_hours', 24, 'hits', 1, 'last_hit_at', now()));
END
$$;

REVOKE ALL ON FUNCTION registry.raise_collision_limit_alert(text, integer, text) FROM PUBLIC;

-- 3. 刪除會洩漏撞號的入口 ----------------------------------------------------------
DROP FUNCTION registry.get_collision_reviews(text[]);
DROP FUNCTION registry.record_collision_limit_hit(text);
DROP FUNCTION registry.assign_anchor_key(text, text, text, text, text, text, text);

-- 4. 補建號與修正建號 ---------------------------------------------------------------
-- 誰能呼叫：app_rw，且必須在組織脈絡內。呼叫者組織必須有物件指向 p_anchor_id 的單位。
--   別的組織的物件與不存在的物件，錯誤完全相同（P0002）。
-- 狀態：待驗證與已建號的物件都能呼叫。目前沒有任何物件通過文件核對，所以都算「通過核對前」。
--   物件已合併或停用時回 55000。通過核對後要送審核台，等核對功能（MIL-201）加入。
-- 回傳一列 (outcome, item_id, property_id)：
--   keyed            鍵沒人用，物件轉已建號。item_id、property_id 都是 NULL。
--   collision_queued 鍵已被別的組織登錄。宣稱的鍵存進審核項目 p_item_id，物件轉待驗證並清掉鍵。
--   own_existing     鍵已被自己組織登錄。property_id 是自己的物件，不建審核項目，不算進次數。
--   不再有 rate_limited。
-- 對外的呼叫端（TypeScript）把 keyed 與 collision_queued 當成同一種結果，兩者只留在內部。
-- 為什麼回傳而不是 RAISE：RAISE 會讓同一個交易的稽核事件回滾。
-- 回傳值只有呼叫者自己的 ID，不含對方組織的名稱、統編、人員、物件與 ID。
-- 次數在這裡檢查：先用組織為單位的 advisory lock 排隊，再數，再寫，並行請求無法同時通過。
--   數到達設定值時，登錄照常成立，另外呼叫 raise_collision_limit_alert 通知營運者。
--   p_alert_id 是警示項目的 ID，應用程式每次傳新的 ULID，沒有用到就丟棄。
-- 已建號的物件改成撞號的鍵時，物件清掉原本的鍵、轉待驗證。原本的鍵因此釋出，不會讓別的組織撞到呼叫者已放棄的鍵。
-- 平台鏈的事件在撞號時寫入（audit.append_platform_anchor_collision）。
-- 兩個交易搶同一個鍵時，後到的在 UPDATE 遇到唯一索引衝突（23505），改走撞號流程，不外露索引的錯誤。
CREATE FUNCTION registry.assign_anchor_key(
  p_anchor_id   text,
  p_city_code   text,
  p_town_code   text,
  p_section     text,
  p_building_no text,
  p_sub_no      text,
  p_item_id     text,
  p_alert_id    text
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
  v_unit     text;
  v_limit    integer;
  v_count    integer;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'registry.assign_anchor_key 必須在組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF p_item_id IS NULL OR p_alert_id IS NULL THEN
    RAISE EXCEPTION '審核單號與警示編號必須由呼叫端提供' USING ERRCODE = '22023';
  END IF;

  -- 鎖住物件，同時確認呼叫者組織有物件指向它（org.properties 的 RLS 在這裡仍然生效）
  SELECT a.status INTO v_status
    FROM registry.anchors a
   WHERE a.id = p_anchor_id
     AND EXISTS (
       SELECT 1 FROM registry.rental_units u
         JOIN org.properties p ON p.rental_unit_id = u.id
        WHERE u.anchor_id = a.id)
     FOR UPDATE OF a;
  IF NOT FOUND THEN
    RAISE EXCEPTION '物件不存在' USING ERRCODE = 'P0002';
  END IF;
  IF v_status NOT IN ('pending_verification', 'keyed') THEN
    RAISE EXCEPTION '物件目前不能修正建號' USING ERRCODE = '55000';
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
      -- 先前撞號待審的項目已不適用：這個物件登錄了沒人用的鍵
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
        RAISE EXCEPTION '物件登錄暫時失敗，請重試' USING ERRCODE = '40001';
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

  -- 撞到別的組織。次數以組織為單位：同一個組織的並行請求在這裡排隊，數的時候看得到前一個已寫的項目
  PERFORM pg_advisory_xact_lock(hashtextextended('registry.anchor_collision:' || v_org, 0));
  SELECT s.int_value INTO v_limit FROM registry.platform_settings s WHERE s.key = 'anchor_collision_daily_limit';
  v_limit := coalesce(v_limit, 50);
  SELECT count(*) INTO v_count
    FROM registry.review_items r
   WHERE r.type = 'anchor_collision'
     AND r.payload ->> 'claimant_org_id' = v_org
     AND r.created_at > now() - interval '24 hours';
  IF v_count >= v_limit THEN
    -- 登錄照常成立。只通知營運者，回傳值與次數沒滿時相同
    PERFORM registry.raise_collision_limit_alert(v_org, v_limit, p_alert_id);
  END IF;

  -- 同一個物件先前待審的撞號項目被這一張取代（仍算進次數，改宣稱不能繞過計數）
  UPDATE registry.review_items r
     SET status = 'resolved', resolved_at = now(), resolution = 'superseded'
   WHERE r.type = 'anchor_collision' AND r.subject_id = p_anchor_id AND r.status = 'open';
  -- 已建號的物件改成撞號的鍵：清掉原本的鍵，釋出給別的組織
  IF v_status = 'keyed' THEN
    UPDATE registry.anchors
       SET city_code = NULL, town_code = NULL, section_code = NULL, building_no = NULL, sub_no = NULL,
           status = 'pending_verification', updated_at = now()
     WHERE id = p_anchor_id;
  END IF;
  INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
  VALUES (
    p_item_id, 'anchor_collision', 'anchor', p_anchor_id,
    jsonb_build_object(
      'claimant_org_id', v_org,
      'existing_anchor_id', v_holder,
      'claimed_key', jsonb_build_object(
        'city_code', p_city_code, 'town_code', p_town_code, 'section_code', p_section,
        'building_no', v_building, 'sub_no', v_sub)));

  SELECT u.id INTO v_unit
    FROM registry.rental_units u
    JOIN org.properties p ON p.rental_unit_id = u.id
   WHERE u.anchor_id = p_anchor_id
   ORDER BY u.suffix, u.id
   LIMIT 1;
  PERFORM audit.append_platform_anchor_collision(v_org, v_unit, p_item_id);

  RETURN QUERY SELECT 'collision_queued'::text, p_item_id, NULL::text;
END
$$;

REVOKE ALL ON FUNCTION registry.assign_anchor_key(text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.assign_anchor_key(text, text, text, text, text, text, text, text) TO app_rw;

-- 5. 讀取：鍵撞到別的組織時，回傳呼叫者宣稱的鍵 --------------------------------------
-- 誰能呼叫：app_rw。回傳：p_unit_ids 之中，呼叫者組織有物件指向的單位所屬的物件。別的組織的單位 ID 與不存在的 ID 同樣得到空結果。
-- 鍵欄位：呼叫者組織有待審的撞號項目時，用項目裡宣稱的鍵，否則用物件自己的鍵。
--   只讀呼叫者組織自己提出的項目（payload 的宣稱方是自己），所以讀不到別的組織宣稱的任何東西。
-- 欄位與 0030 相同。status 欄位是內部狀態，應用程式不得拿它當對外狀態。
CREATE OR REPLACE FUNCTION registry.get_anchors_for_units(p_unit_ids text[])
RETURNS TABLE (
  unit_id          text,
  anchor_id        text,
  status           text,
  city_code        text,
  town_code        text,
  section_code     text,
  building_no      text,
  sub_no           text,
  city_name        text,
  town_name        text,
  section_name     text,
  section_sub_name text,
  latitude         double precision,
  longitude        double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
  WITH shown AS (
    SELECT u.id AS unit_id, a.id AS anchor_id, a.status, a.latitude, a.longitude,
           coalesce(c.ck ->> 'city_code', a.city_code)       AS city_code,
           coalesce(c.ck ->> 'town_code', a.town_code)       AS town_code,
           coalesce(c.ck ->> 'section_code', a.section_code) AS section_code,
           coalesce(c.ck ->> 'building_no', a.building_no)   AS building_no,
           coalesce(c.ck ->> 'sub_no', a.sub_no)             AS sub_no
      FROM registry.rental_units u
      JOIN registry.anchors a ON a.id = u.anchor_id
      LEFT JOIN LATERAL (
        SELECT r.payload -> 'claimed_key' AS ck
          FROM registry.review_items r
         WHERE r.type = 'anchor_collision' AND r.status = 'open' AND r.subject_id = a.id
           AND r.payload ->> 'claimant_org_id' = nullif(current_setting('app.org_id', true), '')
         ORDER BY r.created_at DESC
         LIMIT 1
      ) c ON true
     WHERE u.id = ANY (p_unit_ids)
       AND EXISTS (SELECT 1 FROM org.properties p WHERE p.rental_unit_id = u.id)
  )
  SELECT s.unit_id, s.anchor_id, s.status, s.city_code, s.town_code, s.section_code, s.building_no, s.sub_no,
         ar.city_name, ar.town_name, se.name, se.sub_name, s.latitude, s.longitude
    FROM shown s
    LEFT JOIN registry.areas ar ON ar.city_code = s.city_code AND ar.town_code = s.town_code
    LEFT JOIN registry.sections se
           ON se.city_code = s.city_code AND se.town_code = s.town_code AND se.code = s.section_code
$$;

-- 單位資料與顯示編碼要用的縣市、鄉鎮市區編碼。撞號時用呼叫者宣稱的鍵，顯示編碼才與沒撞號時的格式相同。
-- 誰能呼叫與隔離方式同上。欄位與 0032 相同。
CREATE OR REPLACE FUNCTION registry.get_unit_details(p_unit_ids text[])
RETURNS TABLE (
  unit_id           text,
  suffix            text,
  label             text,
  floor             text,
  unit_type         text,
  status            text,
  display_unit_id   text,
  display_city_code text,
  display_town_code text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
  WITH RECURSIVE chain (origin, id, merged_into_id, depth) AS (
    SELECT u.id, u.id, u.merged_into_id, 0
      FROM registry.rental_units u
     WHERE u.id = ANY (p_unit_ids)
       AND EXISTS (SELECT 1 FROM org.properties p WHERE p.rental_unit_id = u.id)
    UNION ALL
    SELECT c.origin, n.id, n.merged_into_id, c.depth + 1
      FROM chain c
      JOIN registry.rental_units n ON n.id = c.merged_into_id
     WHERE c.depth < 10
  ),
  survivor AS (
    SELECT DISTINCT ON (origin) origin, id FROM chain ORDER BY origin, depth DESC
  )
  SELECT u.id, u.suffix, u.label, u.floor, u.unit_type, u.status, s.id,
         coalesce(c.ck ->> 'city_code', a.city_code),
         coalesce(c.ck ->> 'town_code', a.town_code)
    FROM survivor s
    JOIN registry.rental_units u  ON u.id = s.origin
    JOIN registry.rental_units su ON su.id = s.id
    JOIN registry.anchors a       ON a.id = su.anchor_id
    LEFT JOIN LATERAL (
      SELECT r.payload -> 'claimed_key' AS ck
        FROM registry.review_items r
       WHERE r.type = 'anchor_collision' AND r.status = 'open' AND r.subject_id = a.id
         AND r.payload ->> 'claimant_org_id' = nullif(current_setting('app.org_id', true), '')
       ORDER BY r.created_at DESC
       LIMIT 1
    ) c ON true
$$;
