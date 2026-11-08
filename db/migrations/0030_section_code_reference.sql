-- 段碼與行政區參照表、錨點鍵的外鍵與 CHECK、補建號與讀取函式（MIL-143，ADR-0025 決議 1 到 5）。
-- 由 runner 以 app_owner 執行。B 線的 migration 編號從 0030 起，避開 A 線。
-- 資料在 0031，由 scripts/registry/seed-to-migration.mjs 從 seed 檔產出。執行期不呼叫外部服務。

-- 1. 參照表 ---------------------------------------------------------------------
-- 不掛組織 RLS，app_rw 沒有任何直接權限。畫面的選單走伺服器端的 seed 檔，資料庫這兩張表負責外鍵、CHECK 與補建號的檢查。

-- 縣市與鄉鎮市區編碼表。縣市 1 碼英文字母，鄉鎮市區 2 碼數字，與縣市合用才唯一
CREATE TABLE registry.areas (
  city_code text NOT NULL CHECK (city_code ~ '^[A-Z]$'),
  town_code text NOT NULL CHECK (town_code ~ '^[0-9]{2}$'),
  city_name text NOT NULL,
  town_name text NOT NULL,
  PRIMARY KEY (city_code, town_code)
);

-- 段碼表。鍵是縣市、鄉鎮市區（跨越段取主行政區）、段碼。段碼 4 碼數字文字，保留前導零
CREATE TABLE registry.sections (
  city_code        text NOT NULL,
  town_code        text NOT NULL,
  code             text NOT NULL CHECK (code ~ '^[0-9]{4}$'),
  name             text NOT NULL,
  sub_name         text NOT NULL DEFAULT '',
  -- 跨越段的別名行政區。畫面從這些鄉鎮也選得到，鍵仍存主行政區
  alias_town_codes text[] NOT NULL DEFAULT '{}',
  -- 註銷列匯入為已註銷：畫面不得選取，既有錨點不改鍵
  canceled         boolean NOT NULL DEFAULT false,
  PRIMARY KEY (city_code, town_code, code),
  FOREIGN KEY (city_code, town_code) REFERENCES registry.areas (city_code, town_code)
);

REVOKE ALL ON registry.areas, registry.sections FROM PUBLIC, app_rw;

-- 參照表只增改，不刪列（ADR-0025 決議 2）。段被註銷時改 canceled，不刪
CREATE FUNCTION registry.forbid_reference_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = registry, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '段碼參照表只增改，不刪列（%）', TG_TABLE_NAME;
END
$$;

CREATE TRIGGER areas_no_delete BEFORE DELETE ON registry.areas
  FOR EACH ROW EXECUTE FUNCTION registry.forbid_reference_delete();
CREATE TRIGGER sections_no_delete BEFORE DELETE ON registry.sections
  FOR EACH ROW EXECUTE FUNCTION registry.forbid_reference_delete();

-- 2. 錨點鍵的 CHECK 與外鍵 -------------------------------------------------------
-- 縣市 1 碼字母、鄉鎮市區 2 碼數字、段碼 4 碼、建號 5 碼、分號 3 碼（沒有分號存 000）。
-- 欄位為空（待驗證）時 CHECK 與外鍵都不檢查，所以另加「全有或全無」。
ALTER TABLE registry.anchors
  ADD CONSTRAINT anchors_city_code_format    CHECK (city_code ~ '^[A-Z]$'),
  ADD CONSTRAINT anchors_town_code_format    CHECK (town_code ~ '^[0-9]{2}$'),
  ADD CONSTRAINT anchors_section_code_format CHECK (section_code ~ '^[0-9]{4}$'),
  ADD CONSTRAINT anchors_building_no_format  CHECK (building_no ~ '^[0-9]{5}$'),
  ADD CONSTRAINT anchors_sub_no_format       CHECK (sub_no ~ '^[0-9]{3}$'),
  ADD CONSTRAINT anchors_key_all_or_none CHECK (
    (city_code IS NULL) = (town_code IS NULL)
    AND (city_code IS NULL) = (section_code IS NULL)
    AND (city_code IS NULL) = (building_no IS NULL)
    AND (city_code IS NULL) = (sub_no IS NULL)
  ),
  ADD CONSTRAINT anchors_keyed_has_key CHECK (status <> 'keyed' OR city_code IS NOT NULL),
  ADD CONSTRAINT anchors_coordinates CHECK (
    (latitude IS NULL) = (longitude IS NULL)
    AND (latitude IS NULL OR latitude BETWEEN -90 AND 90)
    AND (longitude IS NULL OR longitude BETWEEN -180 AND 180)
  ),
  ADD CONSTRAINT anchors_area_fk FOREIGN KEY (city_code, town_code)
    REFERENCES registry.areas (city_code, town_code),
  ADD CONSTRAINT anchors_section_fk FOREIGN KEY (city_code, town_code, section_code)
    REFERENCES registry.sections (city_code, town_code, code);

