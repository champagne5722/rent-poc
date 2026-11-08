-- 執業主體、業別與審核台項目的最小形狀（MIL-106，ADR-0017 決議 3、5、11，ADR-0022 決議 4）。
-- 由 runner 以 app_owner 執行。registry 不掛組織 RLS，app_rw 沒有任何直接權限，只能呼叫下面的 SECURITY DEFINER 函式
-- （ADR-0012 決議 8），所以回傳值不會帶出別的組織的資料。
--
-- 這張票只建「經理人第一次登入時登錄」需要的欄位。MIL-109 補營業項目、登記狀態、核對紀錄與審核動作，
-- MIL-111 補執業人員與任職。那些欄位由各自的票補，這裡不預建。review_items.type 例外：審核台一個佇列列七種項目，
-- 先列齊種類，之後各票產生項目時不必改約束。

-- 1. practice_entities：執業主體 -----------------------------------------------
-- 一個執業主體對應一個組織（P0-02）。統編全域唯一：第二個組織認領同一統編時不建新列（見 claim_practice_entity）。
-- 執業主體本身不存驗證狀態，狀態在業別、證書、任職三層（ADR-0017 決議 5）。
CREATE TABLE registry.practice_entities (
  id          text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  tax_id      text NOT NULL UNIQUE CHECK (tax_id ~ '^[0-9]{8}$'),
  name        text NOT NULL,
  -- 公司或商號。代管與包租限公司（P0-03 規則 2），檢查在應用程式的 registry-rules
  entity_type text NOT NULL CHECK (entity_type IN ('company', 'firm')),
  org_id      text NOT NULL UNIQUE REFERENCES control.orgs (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 2. practice_licenses：業別，驗證三態的業別層 ---------------------------------
-- 兼營時一個執業主體有多列。登錄時一律是 pending（ADR-0017 決議 4 的 submitted）。
CREATE TABLE registry.practice_licenses (
  id         text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  entity_id  text NOT NULL REFERENCES registry.practice_entities (id),
  kind       text NOT NULL CHECK (kind IN ('management', 'master_lease', 'brokerage')),
  state      text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'verified', 'lapsed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  UNIQUE (entity_id, kind)
);

-- 3. review_items：審核台的佇列項目 ---------------------------------------------
-- 審核台一個佇列頁列出七種項目（MIL-100 審核台），等待時間 = 現在 - created_at。
-- 這張票只產生兩種：license（新登錄的待驗證業別）與 entity_claim（第二個組織認領同一統編）。
-- 其餘五種由 MIL-109、111、112 產生，type 的 CHECK 先列齊，之後不必改約束。
-- payload 只放判定需要的欄位，不放自然人個資。
CREATE TABLE registry.review_items (
  id           text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  type         text NOT NULL CHECK (type IN (
                 'license', 'certificate', 'employment', 'consent',
                 'entity_recheck', 'employment_recheck', 'entity_claim')),
  -- 被審的對象。entity_claim 的對象是被認領的執業主體，license 的對象是業別列
  subject_type text NOT NULL,
  subject_id   text NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  text,
  CHECK ((status = 'open') = (resolved_at IS NULL))
);
CREATE INDEX review_items_open ON registry.review_items (created_at) WHERE status = 'open';

REVOKE ALL ON registry.practice_entities, registry.practice_licenses, registry.review_items FROM PUBLIC, app_rw;

-- 4. claim_practice_entity：登錄執業主體，或在統編已被登錄時排審核台 ----------------
-- 在組織脈絡內呼叫，p_org_id 必須等於目前的 app.org_id（新建的組織）。
-- 回傳值只有結果代碼，不含任何別的組織的資料：
--   registered  統編沒人登錄：建 practice_entities 與 pending 的 practice_licenses，每個業別排一筆 license 項目。
--   claim_queued 統編已被別的組織登錄：不建新列，排一筆 entity_claim 項目。
-- 呼叫端對外必須讓 registered 與 claim_queued 的回應一致（不透露統編是否已被登錄）。
CREATE FUNCTION registry.claim_practice_entity(
  p_org_id      text,
  p_tax_id      text,
  p_name        text,
  p_entity_type text,
  p_kinds       text[],
  p_entity_id   text,
  p_license_ids text[],
  p_item_ids    text[]
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_inserted text;
  i int;
BEGIN
  IF coalesce(current_setting('app.org_id', true), '') = '' OR current_setting('app.org_id', true) <> p_org_id THEN
    RAISE EXCEPTION 'registry.claim_practice_entity 必須在 p_org_id 的組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF coalesce(array_length(p_kinds, 1), 0) = 0
     OR array_length(p_license_ids, 1) IS DISTINCT FROM array_length(p_kinds, 1)
     OR array_length(p_item_ids, 1) IS DISTINCT FROM array_length(p_kinds, 1) + 1 THEN
    RAISE EXCEPTION '業別、業別 ID 與項目 ID 的數量不一致' USING ERRCODE = '22023';
  END IF;

  INSERT INTO registry.practice_entities (id, tax_id, name, entity_type, org_id)
  VALUES (p_entity_id, p_tax_id, p_name, p_entity_type, p_org_id)
  ON CONFLICT (tax_id) DO NOTHING
  RETURNING id INTO v_inserted;

  IF v_inserted IS NOT NULL THEN
    FOR i IN 1 .. array_length(p_kinds, 1) LOOP
      INSERT INTO registry.practice_licenses (id, entity_id, kind) VALUES (p_license_ids[i], p_entity_id, p_kinds[i]);
      INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
      VALUES (p_item_ids[i], 'license', 'license', p_license_ids[i], jsonb_build_object('kind', p_kinds[i]));
    END LOOP;
    RETURN 'registered';
  END IF;

  INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
  SELECT p_item_ids[array_length(p_item_ids, 1)], 'entity_claim', 'entity', e.id,
         jsonb_build_object('tax_id', p_tax_id, 'name', p_name, 'entity_type', p_entity_type,
                            'kinds', to_jsonb(p_kinds), 'claimant_org_id', p_org_id)
    FROM registry.practice_entities e WHERE e.tax_id = p_tax_id;
  RETURN 'claim_queued';
END
$$;

REVOKE ALL ON FUNCTION registry.claim_practice_entity(text, text, text, text, text[], text, text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.claim_practice_entity(text, text, text, text, text[], text, text[], text[]) TO app_rw;
