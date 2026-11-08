-- 分租單位、封存與單位停用（MIL-145，ADR-0013 決議 5、6，ADR-0025 決議 12 到 14）。
-- 由 runner 以 app_owner 執行。
--
-- 1. 租賃單位的值集合補 CHECK。0003 把 unit_type 與 status 留給 B 線定案。
-- 2. 持有計數：沒有任何組織的物件指向的單位轉 retired。
-- 3. org.properties 加 archived_at。
-- 4. 新增分租單位函式，與讀單位資料的兩個函式。

-- 1. 值集合 -------------------------------------------------------------------
-- whole 是整戶，後綴固定 0000。sublet 是分租，後綴從 0001 起（ADR-0013 決議 6）。
-- merged 與 retired 的語意見 ADR-0013 決議 8 與 ADR-0025 決議 14。
ALTER TABLE registry.rental_units
  ADD CONSTRAINT rental_units_suffix_format CHECK (suffix ~ '^[0-9]{4}$'),
  ADD CONSTRAINT rental_units_type_values   CHECK (unit_type IN ('whole', 'sublet')),
  ADD CONSTRAINT rental_units_status_values CHECK (status IN ('active', 'merged', 'retired')),
  ADD CONSTRAINT rental_units_whole_suffix  CHECK ((unit_type = 'whole') = (suffix = '0000'));

-- 2. 持有計數 -----------------------------------------------------------------
-- 為什麼要計數：org.properties 有 RLS，SECURITY DEFINER 函式只看得到呼叫者組織的物件，
-- 數不出「別的組織還有沒有物件指向這個單位」。計數由觸發器在每次物件列異動時維護，
-- 不論哪個組織的交易觸發，更新的都是 registry 的單位列本身。
-- 封存的物件仍是一列，仍算持有。單位只在最後一個物件列被刪除時轉 retired。
-- 之後有組織建物件指向 retired 的單位（合併或移交，ADR-0025 決議 13），單位回到 active。
ALTER TABLE registry.rental_units
  ADD COLUMN holder_count integer NOT NULL DEFAULT 0 CHECK (holder_count >= 0);

-- 既有資料回填。app_owner 是 org.properties 的擁有者，暫時解除 FORCE 才看得到所有組織的列。
ALTER TABLE org.properties NO FORCE ROW LEVEL SECURITY;
UPDATE registry.rental_units u
   SET holder_count = c.n
  FROM (SELECT rental_unit_id, count(*)::integer AS n FROM org.properties GROUP BY rental_unit_id) c
 WHERE c.rental_unit_id = u.id;
UPDATE registry.rental_units SET status = 'retired', updated_at = now()
 WHERE holder_count = 0 AND status = 'active';
ALTER TABLE org.properties FORCE ROW LEVEL SECURITY;

CREATE FUNCTION registry.track_unit_holders() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.rental_unit_id IS NOT DISTINCT FROM OLD.rental_unit_id THEN
    RETURN NEW;
  END IF;

  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    UPDATE registry.rental_units
       SET holder_count = holder_count - 1,
           status = CASE WHEN holder_count - 1 = 0 AND status = 'active' THEN 'retired' ELSE status END,
           updated_at = now()
     WHERE id = OLD.rental_unit_id;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE registry.rental_units
       SET holder_count = holder_count + 1,
           status = CASE WHEN status = 'retired' THEN 'active' ELSE status END,
           updated_at = CASE WHEN status = 'retired' THEN now() ELSE updated_at END
     WHERE id = NEW.rental_unit_id;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER properties_track_unit_holders
  AFTER INSERT OR DELETE OR UPDATE OF rental_unit_id ON org.properties
  FOR EACH ROW EXECUTE FUNCTION registry.track_unit_holders();

-- 3. 封存 ---------------------------------------------------------------------
-- 物件有任何合約時，刪除改為封存（P0-06 AC8，ADR-0025 決議 14）。封存不可逆，本票不做解除。
ALTER TABLE org.properties ADD COLUMN archived_at timestamptz;