-- 3. 補建號 -----------------------------------------------------------------------
-- 待驗證的錨點補上五欄鍵，沒有撞號時轉已建號。回傳新狀態。
-- 呼叫者組織必須有物件指向這個錨點的單位：別的組織的錨點與不存在的錨點，錯誤完全相同。
-- 撞號（任何組織，含自己）一律回固定錯誤。B3（MIL-144）把它換成送審核台的流程。
-- 鍵由呼叫端先經 normalizeAnchorKey 正規化；這裡再驗一次，並補零（建號 5 碼、分號 3 碼）。
CREATE FUNCTION registry.assign_anchor_key(
  p_anchor_id   text,
  p_city_code   text,
  p_town_code   text,
  p_section     text,
  p_building_no text,
  p_sub_no      text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_status   text;
  v_building text;
  v_sub      text;
  v_canceled boolean;
BEGIN
  IF coalesce(current_setting('app.org_id', true), '') = '' THEN
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

  -- 撞號：錯誤訊息固定，不帶鍵與對方的任何資料
  IF EXISTS (
    SELECT 1 FROM registry.anchors a
     WHERE a.city_code = p_city_code AND a.town_code = p_town_code AND a.section_code = p_section
       AND a.building_no = v_building AND a.sub_no = v_sub
       AND a.status IN ('pending_verification', 'keyed')
       AND a.id <> p_anchor_id
  ) THEN
    RAISE EXCEPTION '撞號處理尚未實作' USING ERRCODE = '23505';
  END IF;

  BEGIN
    UPDATE registry.anchors
       SET city_code = p_city_code, town_code = p_town_code, section_code = p_section,
           building_no = v_building, sub_no = v_sub, status = 'keyed', updated_at = now()
     WHERE id = p_anchor_id;
  EXCEPTION WHEN unique_violation THEN
    -- 兩個交易同時搶同一個鍵：後到的也得到固定錯誤，不得露出唯一索引的詳情
    RAISE EXCEPTION '撞號處理尚未實作' USING ERRCODE = '23505';
  END;
  RETURN 'keyed';
END
$$;

REVOKE ALL ON FUNCTION registry.assign_anchor_key(text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.assign_anchor_key(text, text, text, text, text, text) TO app_rw;

-- 4. 讀取錨點 ---------------------------------------------------------------------
-- 物件頁顯示產權用。只回呼叫者組織有物件指向的單位：別的組織的單位 ID 與不存在的 ID 同樣得到空結果。
-- 名稱取自參照表（臺），畫面不必另載段碼表。
-- 注意（B4 合併、B2 分租之後）：兩個組織的單位掛在同一個錨點時，這個函式會讓雙方都讀到錨點上的座標。
-- 目前每個物件都建新錨點，碰不到。MIL-146 合併錨點時必須決定座標歸誰，再改這裡。
CREATE FUNCTION registry.get_anchors_for_units(p_unit_ids text[])
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
  SELECT u.id, a.id, a.status, a.city_code, a.town_code, a.section_code, a.building_no, a.sub_no,
         ar.city_name, ar.town_name, s.name, s.sub_name, a.latitude, a.longitude
    FROM registry.rental_units u
    JOIN registry.anchors a ON a.id = u.anchor_id
    LEFT JOIN registry.areas ar ON ar.city_code = a.city_code AND ar.town_code = a.town_code
    LEFT JOIN registry.sections s
           ON s.city_code = a.city_code AND s.town_code = a.town_code AND s.code = a.section_code
   WHERE u.id = ANY (p_unit_ids)
     AND EXISTS (SELECT 1 FROM org.properties p WHERE p.rental_unit_id = u.id)
$$;

REVOKE ALL ON FUNCTION registry.get_anchors_for_units(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.get_anchors_for_units(text[]) TO app_rw;
