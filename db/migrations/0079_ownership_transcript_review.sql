-- 上傳謄本，平台在審核台核對所有權（MIL-201，ADR-0026 決議 1、2、6 到 9，ADR-0028 決議 3、4）。
-- 由 runner 以 app_owner 執行。編號固定 0079：0077 是 MIL-195，0078 是 MIL-89。
--
-- 1. 審核台項目種類：出租權源（leasing_authority）、通過核對後的修正建號（anchor_rekey）。
-- 2. 兩張組織表：所有權節點 org.ownership_nodes、謄本送件 org.ownership_submissions。
-- 3. 兩張只經函式存取的表：判定紀錄 registry.ownership_decisions、已驗證的鍵 registry.verified_ownership_keys。
-- 4. 函式：送件、判定、讀取原檔、營運者看項目標頭、有效鍵的讀取，以及審核台佇列多列兩種項目。
-- 5. 補建號函式：核對中不能修正，通過核對後改送審核台。
--
-- 判斷重點：這個關係是誰能建立的。
--   節點與送件只由「自己有物件指向該物件」的組織建立。判定只由平台營運者建立，判定人從交易脈絡取，呼叫者不能傳入。
--   登錄的一方讀得到自己的節點與送件，讀不到原檔的 key 與 SHA-256。原檔只經 org.read_ownership_file 讀，函式同交易寫稽核事件。
--   別的組織有沒有已驗證的節點，只有 decide_ownership_check 在資料庫內讀，結果只存審核台項目，登錄的一方看不到。
--
-- 這份檔建立的函式，例外訊息與註解一律稱「物件」。

-- 1. 審核台項目種類 -----------------------------------------------------------------
-- leasing_authority：登錄的一方送出謄本，等平台營運者核對。subject 是所有權節點。
--   payload：claimant_org_id、submission_id、claimed_key（送件當下的鍵，給營運者與判定函式用）、held（有衝突而停住）。
-- anchor_rekey：通過核對的物件要修正建號。subject 是物件。payload：claimant_org_id、claimed_key（想改成的鍵）。
ALTER TABLE registry.review_items DROP CONSTRAINT review_items_type_check;
ALTER TABLE registry.review_items ADD CONSTRAINT review_items_type_check CHECK (type IN (
  'license', 'certificate', 'employment', 'consent',
  'entity_recheck', 'employment_recheck', 'entity_claim',
  'anchor_collision', 'anchor_collision_limit',
  'leasing_authority', 'anchor_rekey'));

CREATE UNIQUE INDEX review_items_one_open_leasing_authority ON registry.review_items (subject_id)
  WHERE status = 'open' AND type = 'leasing_authority';
CREATE UNIQUE INDEX review_items_one_open_rekey ON registry.review_items (subject_id)
  WHERE status = 'open' AND type = 'anchor_rekey';

-- 2. 平台營運者的檢查 ---------------------------------------------------------------
-- assert_operator() 要求 app.org_id 是平台組織。核對資料在登錄的一方的組織，營運者以 operator 脈絡進入該組織
-- （app.org_id 是目標組織，ADR-0026 決議 7），所以這裡只檢查 app.operator_id 是平台組織的成員。
-- 與 assert_operator 相同的信任模型：偽造要知道營運者的使用者 ID。
-- 誰能呼叫：只有其他定義者函式。app_rw 與 PUBLIC 沒有 EXECUTE。回傳營運者的使用者 ID。
CREATE FUNCTION registry.assert_platform_operator() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_op text := nullif(current_setting('app.operator_id', true), '');
BEGIN
  IF v_op IS NULL OR NOT EXISTS (
    SELECT 1 FROM control.org_memberships m JOIN control.orgs o ON o.id = m.org_id
     WHERE m.user_id = v_op AND o.kind = 'platform'
  ) THEN
    RAISE EXCEPTION '只有平台營運者能執行這個動作' USING ERRCODE = '42501';
  END IF;
  RETURN v_op;
END
$$;

REVOKE ALL ON FUNCTION registry.assert_platform_operator() FROM PUBLIC;