-- 4. 新增分租單位 -------------------------------------------------------------
-- 在來源單位所屬的錨點下建新的 sublet 單位，後綴取該錨點下一號（含 retired 與 merged 的單位，永不重用）。
-- 來源單位必須有呼叫者組織的物件指向它：別的組織的單位與不存在的單位，得到完全相同的錯誤，
-- 所以使用者不得把單位掛到別的組織的錨點（ADR-0025 決議 13）。
-- 鎖住錨點列，兩個交易同時發號時排隊，後到的看得到先到的列。
-- 物件列由呼叫端在同一個交易建立，單位的持有計數由觸發器加一。
CREATE FUNCTION registry.create_sublet_unit(
  p_source_unit_id text,
  p_new_unit_id    text,
  p_label          text,
  p_floor          text DEFAULT NULL
)
RETURNS TABLE (anchor_id text, unit_id text, suffix text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_anchor        text;
  v_anchor_status text;
  v_unit_status   text;
  v_label         text := btrim(coalesce(p_label, ''));
  v_floor         text := nullif(btrim(coalesce(p_floor, '')), '');
  v_next          integer;
BEGIN
  IF coalesce(current_setting('app.org_id', true), '') = '' THEN
    RAISE EXCEPTION 'registry.create_sublet_unit 必須在組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;

  SELECT a.id, a.status, u.status INTO v_anchor, v_anchor_status, v_unit_status
    FROM registry.rental_units u
    JOIN registry.anchors a ON a.id = u.anchor_id
   WHERE u.id = p_source_unit_id
     AND EXISTS (SELECT 1 FROM org.properties p WHERE p.rental_unit_id = u.id)
     FOR UPDATE OF a;
  IF NOT FOUND THEN
    RAISE EXCEPTION '租賃單位不存在' USING ERRCODE = 'P0002';
  END IF;
  IF v_anchor_status NOT IN ('pending_verification', 'keyed') OR v_unit_status <> 'active' THEN
    RAISE EXCEPTION '產權已合併或停用，不能新增分租單位' USING ERRCODE = '55000';
  END IF;

  IF v_label = '' OR char_length(v_label) > 40 THEN
    RAISE EXCEPTION '房號必須是 1 到 40 個字' USING ERRCODE = '22023';
  END IF;
  IF v_floor IS NOT NULL AND char_length(v_floor) > 20 THEN
    RAISE EXCEPTION '樓層不得超過 20 個字' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(max(u.suffix::integer), 0) + 1 INTO v_next
    FROM registry.rental_units u
   WHERE u.anchor_id = v_anchor;
  IF v_next > 9999 THEN
    RAISE EXCEPTION '這個產權的單位後綴已用完' USING ERRCODE = '54000';
  END IF;

  INSERT INTO registry.rental_units (id, anchor_id, suffix, label, floor, unit_type, status)
  VALUES (p_new_unit_id, v_anchor, lpad(v_next::text, 4, '0'), v_label, v_floor, 'sublet', 'active');

  RETURN QUERY SELECT v_anchor, p_new_unit_id, lpad(v_next::text, 4, '0');
END
$$;

REVOKE ALL ON FUNCTION registry.create_sublet_unit(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.create_sublet_unit(text, text, text, text) TO app_rw;

-- 5. 讀單位資料 ---------------------------------------------------------------
-- 回單位自己的欄位，加顯示編碼要用的縣市與鄉鎮編碼。被合併的單位沿 merged_into_id 走到存續單位，
-- 編碼取存續單位所屬錨點的（ADR-0025 決議 12）。完整的舊 ID 解析函式屬 MIL-146，這裡只為顯示編碼走鏈。
-- 待驗證的錨點沒有編碼，兩欄是 NULL。只回呼叫者組織有物件指向的單位。
CREATE FUNCTION registry.get_unit_details(p_unit_ids text[])
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
  SELECT u.id, u.suffix, u.label, u.floor, u.unit_type, u.status, s.id, a.city_code, a.town_code
    FROM survivor s
    JOIN registry.rental_units u  ON u.id = s.origin
    JOIN registry.rental_units su ON su.id = s.id
    JOIN registry.anchors a       ON a.id = su.anchor_id
$$;

REVOKE ALL ON FUNCTION registry.get_unit_details(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.get_unit_details(text[]) TO app_rw;

-- 同一個錨點下，呼叫者組織有物件指向的所有單位。來源單位不是呼叫者組織的，回空結果。
-- 物件頁列出「同一產權的單位」，也用來找整戶（後綴 0000）的物件，判斷新增分租單位前要不要警告。
CREATE FUNCTION registry.get_sibling_units(p_unit_id text)
RETURNS TABLE (
  property_id text,
  unit_id     text,
  suffix      text,
  label       text,
  floor       text,
  unit_type   text,
  status      text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
  SELECT p.id, u.id, u.suffix, u.label, u.floor, u.unit_type, u.status
    FROM registry.rental_units src
    JOIN registry.rental_units u ON u.anchor_id = src.anchor_id
    JOIN org.properties p        ON p.rental_unit_id = u.id
   WHERE src.id = p_unit_id
     AND EXISTS (SELECT 1 FROM org.properties p0 WHERE p0.rental_unit_id = src.id)
   ORDER BY u.suffix, p.id
$$;

REVOKE ALL ON FUNCTION registry.get_sibling_units(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.get_sibling_units(text) TO app_rw;
