-- 案件種類（MIL-195，ADR-0030 決議 1 到 5）。由 runner 以 app_owner 執行。
--
-- 案件在資料上有四個種類：租賃（lease）、委託管理（management）、包租（master_lease）、轉租（sublease）。
-- 新增欄位 org.cases.case_kind，舊欄位 kind 與 business_type 原封不動，既有的呼叫端不壞。
--
-- 用詞改了，讀舊程式碼與舊註解時照下表換讀：
--   案件種類      kind         business_type  備註
--   租賃          lease        self_managed   承租人不是包租業者
--   租賃          lease        managed
--   委託管理      management   (NULL)
--   包租          lease        self_managed   承租人是包租業者。屋主租給包租業者那一份（住宅包租契約）
--   轉租          lease        master_lease   舊值 master_lease 指轉租。包租業者轉租給承租人那一份（住宅轉租契約）
-- 注意：business_type 的 master_lease 是舊值，指轉租；case_kind 的 master_lease 是新的包租案件。兩者不同義。
-- business_type 的舊值由後續的票逐批搬走，最後移除（MIL-197、MIL-198、MIL-203）。
--
-- 1. 回填：既有案件照 ADR-0030 決議 2 歸類。承租人是不是包租業者，讀目前合約的 fields.routing.lesseeIsMasterLessor。
--    只有 business_type = self_managed 的案件看這個旗標。沒有合約或沒有分流條件時視為不是。
-- 2. 之後的寫入：舊的呼叫端不寫 case_kind 時，由 trigger 補值（委託管理、轉租、租賃）。
--    trigger 不會補出包租案件，因為它需要承租人的事實，呼叫端必須明寫。
-- 3. 一致性 CHECK：case_kind 與 kind、business_type 不得矛盾。
-- 4. linked_master_lease_case_id：轉租案件連到的包租案件（ADR-0030 決議 5），複合外鍵限制在同一個組織。
--    既有的轉租案件沒有連結，所以資料庫不要求必填。必填由建立判定函式（src/lib/cases/creation.ts）負責。
--
-- org.cases 與 org.contracts 都是 FORCE RLS，沒有組織脈絡的 app_owner 讀不到任何列（見 0074 的說明）。
-- 所以回填逐組織設定脈絡。CHECK 與 NOT NULL 的驗證走整表掃描，不受 RLS 影響，但回填後仍逐組織確認沒有遺漏。

ALTER TABLE org.cases ADD COLUMN case_kind text;
ALTER TABLE org.cases ADD COLUMN linked_master_lease_case_id text;

-- 2. 舊的呼叫端不寫 case_kind 時補值 ------------------------------------------------
CREATE FUNCTION org.cases_default_case_kind() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.case_kind IS NULL THEN
    NEW.case_kind := CASE
      WHEN NEW.kind = 'management' THEN 'management'
      WHEN NEW.business_type = 'master_lease' THEN 'sublease'
      ELSE 'lease'
    END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cases_default_case_kind
  BEFORE INSERT ON org.cases
  FOR EACH ROW EXECUTE FUNCTION org.cases_default_case_kind();

-- 1. 回填，逐組織 ---------------------------------------------------------------------
DO $$
DECLARE
  prev_org  text := coalesce(current_setting('app.org_id', true), '');
  one_org   record;
  remaining integer;
  total     integer := 0;
BEGIN
  FOR one_org IN SELECT id FROM control.orgs ORDER BY id LOOP
    PERFORM set_config('app.org_id', one_org.id, true);
    UPDATE org.cases k
       SET case_kind = CASE
         WHEN k.kind = 'management' THEN 'management'
         WHEN k.business_type = 'master_lease' THEN 'sublease'
         WHEN k.business_type = 'self_managed'
              AND coalesce((SELECT c.fields #>> '{routing,lesseeIsMasterLessor}'
                              FROM org.contracts c
                             WHERE c.org_id = k.org_id AND c.id = k.current_contract_id), 'false') = 'true'
           THEN 'master_lease'
         ELSE 'lease'
       END
     WHERE k.case_kind IS NULL;

    SELECT count(*) INTO remaining FROM org.cases WHERE case_kind IS NULL;
    total := total + remaining;
  END LOOP;
  PERFORM set_config('app.org_id', prev_org, true);

  IF total > 0 THEN
    RAISE EXCEPTION '回填案件種類後仍有 % 筆案件沒有種類。migration 不會繼續。', total;
  END IF;
END
$$;

-- 3. 約束 -----------------------------------------------------------------------------
ALTER TABLE org.cases ALTER COLUMN case_kind SET NOT NULL;

ALTER TABLE org.cases ADD CONSTRAINT cases_case_kind_check
  CHECK (case_kind IN ('lease', 'management', 'master_lease', 'sublease'));

ALTER TABLE org.cases ADD CONSTRAINT cases_case_kind_consistent
  CHECK (
    (case_kind = 'management' AND kind = 'management')
    OR (case_kind = 'sublease' AND kind = 'lease' AND business_type = 'master_lease')
    OR (case_kind = 'master_lease' AND kind = 'lease' AND business_type = 'self_managed')
    OR (case_kind = 'lease' AND kind = 'lease' AND business_type IN ('self_managed', 'managed'))
  );

-- 4. 轉租案件連到的包租案件 -------------------------------------------------------------
ALTER TABLE org.cases ADD CONSTRAINT cases_linked_master_lease_only_sublease
  CHECK (linked_master_lease_case_id IS NULL OR case_kind = 'sublease');

ALTER TABLE org.cases ADD CONSTRAINT cases_linked_master_lease_fk
  FOREIGN KEY (org_id, linked_master_lease_case_id) REFERENCES org.cases (org_id, id);

CREATE INDEX cases_linked_master_lease ON org.cases (org_id, linked_master_lease_case_id)
  WHERE linked_master_lease_case_id IS NOT NULL;
CREATE INDEX cases_case_kind_unit ON org.cases (org_id, case_kind, rental_unit_id)
  WHERE rental_unit_id IS NOT NULL;