-- 呼叫者組織看到的物件鍵：撞到別的組織時是呼叫者宣稱的鍵，否則是物件自己的鍵（與 get_anchors_for_units 相同）。
-- 誰能呼叫：只有其他定義者函式。只讀 p_org 自己提出的撞號項目。
CREATE FUNCTION registry.effective_anchor_key(p_anchor_id text, p_org text)
RETURNS TABLE (city_code text, town_code text, section_code text, building_no text, sub_no text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
  SELECT coalesce(c.ck ->> 'city_code', a.city_code),
         coalesce(c.ck ->> 'town_code', a.town_code),
         coalesce(c.ck ->> 'section_code', a.section_code),
         coalesce(c.ck ->> 'building_no', a.building_no),
         coalesce(c.ck ->> 'sub_no', a.sub_no)
    FROM registry.anchors a
    LEFT JOIN LATERAL (
      SELECT r.payload -> 'claimed_key' AS ck
        FROM registry.review_items r
       WHERE r.type = 'anchor_collision' AND r.status = 'open' AND r.subject_id = a.id
         AND r.payload ->> 'claimant_org_id' = p_org
       ORDER BY r.created_at DESC
       LIMIT 1
    ) c ON true
   WHERE a.id = p_anchor_id
$$;

REVOKE ALL ON FUNCTION registry.effective_anchor_key(text, text) FROM PUBLIC;

-- 3. org.ownership_nodes：所有權節點 ---------------------------------------------------
-- 一個組織對一個物件（錨點）同一時間只有一個有效的節點（待驗證或已驗證，失敗的節點補件後回到待驗證）。
-- 狀態與轉移依 ADR-0026 決議 2。核對結果（兩項比對、遮罩的登記名義人、取得核對的時間）存在節點上，
-- 未遮罩的姓名與證號不落在這張表。
-- 權限：app_rw 只能讀與新增，新增只能是待驗證。轉移只由下面的定義者函式執行（擁有者 app_owner）。
CREATE TABLE org.ownership_nodes (
  id                    text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id                text NOT NULL REFERENCES control.orgs (id),
  -- org 到 registry 的外鍵：app_rw 沒有 registry 權限也能寫入有效 ID（同 org.properties.rental_unit_id）
  anchor_id             text NOT NULL REFERENCES registry.anchors (id),
  status                text NOT NULL DEFAULT 'pending_verification'
                          CHECK (status IN ('pending_verification', 'verified', 'failed', 'lapsed')),
  current_submission_id text,
  key_match             boolean,
  holder_match          boolean,
  -- 謄本上已遮罩的登記名義人，營運者照謄本原樣填。審核台表單擋下含證號的值
  holder_masked         text CHECK (holder_masked IS NULL OR (btrim(holder_masked) <> '' AND length(holder_masked) <= 40)),
  checked_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  status_changed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  -- 結果欄位與狀態一致：待驗證沒有結果，已驗證兩項都相符，驗證失敗至少一項不符
  CONSTRAINT ownership_nodes_result_by_status CHECK (
    CASE status
      WHEN 'pending_verification' THEN key_match IS NULL AND holder_match IS NULL AND holder_masked IS NULL AND checked_at IS NULL
      WHEN 'verified' THEN key_match IS TRUE AND holder_match IS TRUE AND holder_masked IS NOT NULL AND checked_at IS NOT NULL
      WHEN 'failed' THEN key_match IS NOT NULL AND holder_match IS NOT NULL AND NOT (key_match AND holder_match)
                         AND holder_masked IS NOT NULL AND checked_at IS NOT NULL
      ELSE true
    END)
);

-- 同一個組織對同一個物件，同時只有一個未失效的節點。唯一鍵含 org_id，不會洩漏別的組織有節點
CREATE UNIQUE INDEX ownership_nodes_one_active ON org.ownership_nodes (org_id, anchor_id) WHERE status <> 'lapsed';

REVOKE ALL ON org.ownership_nodes FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON org.ownership_nodes FROM app_rw;

ALTER TABLE org.ownership_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.ownership_nodes FORCE  ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.ownership_nodes
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- 轉移表與 src/lib/ownership/status.ts 相同。身分不得修改。新增只能是待驗證（含 app_rw 直接新增）
CREATE FUNCTION org.ownership_nodes_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_verification' THEN
      RAISE EXCEPTION '所有權節點新增時必須是待驗證';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.anchor_id <> OLD.anchor_id THEN
    RAISE EXCEPTION '所有權節點的 id、org_id 與 anchor_id 不得修改';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (
    ('pending_verification', 'verified'), ('pending_verification', 'failed'), ('pending_verification', 'lapsed'),
    ('verified', 'lapsed'), ('failed', 'pending_verification'), ('failed', 'lapsed')
  ) THEN
    RAISE EXCEPTION '所有權節點不能從 % 轉成 %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ownership_nodes_guard BEFORE INSERT OR UPDATE ON org.ownership_nodes
  FOR EACH ROW EXECUTE FUNCTION org.ownership_nodes_guard();

-- 4. org.ownership_submissions：謄本送件 -----------------------------------------------
-- 只增不改。每次送出（含補件）一列。claimed_owner_name 是使用者自己填的主張，不是謄本上的姓名。
-- 原檔的 key 與 SHA-256 不給 app_rw 讀：只能經 org.read_ownership_file，函式同交易寫稽核事件。
-- trust_*：謄本顯示信託登記時，使用者補的四項資料（ADR-0026 決議 1）。
CREATE TABLE org.ownership_submissions (
  id                        text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id                    text NOT NULL REFERENCES control.orgs (id),
  node_id                   text NOT NULL,
  seq                       integer NOT NULL CHECK (seq >= 1),
  claimed_owner_name        text NOT NULL CHECK (btrim(claimed_owner_name) <> '' AND length(claimed_owner_name) <= 100),
  acquired_at               timestamptz NOT NULL,
  -- 送件當下使用者看到的鍵。營運者拿它與謄本比對
  city_code                 text NOT NULL CHECK (city_code ~ '^[A-Z]$'),
  town_code                 text NOT NULL CHECK (town_code ~ '^[0-9]{2}$'),
  section_code              text NOT NULL CHECK (section_code ~ '^[0-9]{4}$'),
  building_no               text NOT NULL CHECK (building_no ~ '^[0-9]{5}$'),
  sub_no                    text NOT NULL CHECK (sub_no ~ '^[0-9]{3}$'),
  has_trust                 boolean NOT NULL DEFAULT false,
  trust_registered_owner    text,
  trust_related_parties     text,
  trust_registration_status text,
  trust_lease_clause        text,
  object_key                text NOT NULL,
  sha256                    text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size                 bigint NOT NULL CHECK (byte_size >= 0),
  content_type              text NOT NULL CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  file_name                 text NOT NULL CHECK (btrim(file_name) <> ''),
  uploaded_by               text NOT NULL CHECK (uploaded_by ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  submitted_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, node_id, seq),
  FOREIGN KEY (org_id, node_id) REFERENCES org.ownership_nodes (org_id, id),
  -- key 以 org/<org_id>/ 開頭：組織前綴由資料庫保證（同 org.sign_task_files）
  CONSTRAINT ownership_submissions_key_has_org CHECK (starts_with(object_key, 'org/' || org_id || '/')),
  -- 信託：有信託登記時四項都有值，沒有時四項都是空
  CONSTRAINT ownership_submissions_trust_complete CHECK (
    CASE WHEN has_trust THEN
      btrim(coalesce(trust_registered_owner, '')) <> '' AND btrim(coalesce(trust_related_parties, '')) <> ''
      AND btrim(coalesce(trust_registration_status, '')) <> '' AND btrim(coalesce(trust_lease_clause, '')) <> ''
    ELSE
      trust_registered_owner IS NULL AND trust_related_parties IS NULL
      AND trust_registration_status IS NULL AND trust_lease_clause IS NULL
    END)
);

REVOKE ALL ON org.ownership_submissions FROM PUBLIC, app_rw;
GRANT INSERT ON org.ownership_submissions TO app_rw;
GRANT SELECT (
  id, org_id, node_id, seq, claimed_owner_name, acquired_at, city_code, town_code, section_code, building_no, sub_no,
  has_trust, trust_registered_owner, trust_related_parties, trust_registration_status, trust_lease_clause,
  byte_size, content_type, file_name, uploaded_by, submitted_at
) ON org.ownership_submissions TO app_rw;

ALTER TABLE org.ownership_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.ownership_submissions FORCE  ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.ownership_submissions
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

-- 只增不改：擋下 UPDATE、DELETE、TRUNCATE（沿用 org.forbid_consent_change 的做法）
CREATE FUNCTION org.forbid_ownership_submission_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '謄本送件只增不改：不得對 % 執行 %', TG_TABLE_NAME, TG_OP;
END
$$;

CREATE TRIGGER ownership_submissions_no_update_delete BEFORE UPDATE OR DELETE ON org.ownership_submissions
  FOR EACH ROW EXECUTE FUNCTION org.forbid_ownership_submission_change();
CREATE TRIGGER ownership_submissions_no_truncate BEFORE TRUNCATE ON org.ownership_submissions
  FOR EACH STATEMENT EXECUTE FUNCTION org.forbid_ownership_submission_change();

-- 5. registry.ownership_decisions：判定紀錄 ---------------------------------------------
-- 平台內部的紀錄，登錄的一方讀不到。每次判定一列，只增不改。
-- outcome：verified、failed，或 held（兩項都相符，但別的組織對同一個鍵已有已驗證的節點，項目停在待處理）。
-- held 只存這裡，不存組織表，登錄的一方看不到任何差別（ADR-0028 決議 4）。
-- decided_by 來自交易脈絡的營運者，呼叫者不能傳入。
CREATE TABLE registry.ownership_decisions (
  id            text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  item_id       text NOT NULL,
  org_id        text NOT NULL,
  node_id       text NOT NULL,
  submission_id text NOT NULL,
  key_match     boolean NOT NULL,
  holder_match  boolean NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('verified', 'failed', 'held')),
  holder_masked text NOT NULL,
  reason        text NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 500),
  decided_by    text NOT NULL,
  decided_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ownership_decisions_by_node ON registry.ownership_decisions (node_id, decided_at);
