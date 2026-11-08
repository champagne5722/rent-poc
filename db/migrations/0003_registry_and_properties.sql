-- registry 骨架、物件與設備詞彙庫（MIL-81，ADR-0012、ADR-0013、ADR-0025）。
-- 由 runner 以 app_owner 執行，物件自動歸 app_owner。
-- 這是第一條完整路徑，之後 org 表的寫法照這裡：org_id、複合唯一鍵、ENABLE 與 FORCE RLS、legacy_id。

-- 1. registry：全域登錄的產權錨點與租賃單位 -----------------------------------
-- 不掛組織 RLS（ADR-0012 決議 8）。app_rw 沒有任何直接權限，只能呼叫下面的 SECURITY DEFINER 函式。
-- B 線（MIL-142）在這個骨架上補段碼參照表、外鍵與 CHECK、補建號、撞號、合併與解析。
-- 欄位格式依 ADR-0025 決議 3（縣市 1 碼、鄉鎮市區 2 碼、段 4 碼、建號 5 碼、分號 3 碼，沒有分號存 000），
-- 這裡不加 CHECK，待驗證的錨點五欄都可以為空。

CREATE TABLE registry.anchors (
  id                 text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  city_code          text,
  town_code          text,
  section_code       text,
  building_no        text,
  sub_no             text,
  status             text NOT NULL DEFAULT 'pending_verification'
                       CHECK (status IN ('pending_verification', 'keyed', 'merged', 'retired')),
  merged_into_id     text REFERENCES registry.anchors (id),
  address            text,
  address_normalized text,
  latitude           double precision,
  longitude          double precision,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz
);

-- 五欄鍵只涵蓋待驗證與已建號的錨點（ADR-0013 決議 1）。欄位為空的列不互相衝突
CREATE UNIQUE INDEX anchors_key_unique
  ON registry.anchors (city_code, town_code, section_code, building_no, sub_no)
  WHERE status IN ('pending_verification', 'keyed');

CREATE TABLE registry.rental_units (
  id             text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  anchor_id      text NOT NULL REFERENCES registry.anchors (id),
  -- 平台依錨點發序號。0000 是整戶，分租單位從 0001 起（ADR-0013 決議 6）。房號只放 label
  suffix         text NOT NULL,
  label          text,
  floor          text,
  unit_type      text NOT NULL CHECK (unit_type IN ('whole', 'room')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'retired')),
  merged_into_id text REFERENCES registry.rental_units (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz,
  UNIQUE (anchor_id, suffix)
);

REVOKE ALL ON registry.anchors, registry.rental_units FROM PUBLIC, app_rw;

-- 建立待驗證錨點與 0000 整戶單位，與物件同一個交易呼叫（P0-06 AC5）。
-- ID 由應用程式產生後傳入（ADR-0012 決議 9）。回應只有這兩個 ID，不含任何別的組織的資料。
-- 必須在組織脈絡內呼叫：沒有 app.org_id 的入口（登入、webhook）不得建錨點。
CREATE FUNCTION registry.create_pending_anchor(
  p_anchor_id          text,
  p_unit_id            text,
  p_address            text,
  p_address_normalized text DEFAULT NULL,
  p_latitude           double precision DEFAULT NULL,
  p_longitude          double precision DEFAULT NULL
)
RETURNS TABLE (anchor_id text, unit_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.org_id', true), '') = '' THEN
    RAISE EXCEPTION 'registry.create_pending_anchor 必須在組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;

  INSERT INTO registry.anchors (id, status, address, address_normalized, latitude, longitude)
  VALUES (p_anchor_id, 'pending_verification', p_address, p_address_normalized, p_latitude, p_longitude);

  INSERT INTO registry.rental_units (id, anchor_id, suffix, unit_type)
  VALUES (p_unit_id, p_anchor_id, '0000', 'whole');

  RETURN QUERY SELECT p_anchor_id, p_unit_id;
END
$$;

REVOKE ALL ON FUNCTION registry.create_pending_anchor(text, text, text, text, double precision, double precision)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.create_pending_anchor(text, text, text, text, double precision, double precision)
  TO app_rw;

-- 2. org.properties：物件 -------------------------------------------------------
-- 物件是一個組織對一個租賃單位持有的營運資料（GLOSSARY）。rental_unit_id 不得為空。
CREATE TABLE org.properties (
  id             text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id         text NOT NULL REFERENCES control.orgs (id),
  -- org 到 registry 的外鍵：app_rw 沒有 registry 權限也能寫入有效 ID，無效 ID 被擋下（ADR-0013 決議 11）
  rental_unit_id text NOT NULL REFERENCES registry.rental_units (id),
  name           text NOT NULL,
  address        text NOT NULL,
  type           text NOT NULL DEFAULT '整層住家' CHECK (type IN ('整層住家', '套房', '雅房')),
  size           double precision,
  default_rent   integer,
  note           text NOT NULL DEFAULT '',
  equipment      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 舊 SQLite 的 id，只供遷移對照，切換穩定 2 週後移除（ADR-0012 決議 9，MIL-93）
  legacy_id      integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz,
  -- 供其他 org 表建 (org_id, property_id) 複合外鍵，避免外鍵穿透 RLS（ADR-0012 陷阱 5）
  UNIQUE (org_id, id),
  UNIQUE (org_id, legacy_id)
);

CREATE INDEX properties_org_created ON org.properties (org_id, id DESC);
CREATE INDEX properties_rental_unit ON org.properties (org_id, rental_unit_id);

ALTER TABLE org.properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.properties FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.properties
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- 3. org.equipment_vocabulary：設備詞彙庫 -----------------------------------------
-- 組織層級的設備項目字典：平台預設項目（is_custom = false）加組織自訂項目（GLOSSARY）。
-- 每個組織各有一份。平台預設由 repository 在交易內補齊，常數是 src/lib/types.ts 的 EQUIPMENT_OPTIONS。
-- 業務唯一鍵含 org_id：兩個組織能有同名的項目，也不會因撞號洩漏別的組織有這個項目（陷阱 6）。
CREATE TABLE org.equipment_vocabulary (
  id         text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id     text NOT NULL REFERENCES control.orgs (id),
  name       text NOT NULL CHECK (btrim(name) <> ''),
  is_custom  boolean NOT NULL DEFAULT false,
  legacy_id  integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  UNIQUE (org_id, id),
  UNIQUE (org_id, legacy_id)
);

ALTER TABLE org.equipment_vocabulary ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.equipment_vocabulary FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.equipment_vocabulary
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