REVOKE ALL ON registry.ownership_decisions FROM PUBLIC, app_rw;

CREATE FUNCTION registry.forbid_ownership_decision_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '判定紀錄只增不改：不得對 % 執行 %', TG_TABLE_NAME, TG_OP;
END
$$;

CREATE TRIGGER ownership_decisions_no_update_delete BEFORE UPDATE OR DELETE ON registry.ownership_decisions
  FOR EACH ROW EXECUTE FUNCTION registry.forbid_ownership_decision_change();
CREATE TRIGGER ownership_decisions_no_truncate BEFORE TRUNCATE ON registry.ownership_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION registry.forbid_ownership_decision_change();

-- 6. registry.verified_ownership_keys：已驗證節點的鍵 -------------------------------------
-- 讓判定函式不穿過組織 RLS 就能問「別的組織對這個鍵是否已有已驗證的節點」。
-- 判定函式在節點轉已驗證時寫入。節點失效時的刪除屬於之後的票（沒有失效的入口）。
CREATE TABLE registry.verified_ownership_keys (
  node_id      text PRIMARY KEY,
  org_id       text NOT NULL,
  anchor_id    text NOT NULL,
  city_code    text NOT NULL,
  town_code    text NOT NULL,
  section_code text NOT NULL,
  building_no  text NOT NULL,
  sub_no       text NOT NULL,
  verified_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verified_ownership_keys_by_key
  ON registry.verified_ownership_keys (city_code, town_code, section_code, building_no, sub_no);
REVOKE ALL ON registry.verified_ownership_keys FROM PUBLIC, app_rw;

-- 7. 送出謄本 -------------------------------------------------------------------------
-- 誰能呼叫：app_rw，在組織脈絡內，而且有 app.party_id（上傳者）。營運者脈絡不能呼叫。
-- 呼叫者組織必須有物件指向 p_anchor_id：別的組織的物件與不存在的物件，錯誤完全相同（P0002）。
-- 做什麼：建立節點（沒有未失效的節點時）或讓驗證失敗的節點回到待驗證，寫入送件，排一張審核台項目。
-- 回傳一列 (outcome, node_id, submission_id, status)：
--   submitted        送出成功。
--   already_pending  這個物件已有待核對的送件，什麼都沒寫。
--   already_verified 這個物件已通過核對，什麼都沒寫。
-- 回傳值只有呼叫者自己組織的 ID 與狀態，不含別的組織的任何資料。鍵有沒有與別的組織重複，這裡看不出來。
-- 同意個資告知由應用程式檢查（recordConsent 的紀錄在 TypeScript 側）。
CREATE FUNCTION registry.submit_ownership_transcript(
  p_anchor_id     text,
  p_node_id       text,
  p_submission_id text,
  p_item_id       text,
  p_claimed_owner text,
  p_acquired_at   timestamptz,
  p_has_trust     boolean,
  p_trust_owner   text,
  p_trust_parties text,
  p_trust_status  text,
  p_trust_clause  text,
  p_object_key    text,
  p_sha256        text,
  p_byte_size     bigint,
  p_content_type  text,
  p_file_name     text
)
RETURNS TABLE (outcome text, node_id text, submission_id text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org     text := nullif(current_setting('app.org_id', true), '');
  v_party   text := nullif(current_setting('app.party_id', true), '');
  v_astatus text;
  v_key     record;
  v_node    org.ownership_nodes;
  v_seq     integer;
BEGIN
  IF v_org IS NULL OR v_party IS NULL OR nullif(current_setting('app.operator_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'registry.submit_ownership_transcript 必須由組織成員呼叫' USING ERRCODE = '42501';
  END IF;
  IF p_node_id IS NULL OR p_submission_id IS NULL OR p_item_id IS NULL THEN
    RAISE EXCEPTION '節點、送件與審核單號必須由呼叫端提供' USING ERRCODE = '22023';
  END IF;

  -- 鎖住物件，同時確認呼叫者組織有物件指向它（org.properties 的 RLS 在這裡仍然生效）。同一個物件的送件在這裡排隊
  SELECT a.status INTO v_astatus
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
  IF v_astatus NOT IN ('pending_verification', 'keyed') THEN
    RAISE EXCEPTION '物件目前不能送出謄本' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_key FROM registry.effective_anchor_key(p_anchor_id, v_org);
  IF v_key.building_no IS NULL THEN
    RAISE EXCEPTION '物件還沒有建號，請先填建號' USING ERRCODE = '22023';
  END IF;
  IF btrim(coalesce(p_claimed_owner, '')) = '' OR p_acquired_at IS NULL OR p_acquired_at > now() THEN
    RAISE EXCEPTION '所有權人不得為空，取得時間不得晚於現在' USING ERRCODE = '22023';
  END IF;

  SELECT n.* INTO v_node FROM org.ownership_nodes n WHERE n.anchor_id = p_anchor_id AND n.status <> 'lapsed' FOR UPDATE;
  IF FOUND THEN
    IF v_node.status = 'pending_verification' THEN
      RETURN QUERY SELECT 'already_pending'::text, v_node.id, NULL::text, v_node.status;
      RETURN;
    ELSIF v_node.status = 'verified' THEN
      RETURN QUERY SELECT 'already_verified'::text, v_node.id, NULL::text, v_node.status;
      RETURN;
    END IF;
  ELSE
    INSERT INTO org.ownership_nodes (id, org_id, anchor_id) VALUES (p_node_id, v_org, p_anchor_id);
    v_node.id := p_node_id;
  END IF;

  SELECT coalesce(max(s.seq), 0) + 1 INTO v_seq FROM org.ownership_submissions s WHERE s.node_id = v_node.id;
  INSERT INTO org.ownership_submissions (
    id, org_id, node_id, seq, claimed_owner_name, acquired_at,
    city_code, town_code, section_code, building_no, sub_no,
    has_trust, trust_registered_owner, trust_related_parties, trust_registration_status, trust_lease_clause,
    object_key, sha256, byte_size, content_type, file_name, uploaded_by
  ) VALUES (
    p_submission_id, v_org, v_node.id, v_seq, btrim(p_claimed_owner), p_acquired_at,
    v_key.city_code, v_key.town_code, v_key.section_code, v_key.building_no, v_key.sub_no,
    coalesce(p_has_trust, false),
    CASE WHEN p_has_trust THEN btrim(p_trust_owner) END, CASE WHEN p_has_trust THEN btrim(p_trust_parties) END,
    CASE WHEN p_has_trust THEN btrim(p_trust_status) END, CASE WHEN p_has_trust THEN btrim(p_trust_clause) END,
    p_object_key, p_sha256, p_byte_size, p_content_type, p_file_name, v_party);

  -- 補件：驗證失敗的節點回到待驗證，上一次的結果清掉
  UPDATE org.ownership_nodes n
     SET status = 'pending_verification', current_submission_id = p_submission_id,
         key_match = NULL, holder_match = NULL, holder_masked = NULL, checked_at = NULL,
         updated_at = now(), status_changed_at = CASE WHEN n.status <> 'pending_verification' THEN now() ELSE n.status_changed_at END
   WHERE n.id = v_node.id;

  -- 同一個節點先前待處理的項目被這一張取代（正常情況不存在，因為補件前節點已判定）
  UPDATE registry.review_items r
     SET status = 'resolved', resolved_at = now(), resolution = 'superseded'
   WHERE r.type = 'leasing_authority' AND r.subject_id = v_node.id AND r.status = 'open';
  INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
  VALUES (
    p_item_id, 'leasing_authority', 'ownership_node', v_node.id,
    jsonb_build_object(
      'claimant_org_id', v_org,
      'submission_id', p_submission_id,
      'claimed_key', jsonb_build_object(
        'city_code', v_key.city_code, 'town_code', v_key.town_code, 'section_code', v_key.section_code,
        'building_no', v_key.building_no, 'sub_no', v_key.sub_no)));

  RETURN QUERY SELECT 'submitted'::text, v_node.id, p_submission_id, 'pending_verification'::text;
END
$$;

REVOKE ALL ON FUNCTION registry.submit_ownership_transcript(
  text, text, text, text, text, timestamptz, boolean, text, text, text, text, text, text, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.submit_ownership_transcript(
  text, text, text, text, text, timestamptz, boolean, text, text, text, text, text, text, bigint, text, text) TO app_rw;

-- 8. 判定 -----------------------------------------------------------------------------
-- 誰能呼叫：app_rw，在 operator 脈絡內。app.operator_id 必須是平台組織的成員，app.org_id 必須是項目的登錄方組織
-- （ADR-0026 決議 7：營運者以目標組織的 operator 脈絡讀寫，withTx 同交易已寫存取紀錄）。
-- 判定人是 app.operator_id，呼叫者不能傳入。時間是資料庫的 now()。
-- 做什麼：
--   兩項都相符，而且別的組織對同一個鍵沒有已驗證的節點：節點轉已驗證，項目結案（match）。
--   兩項都相符，但別的組織對同一個鍵已有已驗證的節點：項目停在待處理（held），節點維持待驗證，登錄的一方看到的狀態不變。
--     判定記在判定紀錄，不存在組織表。決定的流程由下一張票做。
--   任一項不符：節點轉驗證失敗，項目結案（mismatch）。
-- 回傳一列 (outcome, node_id, property_id, status)：outcome 是 verified、failed、held、not_found、already_resolved。
--   property_id 是登錄的一方的一個物件 ID，給站內通知的連結用。held 與 not_found 時是 NULL。
-- 回傳值與判定紀錄都不含別的組織的資料。held 的原因只有營運者知道（項目 payload.held）。
CREATE FUNCTION registry.decide_ownership_check(
  p_item_id     text,
  p_key_match   boolean,
  p_holder_match boolean,
  p_holder_masked text,
  p_reason      text,
  p_decision_id text
)
RETURNS TABLE (outcome text, node_id text, property_id text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_op       text := registry.assert_platform_operator();
  v_org      text := nullif(current_setting('app.org_id', true), '');
  v_item     registry.review_items;
  v_node     org.ownership_nodes;
  v_sub      org.ownership_submissions;
  v_conflict boolean;
  v_outcome  text;
  v_property text;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'registry.decide_ownership_check 必須在組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF p_key_match IS NULL OR p_holder_match IS NULL OR p_decision_id IS NULL
     OR btrim(coalesce(p_holder_masked, '')) = '' OR length(p_holder_masked) > 40
     OR btrim(coalesce(p_reason, '')) = '' OR length(p_reason) > 500 THEN
    RAISE EXCEPTION '判定需要兩項比對的結果、遮罩的登記名義人與理由' USING ERRCODE = '22023';
  END IF;

  SELECT r.* INTO v_item FROM registry.review_items r WHERE r.id = p_item_id AND r.type = 'leasing_authority' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF v_item.payload ->> 'claimant_org_id' <> v_org THEN
    RAISE EXCEPTION '審核項目不屬於目前的組織' USING ERRCODE = '42501';
  END IF;
  IF v_item.status <> 'open' THEN
    RETURN QUERY SELECT 'already_resolved'::text, v_item.subject_id, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT n.* INTO v_node FROM org.ownership_nodes n WHERE n.id = v_item.subject_id FOR UPDATE;
  IF NOT FOUND OR v_node.status <> 'pending_verification' THEN
    RAISE EXCEPTION '所有權節點不在待驗證狀態' USING ERRCODE = '55000';
  END IF;
  SELECT s.* INTO v_sub FROM org.ownership_submissions s WHERE s.id = v_item.payload ->> 'submission_id';
  IF NOT FOUND THEN
    RAISE EXCEPTION '找不到審核項目的送件' USING ERRCODE = 'P0002';
  END IF;

  IF p_key_match AND p_holder_match THEN
    SELECT EXISTS (
      SELECT 1 FROM registry.verified_ownership_keys v
       WHERE v.org_id <> v_org
         AND v.city_code = v_sub.city_code AND v.town_code = v_sub.town_code AND v.section_code = v_sub.section_code
         AND v.building_no = v_sub.building_no AND v.sub_no = v_sub.sub_no
    ) INTO v_conflict;
  ELSE
    v_conflict := false;
  END IF;

  v_outcome := CASE WHEN v_conflict THEN 'held' WHEN p_key_match AND p_holder_match THEN 'verified' ELSE 'failed' END;

  INSERT INTO registry.ownership_decisions (
    id, item_id, org_id, node_id, submission_id, key_match, holder_match, outcome, holder_masked, reason, decided_by)
  VALUES (p_decision_id, p_item_id, v_org, v_node.id, v_sub.id, p_key_match, p_holder_match, v_outcome,
          btrim(p_holder_masked), btrim(p_reason), v_op);

  IF v_outcome = 'held' THEN
    UPDATE registry.review_items r
       SET payload = r.payload || jsonb_build_object('held', true, 'held_at', now())
     WHERE r.id = p_item_id;
    RETURN QUERY SELECT 'held'::text, v_node.id, NULL::text, v_node.status;
    RETURN;
  END IF;

  UPDATE org.ownership_nodes n
     SET status = CASE WHEN v_outcome = 'verified' THEN 'verified' ELSE 'failed' END,
         key_match = p_key_match, holder_match = p_holder_match, holder_masked = btrim(p_holder_masked),
         checked_at = now(), updated_at = now(), status_changed_at = now()
   WHERE n.id = v_node.id;

  IF v_outcome = 'verified' THEN
    INSERT INTO registry.verified_ownership_keys (node_id, org_id, anchor_id, city_code, town_code, section_code, building_no, sub_no)
    VALUES (v_node.id, v_org, v_node.anchor_id, v_sub.city_code, v_sub.town_code, v_sub.section_code, v_sub.building_no, v_sub.sub_no);
  END IF;

  UPDATE registry.review_items r
     SET status = 'resolved', resolved_at = now(), resolved_by = v_op,
         resolution = CASE WHEN v_outcome = 'verified' THEN 'match' ELSE 'mismatch' END
   WHERE r.id = p_item_id;

  SELECT p.id INTO v_property
    FROM registry.rental_units u
    JOIN org.properties p ON p.rental_unit_id = u.id
   WHERE u.anchor_id = v_node.anchor_id
   ORDER BY (p.archived_at IS NOT NULL), u.suffix, p.id
   LIMIT 1;

  RETURN QUERY SELECT v_outcome, v_node.id, v_property, v_outcome;
END
$$;

REVOKE ALL ON FUNCTION registry.decide_ownership_check(text, boolean, boolean, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.decide_ownership_check(text, boolean, boolean, text, text, text) TO app_rw;

-- 9. 營運者看審核項目的標頭 ---------------------------------------------------------------
-- 誰能呼叫：app_rw，且必須是平台營運者脈絡（assert_operator：app.org_id 是平台組織）。
-- 回傳：項目、登錄的一方的組織 ID 與名稱、送件當下的鍵與段名、是否停住。營運者拿組織 ID 開 operator 脈絡讀送件。
-- 項目不存在或不是出租權源、修正建號項目時回 NULL。
CREATE FUNCTION registry.ownership_review_item(p_item_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
DECLARE
  v_item registry.review_items;
BEGIN
  PERFORM registry.assert_operator();
  SELECT r.* INTO v_item FROM registry.review_items r WHERE r.id = p_item_id AND r.type IN ('leasing_authority', 'anchor_rekey');
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'id', v_item.id, 'type', v_item.type, 'status', v_item.status, 'resolution', v_item.resolution,
    'subject_id', v_item.subject_id, 'created_at', v_item.created_at, 'resolved_at', v_item.resolved_at,
    'claimant_org_id', v_item.payload ->> 'claimant_org_id',
    'claimant_org_name', (SELECT o.name FROM control.orgs o WHERE o.id = v_item.payload ->> 'claimant_org_id'),
    'submission_id', v_item.payload ->> 'submission_id',
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
                            AND se.code = v_item.payload #>> '{claimed_key,section_code}'),
    'held', coalesce((v_item.payload ->> 'held')::boolean, false));
END
$$;

REVOKE ALL ON FUNCTION registry.ownership_review_item(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.ownership_review_item(text) TO app_rw;

-- 10. 讀取原檔 ---------------------------------------------------------------------------
-- 誰能呼叫：app_rw。登錄的一方的組織成員（有 app.party_id、沒有 app.operator_id），或平台營運者
-- （app.operator_id 是平台組織的成員，app.org_id 是目標組織）。org.ownership_submissions 的 RLS 在函式內仍然生效，
-- 所以只讀得到 app.org_id 那個組織的送件。別的組織的送件與不存在的送件，結果都是 0 列、沒有稽核事件。
-- 回傳：物件 key、SHA-256、檔案類型與檔名。app_rw 不能直接讀這兩個欄位，這個函式是唯一入口。
-- 同交易寫稽核事件 vault.read（鏈是 app.org_id 的組織，行為者從脈絡取：營運者或組織成員）。先有紀錄才拿得到 key。
-- payload 只放節點 ID 與讀取者種類。
SET LOCAL ROLE audit_owner;
GRANT EXECUTE ON FUNCTION audit.append(text, text, text, jsonb, text, text) TO app_owner;
SET LOCAL ROLE app_owner;

CREATE FUNCTION org.read_ownership_file(p_submission_id text)
RETURNS TABLE (submission_id text, object_key text, sha256 text, content_type text, file_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = org, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org text := nullif(current_setting('app.org_id', true), '');
  v_op  text := nullif(current_setting('app.operator_id', true), '');
  v_sub org.ownership_submissions;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'org.read_ownership_file 必須在組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF v_op IS NOT NULL THEN
    PERFORM registry.assert_platform_operator();
  ELSIF nullif(current_setting('app.party_id', true), '') IS NULL THEN
    RAISE EXCEPTION 'org.read_ownership_file 必須由組織成員或平台營運者呼叫' USING ERRCODE = '42501';
  END IF;

  SELECT s.* INTO v_sub FROM org.ownership_submissions s WHERE s.id = p_submission_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM audit.append('vault.read', 'ownership_submission', v_sub.id,
                       jsonb_build_object('node_id', v_sub.node_id, 'reader', CASE WHEN v_op IS NOT NULL THEN 'operator' ELSE 'member' END));
  RETURN QUERY SELECT v_sub.id, v_sub.object_key, v_sub.sha256, v_sub.content_type, v_sub.file_name;
END
$$;

REVOKE ALL ON FUNCTION org.read_ownership_file(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org.read_ownership_file(text) TO app_rw;

-- 11. 補建號：核對中不能修正，通過核對後改送審核台 --------------------------------------------
-- 與 0076 相同，多兩個分支（簽名、授權與其餘行為不變）：
--   物件有待驗證的節點（文件正在核對）：回 55000，與已合併或停用的物件同一種錯誤。
--     原因：營運者拿送件當下的鍵比對謄本，核對中改鍵會讓比對失去意義。這只取決於呼叫者自己組織的節點，與別的組織無關。
--   物件有已驗證的節點：不改鍵。排一張 anchor_rekey 項目，回 rekey_queued。想改成的鍵與目前的鍵相同時不排項目，回傳相同。
CREATE OR REPLACE FUNCTION registry.assign_anchor_key(
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
  v_cur      record;
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
  -- 文件正在核對：不能修正（org.ownership_nodes 的 RLS 只讓這裡看到呼叫者自己組織的節點）
  IF EXISTS (SELECT 1 FROM org.ownership_nodes n WHERE n.anchor_id = p_anchor_id AND n.status = 'pending_verification') THEN
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

  -- 通過核對的物件：修正建號送審核台，不直接改鍵。想改的鍵不在這裡查有沒有人用，所以不論鍵有沒有重複，結果都一樣
  IF EXISTS (SELECT 1 FROM org.ownership_nodes n WHERE n.anchor_id = p_anchor_id AND n.status = 'verified') THEN
    SELECT * INTO v_cur FROM registry.effective_anchor_key(p_anchor_id, v_org);
    IF NOT (v_cur.city_code IS NOT DISTINCT FROM p_city_code AND v_cur.town_code IS NOT DISTINCT FROM p_town_code
            AND v_cur.section_code IS NOT DISTINCT FROM p_section AND v_cur.building_no IS NOT DISTINCT FROM v_building
            AND v_cur.sub_no IS NOT DISTINCT FROM v_sub) THEN
      UPDATE registry.review_items r
         SET status = 'resolved', resolved_at = now(), resolution = 'superseded'
       WHERE r.type = 'anchor_rekey' AND r.subject_id = p_anchor_id AND r.status = 'open';
      INSERT INTO registry.review_items (id, type, subject_type, subject_id, payload)
      VALUES (
        p_item_id, 'anchor_rekey', 'anchor', p_anchor_id,
        jsonb_build_object(
          'claimant_org_id', v_org,
          'claimed_key', jsonb_build_object(
            'city_code', p_city_code, 'town_code', p_town_code, 'section_code', p_section,
            'building_no', v_building, 'sub_no', v_sub)));
    END IF;
    RETURN QUERY SELECT 'rekey_queued'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- 自己組織先前宣稱過這個鍵（撞到別的組織，鍵只存在審核項目）：與自己持有這個鍵相同，回自己的物件。
  -- 少了這一步，同一個組織登錄同一個鍵兩次，鍵沒人用時第二次回「自己既有的物件」，撞到別的組織時第二次卻照常登錄，
  -- 呼叫者就能用第二次的回應分辨別的組織是否登錄過這個鍵。
  -- 呼叫者自己的審核項目只有自己的組織 ID，所以這裡讀不到別的組織的任何東西。整戶、未封存的優先
  SELECT p.id INTO v_own
    FROM registry.review_items r
    JOIN registry.rental_units u ON u.anchor_id = r.subject_id
    JOIN org.properties p ON p.rental_unit_id = u.id
   WHERE r.type = 'anchor_collision' AND r.status = 'open'
     AND r.payload ->> 'claimant_org_id' = v_org
     AND r.subject_id <> p_anchor_id
     AND r.payload #>> '{claimed_key,city_code}' = p_city_code
     AND r.payload #>> '{claimed_key,town_code}' = p_town_code
     AND r.payload #>> '{claimed_key,section_code}' = p_section
     AND r.payload #>> '{claimed_key,building_no}' = v_building
     AND r.payload #>> '{claimed_key,sub_no}' = v_sub
   ORDER BY (p.archived_at IS NOT NULL), u.suffix, p.id
   LIMIT 1;
  IF v_own IS NOT NULL THEN
    RETURN QUERY SELECT 'own_existing'::text, NULL::text, v_own;
    RETURN;
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

-- 12. 審核台佇列多列兩種項目 ---------------------------------------------------------------
-- 在 0073 的基礎上多列出租權源與修正建號。簽名、授權與 0043、0047、0073 相同，只加 CASE 分支與 JOIN 條件。
-- 摘要只有登錄方組織名稱、送件當下的鍵與段名、是否停住。使用者填的所有權人與謄本內容不進佇列。
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
           WHEN 'leasing_authority' THEN jsonb_build_object(
             'claimant_org_name', oc.name, 'claimed_key', r.payload -> 'claimed_key',
             'city_name', ar.city_name, 'town_name', ar.town_name,
             'section_name', se.name, 'section_sub_name', se.sub_name,
             'held', coalesce((r.payload ->> 'held')::boolean, false))
           WHEN 'anchor_rekey' THEN jsonb_build_object(
             'claimant_org_name', oc.name, 'claimed_key', r.payload -> 'claimed_key',
             'city_name', ar.city_name, 'town_name', ar.town_name,
             'section_name', se.name, 'section_sub_name', se.sub_name)
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
    LEFT JOIN control.orgs oc ON r.type IN ('anchor_collision', 'anchor_collision_limit', 'leasing_authority', 'anchor_rekey')
           AND oc.id = r.payload ->> 'claimant_org_id'
    LEFT JOIN registry.areas ar ON r.type IN ('anchor_collision', 'leasing_authority', 'anchor_rekey')
           AND ar.city_code = r.payload #>> '{claimed_key,city_code}' AND ar.town_code = r.payload #>> '{claimed_key,town_code}'
    LEFT JOIN registry.sections se ON r.type IN ('anchor_collision', 'leasing_authority', 'anchor_rekey')
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
