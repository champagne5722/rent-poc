-- 兩方都通過核對時，由平台營運者決定（MIL-208 資料段，ADR-0028 決議 4，ADR-0025 決議 11）。
-- 由 runner 以 app_owner 執行。編號固定 0085：0086 給 MIL-206。
--
-- 背景：0079 的 decide_ownership_check 發現別的組織對同一個鍵已有已驗證的節點時，把判定記成 held，項目停在待處理，
-- 之後沒有任何處理的路徑。這份檔補上：衝突個案、聯絡紀錄、三種決定、節點失效、兩方並存的合併、同一個鍵的競態保護。
--
-- 安全重點（任何組織都能登錄任何建號並上傳謄本，所以「製造衝突」是呼叫者自己做得到的事）：
--   1. 後來的一方的全部輸出（API 回應、狀態、訊息、可用動作、通知、他自己組織的稽核鏈）
--      在衝突存在與不存在（營運者還沒判定）時必須相同。所以衝突的偵測在平台脈絡的函式
--      registry.precheck_ownership_conflict 完成：held 的路徑不進後來的一方的組織，也就不會在他的鏈寫
--      operator.access 事件。判定函式 decide_ownership_check 仍保留偵測，只處理兩個交易之間的競態。
--   2. 衝突個案、聯絡紀錄只存在 registry 的表與平台組織的稽核鏈，app_rw 沒有任何權限，只經定義者函式讀寫。
--      事件的 payload 不放自由文字（聯絡結果、理由），寫入後刪不掉。
--   3. 三種決定之後，兩方各自收到的通知、各自鏈上的事件，都不含另一方的組織、節點、物件、姓名與遮罩值。
--
-- 函式一覽（誰能呼叫在各函式的註解）：
--   內部（app_rw 沒有 EXECUTE）：holder_masked_acceptable、ownership_key_lock、assert_conflict_notice、
--     lapse_ownership_node、open_ownership_conflict
--   營運者專用（app_rw 有 EXECUTE，函式內檢查平台營運者）：
--     precheck_ownership_conflict、decide_ownership_check（改寫）、ownership_conflict_detail、
--     record_ownership_contact、decide_ownership_conflict、ownership_review_item（改寫，只加欄位）
--   讀取：get_anchors_for_units（改寫，被合併的物件讀存續物件的鍵）
--
-- 這份檔建立的函式，例外訊息與註解一律稱「物件」。

-- 1. 稽核：平台鏈的寫入口 ------------------------------------------------------------
-- 與 audit.append_platform_anchor_collision（0076）相同的做法：audit.append 的鏈由 app.org_id 決定，
-- 營運者在組織脈絡寫不到平台鏈，這裡開一個窄的入口，只給下面的定義者函式使用。
-- 誰能呼叫：只有 app_owner。app_rw 與 PUBLIC 沒有 EXECUTE。
-- 寫什麼：只收三個固定動作。行為者是營運者（p_operator 由呼叫的函式從交易脈絡取得），沒有時是 system。物件是衝突個案。
-- 鎖的順序：先寫組織鏈，最後寫平台鏈（與補建號函式相同）。
SET LOCAL ROLE audit_owner;

GRANT USAGE ON SCHEMA audit TO app_owner;
-- 營運者進入「先前的一方」的組織時，決定函式要在那條鏈補存取紀錄（withTx 只替進入的第一個組織寫）
GRANT EXECUTE ON FUNCTION audit.record_operator_access() TO app_owner;

CREATE FUNCTION audit.append_platform_ownership_conflict(p_action text, p_operator text, p_conflict_id text, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_platform text;
BEGIN
  IF p_action NOT IN ('ownership.conflict.open', 'ownership.conflict.contact', 'ownership.conflict.decide') THEN
    RAISE EXCEPTION '不支援的平台事件：%', p_action;
  END IF;
  SELECT o.id INTO v_platform FROM control.orgs o WHERE o.kind = 'platform';
  IF v_platform IS NULL THEN
    RAISE EXCEPTION '找不到平台組織，無法寫入平台鏈';
  END IF;
  PERFORM audit.write_event(
    v_platform, CASE WHEN p_operator IS NULL THEN 'system' ELSE 'operator' END, p_operator,
    p_action, 'ownership_conflict', p_conflict_id, coalesce(p_payload, '{}'::jsonb));
END
$$;

REVOKE ALL ON FUNCTION audit.append_platform_ownership_conflict(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.append_platform_ownership_conflict(text, text, text, jsonb) TO app_owner;

-- 回到 app_owner（不是 RESET ROLE：runner 用 SET LOCAL ROLE 切成 app_owner，RESET 會回到管理者）
SET LOCAL ROLE app_owner;

-- 2. 衝突個案 ----------------------------------------------------------------------
-- 一個個案連兩個節點：後來的一方（later，送件被停住的項目）與先前的一方（earlier，已通過核對）。
-- id 等於「停住這次判定」的判定紀錄 id（decide_ownership_check 的 p_decision_id），所以不需要新的 ID 參數。
-- 欄位都是 registry 已有的事實：鍵取自項目 payload 的 claimed_key，先前的一方取自 verified_ownership_keys 與它的判定紀錄。
-- 判定時才讀組織表（後來的一方的錨點）。
-- 狀態：open（等營運者決定），decided（已決定，不再改）。
CREATE TABLE registry.ownership_conflicts (
  id                    text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  item_id               text NOT NULL UNIQUE,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'decided')),
  later_org_id          text NOT NULL,
  later_node_id         text NOT NULL,
  later_submission_id   text NOT NULL,
  later_holder_masked   text NOT NULL,
  earlier_org_id        text NOT NULL,
  earlier_node_id       text NOT NULL,
  earlier_anchor_id     text NOT NULL,
  earlier_submission_id text,
  earlier_holder_masked text,
  earlier_verified_at   timestamptz,
  city_code             text NOT NULL,
  town_code             text NOT NULL,
  section_code          text NOT NULL,
  building_no           text NOT NULL,
  sub_no                text NOT NULL,
  decision              text CHECK (decision IN ('later_prevails', 'later_rejected', 'coexist')),
  decision_basis        text CHECK (decision_basis IN ('key_mismatch', 'holder_mismatch', 'both_mismatch')),
  decision_reason       text CHECK (decision_reason IS NULL OR (btrim(decision_reason) <> '' AND length(decision_reason) <= 500)),
  affected_case_count   integer CHECK (affected_case_count IS NULL OR affected_case_count >= 0),
  decided_by            text,
  decided_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (later_org_id <> earlier_org_id),
  CHECK ((status = 'decided') = (decision IS NOT NULL AND decision_reason IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK ((decision = 'later_rejected') = (decision_basis IS NOT NULL))
);
-- 同一個後來的節點同時只有一個未決的個案
CREATE UNIQUE INDEX ownership_conflicts_one_open_per_node ON registry.ownership_conflicts (later_node_id) WHERE status = 'open';
CREATE INDEX ownership_conflicts_by_earlier ON registry.ownership_conflicts (earlier_node_id);
REVOKE ALL ON registry.ownership_conflicts FROM PUBLIC, app_rw;

-- 已決定的個案不再改；不得刪除；識別欄位與事實欄位不得改。
CREATE FUNCTION registry.guard_ownership_conflict() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION '衝突個案不得刪除';
  END IF;
  IF OLD.status = 'decided' THEN
    RAISE EXCEPTION '已決定的衝突個案不得修改';
  END IF;
  IF NEW.id <> OLD.id OR NEW.item_id <> OLD.item_id OR NEW.later_org_id <> OLD.later_org_id OR NEW.later_node_id <> OLD.later_node_id
     OR NEW.earlier_org_id <> OLD.earlier_org_id OR NEW.earlier_node_id <> OLD.earlier_node_id
     OR NEW.building_no <> OLD.building_no OR NEW.sub_no <> OLD.sub_no OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION '衝突個案的識別與事實欄位不得修改';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER ownership_conflicts_guard BEFORE UPDATE OR DELETE ON registry.ownership_conflicts
  FOR EACH ROW EXECUTE FUNCTION registry.guard_ownership_conflict();
CREATE TRIGGER ownership_conflicts_no_truncate BEFORE TRUNCATE ON registry.ownership_conflicts
  FOR EACH STATEMENT EXECUTE FUNCTION registry.guard_ownership_conflict();

-- 3. 聯絡紀錄 ----------------------------------------------------------------------
-- 營運者個別聯絡雙方，每次一列：對象（哪一方）、時間、管道、結果。只增不改。
-- 這張表是唯一存放聯絡文字的地方，不寫進任何一方的組織，稽核事件也不放結果文字。
CREATE TABLE registry.ownership_contacts (
  id           text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  conflict_id  text NOT NULL REFERENCES registry.ownership_conflicts (id),
  target       text NOT NULL CHECK (target IN ('earlier', 'later')),
  channel      text NOT NULL CHECK (channel IN ('phone', 'email', 'other')),
  outcome      text NOT NULL CHECK (btrim(outcome) <> '' AND length(outcome) <= 500),
  contacted_at timestamptz NOT NULL,
  recorded_by  text NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ownership_contacts_by_conflict ON registry.ownership_contacts (conflict_id, contacted_at, id);
REVOKE ALL ON registry.ownership_contacts FROM PUBLIC, app_rw;

CREATE FUNCTION registry.forbid_ownership_contact_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '聯絡紀錄只增不改：不得對 % 執行 %', TG_TABLE_NAME, TG_OP;
END
$$;
CREATE TRIGGER ownership_contacts_no_update_delete BEFORE UPDATE OR DELETE ON registry.ownership_contacts
  FOR EACH ROW EXECUTE FUNCTION registry.forbid_ownership_contact_change();
CREATE TRIGGER ownership_contacts_no_truncate BEFORE TRUNCATE ON registry.ownership_contacts
  FOR EACH STATEMENT EXECUTE FUNCTION registry.forbid_ownership_contact_change();

-- 4. 已驗證的鍵：同一個鍵不得有兩列，除非營運者決定並存 --------------------------------------------
-- coexist_conflict_id 是明確的標記：這一列因為哪一個「並存」的決定而與其他列共存。沒有標記的列，同一個鍵只能有一列。
-- 唯一索引擋同時寫入；觸發器補上索引表達不了的另一半：有標記的列也必須指向一個鍵相同、決定為並存的個案，
-- 而且沒有標記的列寫入時，同一個鍵不得已有別的列。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM registry.verified_ownership_keys
     GROUP BY city_code, town_code, section_code, building_no, sub_no HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '已驗證的鍵有重複的列，必須先由營運者處理後才能套用 0085（同一個鍵只能有一個已驗證的節點）';
  END IF;
END
$$;

ALTER TABLE registry.verified_ownership_keys
  ADD COLUMN coexist_conflict_id text REFERENCES registry.ownership_conflicts (id);

CREATE UNIQUE INDEX verified_ownership_keys_one_per_key
  ON registry.verified_ownership_keys (city_code, town_code, section_code, building_no, sub_no)
  WHERE coexist_conflict_id IS NULL;

CREATE FUNCTION registry.guard_verified_ownership_key() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.node_id <> OLD.node_id OR NEW.org_id <> OLD.org_id OR NEW.anchor_id <> OLD.anchor_id
       OR NEW.city_code <> OLD.city_code OR NEW.town_code <> OLD.town_code OR NEW.section_code <> OLD.section_code
       OR NEW.building_no <> OLD.building_no OR NEW.sub_no <> OLD.sub_no THEN
      RAISE EXCEPTION '已驗證的鍵不得修改身分與鍵';
    END IF;
    IF OLD.coexist_conflict_id IS NOT NULL AND NEW.coexist_conflict_id IS DISTINCT FROM OLD.coexist_conflict_id THEN
      RAISE EXCEPTION '並存的標記不得修改';
    END IF;
  END IF;

  IF NEW.coexist_conflict_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM registry.verified_ownership_keys v
       WHERE v.node_id <> NEW.node_id
         AND v.city_code = NEW.city_code AND v.town_code = NEW.town_code AND v.section_code = NEW.section_code
         AND v.building_no = NEW.building_no AND v.sub_no = NEW.sub_no
    ) THEN
      RAISE EXCEPTION '這個鍵已有其他已驗證的節點，必須有營運者的並存決定' USING ERRCODE = '23505';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM registry.ownership_conflicts c
     WHERE c.id = NEW.coexist_conflict_id AND c.decision = 'coexist'
       AND c.city_code = NEW.city_code AND c.town_code = NEW.town_code AND c.section_code = NEW.section_code
       AND c.building_no = NEW.building_no AND c.sub_no = NEW.sub_no
  ) THEN
    RAISE EXCEPTION '並存的標記必須指向鍵相同、決定為並存的衝突個案' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER verified_ownership_keys_guard BEFORE INSERT OR UPDATE ON registry.verified_ownership_keys
  FOR EACH ROW EXECUTE FUNCTION registry.guard_verified_ownership_key();

-- 5. 內部函式 ----------------------------------------------------------------------

-- 遮罩的登記名義人是否可收。規則與 src/lib/ownership/forms.ts 的 validateCheckForm 相同：
-- 去掉前後空白後不得為空、不得超過 40 字、不得含控制字元、不得含身分證字號（1 個英文字母、1 或 2、8 位數字）或 6 位以上連續數字。
-- 兩邊的對照測試在 ownership-conflict.test.ts。
-- 誰能呼叫：只有其他函式（app_rw 沒有 EXECUTE）。
CREATE FUNCTION registry.holder_masked_acceptable(p_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_value IS NOT NULL
     AND btrim(p_value) <> ''
     AND char_length(btrim(p_value)) <= 40
     AND p_value !~ '[\x01-\x1f\x7f]'
     AND btrim(p_value) !~ '[A-Za-z][12][0-9]{8}|[0-9]{6,}'
$$;
REVOKE ALL ON FUNCTION registry.holder_masked_acceptable(text) FROM PUBLIC;

-- 同一個鍵的判定、失效與並存互相排隊。鎖到交易結束才放，之後的交易看得到前一個交易提交的列（READ COMMITTED）。
-- 所有寫 verified_ownership_keys 的函式，都必須先呼叫它再讀「別的組織是否已有這個鍵」。
-- 誰能呼叫：只有其他函式。
CREATE FUNCTION registry.ownership_key_lock(p_city text, p_town text, p_section text, p_building text, p_sub text) RETURNS void
LANGUAGE sql VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('registry.ownership_key:' || p_city || '/' || p_town || '/' || p_section || '/' || p_building || '/' || p_sub, 0))
$$;
REVOKE ALL ON FUNCTION registry.ownership_key_lock(text, text, text, text, text) FROM PUBLIC;

-- 站內通知的內容檢查。內容（文字）由 TypeScript 的 messages.ts 提供，這裡只檢查形狀，
-- 讓決定函式寫進組織的通知是固定的三種之一，而不是任意文字。
-- 誰能呼叫：只有其他函式。
CREATE FUNCTION registry.assert_conflict_notice(p_notice jsonb, p_kind text) RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_notice IS NULL OR jsonb_typeof(p_notice) <> 'object'
     OR p_notice ->> 'kind' IS DISTINCT FROM p_kind
     OR coalesce(p_notice ->> 'id', '') !~ '^[0-9A-HJKMNP-TV-Z]{26}$'
     OR btrim(coalesce(p_notice ->> 'title', '')) = '' OR length(p_notice ->> 'title') > 100
     OR btrim(coalesce(p_notice ->> 'body', '')) = '' OR length(p_notice ->> 'body') > 1000 THEN
    RAISE EXCEPTION '通知的內容不合格' USING ERRCODE = '22023';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION registry.assert_conflict_notice(jsonb, text) FROM PUBLIC;

-- 節點失效。清除 registry.verified_ownership_keys 的共用入口：之後的票（刪除物件、移交）也呼叫它。
-- 誰能呼叫：只有其他定義者函式。app.org_id 必須是節點所屬的組織（org.ownership_nodes 的 RLS 仍然生效，別的組織的節點是 0 列）。
-- 做什麼：節點轉已失效（轉移表允許待驗證、已驗證、驗證失敗轉已失效），同交易刪除它在 verified_ownership_keys 的列。
-- 呼叫者必須已呼叫 ownership_key_lock。回傳節點的錨點 ID。
CREATE FUNCTION registry.lapse_ownership_node(p_node_id text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, registry, pg_temp
AS $$
DECLARE
  v_node org.ownership_nodes;
BEGIN
  SELECT n.* INTO v_node FROM org.ownership_nodes n WHERE n.id = p_node_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '找不到所有權節點' USING ERRCODE = 'P0002';
  END IF;
  IF v_node.status = 'lapsed' THEN
    RAISE EXCEPTION '所有權節點已失效' USING ERRCODE = '55000';
  END IF;
  UPDATE org.ownership_nodes n
     SET status = 'lapsed', updated_at = now(), status_changed_at = now()
   WHERE n.id = p_node_id;
  DELETE FROM registry.verified_ownership_keys v WHERE v.node_id = p_node_id;
  RETURN v_node.anchor_id;
END
$$;
REVOKE ALL ON FUNCTION registry.lapse_ownership_node(text) FROM PUBLIC;

-- 建立衝突個案。判定紀錄（outcome = held）、個案、項目的停住旗標、平台鏈事件在這裡一起寫。
-- 誰能呼叫：只有 precheck_ownership_conflict 與 decide_ownership_check。呼叫者必須已呼叫 ownership_key_lock，
-- 並確認先前的一方（p_earlier_node_id）在 verified_ownership_keys 有列、屬於別的組織。
-- 只讀寫 registry 的表，不讀組織表，所以在平台脈絡與登錄方脈絡都能執行。
-- 個案 id 等於判定紀錄 id（p_decision_id）。
CREATE FUNCTION registry.open_ownership_conflict(
  p_item_id        text,
  p_operator       text,
  p_org            text,
  p_node_id        text,
  p_submission_id  text,
  p_decision_id    text,
  p_key_match      boolean,
  p_holder_match   boolean,
  p_holder_masked  text,
  p_reason         text,
  p_earlier_node   text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, registry, pg_temp
AS $$
DECLARE
  v_item     registry.review_items;
  v_earlier  registry.verified_ownership_keys;
  v_prev     record;
  v_key      jsonb;
BEGIN
  SELECT r.* INTO v_item FROM registry.review_items r WHERE r.id = p_item_id;
  SELECT v.* INTO v_earlier FROM registry.verified_ownership_keys v WHERE v.node_id = p_earlier_node AND v.org_id <> p_org;
  IF v_item.id IS NULL OR v_earlier.node_id IS NULL THEN
    RAISE EXCEPTION '建立衝突個案需要項目與別的組織的已驗證節點' USING ERRCODE = '55000';
  END IF;
  v_key := v_item.payload -> 'claimed_key';

  INSERT INTO registry.ownership_decisions (
    id, item_id, org_id, node_id, submission_id, key_match, holder_match, outcome, holder_masked, reason, decided_by)
  VALUES (p_decision_id, p_item_id, p_org, p_node_id, p_submission_id, p_key_match, p_holder_match, 'held',
          btrim(p_holder_masked), btrim(p_reason), p_operator);

  -- 先前的一方通過核對時的判定（遮罩的名義人、送件、時間），存成個案的事實，之後不必再讀
  SELECT d.submission_id, d.holder_masked, d.decided_at INTO v_prev
    FROM registry.ownership_decisions d
   WHERE d.node_id = p_earlier_node AND d.outcome = 'verified'
   ORDER BY d.decided_at DESC, d.id DESC
   LIMIT 1;

  INSERT INTO registry.ownership_conflicts (
    id, item_id, later_org_id, later_node_id, later_submission_id, later_holder_masked,
    earlier_org_id, earlier_node_id, earlier_anchor_id, earlier_submission_id, earlier_holder_masked, earlier_verified_at,
    city_code, town_code, section_code, building_no, sub_no)
  VALUES (
    p_decision_id, p_item_id, p_org, p_node_id, p_submission_id, btrim(p_holder_masked),
    v_earlier.org_id, v_earlier.node_id, v_earlier.anchor_id, v_prev.submission_id, v_prev.holder_masked, v_prev.decided_at,
    v_key ->> 'city_code', v_key ->> 'town_code', v_key ->> 'section_code', v_key ->> 'building_no', v_key ->> 'sub_no');

  UPDATE registry.review_items r
     SET payload = r.payload || jsonb_build_object('held', true, 'held_at', now())
   WHERE r.id = p_item_id;

  PERFORM audit.append_platform_ownership_conflict(
    'ownership.conflict.open', p_operator, p_decision_id,
    jsonb_build_object('item_id', p_item_id, 'later_org_id', p_org, 'earlier_org_id', v_earlier.org_id));
END
$$;
REVOKE ALL ON FUNCTION registry.open_ownership_conflict(text, text, text, text, text, text, boolean, boolean, text, text, text) FROM PUBLIC;

-- 6. 平台脈絡的衝突偵測 ---------------------------------------------------------------
-- 誰能呼叫：app_rw，且必須是平台營運者在平台組織的脈絡（registry.assert_operator：app.org_id 是平台組織）。
-- 為什麼需要它：判定要在登錄方的組織脈絡執行（withTx 在那裡寫 operator.access 事件到登錄方的鏈）。
--   如果衝突在那個交易裡才發現，登錄方的鏈會多一筆「營運者為了判定而進入」的事件，與「營運者還沒判定」不同。
--   所以 TypeScript 先在平台脈絡呼叫這個函式；回 held 就結束，不進登錄方的組織，登錄方的任何輸出都不變。
-- 做什麼：和 decide_ownership_check 相同的輸入檢查。項目已有未決的個案：回 held（不再寫新的判定紀錄）。
--   兩項比對都相符，而且別的組織對同一個鍵已有已驗證的節點：建立個案，回 held。其他情況回 clear，由 decide_ownership_check 處理。
-- 為什麼只讀 registry：項目的 payload 有登錄方組織 ID、送件 ID 與送件當下的鍵，節點 ID 是項目的 subject。
-- 回傳：held 或 clear。不含任何組織的資料。
CREATE FUNCTION registry.precheck_ownership_conflict(
  p_item_id       text,
  p_key_match     boolean,
  p_holder_match  boolean,
  p_holder_masked text,
  p_reason        text,
  p_decision_id   text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, registry, pg_temp
AS $$
DECLARE
  v_op      text := registry.assert_operator();
  v_item    registry.review_items;
  v_org     text;
  v_key     jsonb;
  v_earlier registry.verified_ownership_keys;
BEGIN
  IF p_key_match IS NULL OR p_holder_match IS NULL OR p_decision_id IS NULL
     OR NOT registry.holder_masked_acceptable(p_holder_masked)
     OR btrim(coalesce(p_reason, '')) = '' OR length(p_reason) > 500 THEN
    RAISE EXCEPTION '判定需要兩項比對的結果、遮罩的登記名義人與理由；登記名義人不得含證號' USING ERRCODE = '22023';
  END IF;

  SELECT r.* INTO v_item FROM registry.review_items r WHERE r.id = p_item_id AND r.type = 'leasing_authority' FOR UPDATE;
  IF NOT FOUND OR v_item.status <> 'open' THEN
    RETURN 'clear';
  END IF;
  IF EXISTS (SELECT 1 FROM registry.ownership_conflicts c WHERE c.item_id = p_item_id AND c.status = 'open') THEN
    RETURN 'held';
  END IF;
  IF NOT (p_key_match AND p_holder_match) THEN
    RETURN 'clear';
  END IF;

  v_org := v_item.payload ->> 'claimant_org_id';
  v_key := v_item.payload -> 'claimed_key';
  PERFORM registry.ownership_key_lock(v_key ->> 'city_code', v_key ->> 'town_code', v_key ->> 'section_code', v_key ->> 'building_no', v_key ->> 'sub_no');
  SELECT v.* INTO v_earlier
    FROM registry.verified_ownership_keys v
   WHERE v.org_id <> v_org
     AND v.city_code = v_key ->> 'city_code' AND v.town_code = v_key ->> 'town_code' AND v.section_code = v_key ->> 'section_code'
     AND v.building_no = v_key ->> 'building_no' AND v.sub_no = v_key ->> 'sub_no'
   ORDER BY v.verified_at, v.node_id
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN 'clear';
  END IF;

  PERFORM registry.open_ownership_conflict(
    p_item_id, v_op, v_org, v_item.subject_id, v_item.payload ->> 'submission_id', p_decision_id,
    p_key_match, p_holder_match, p_holder_masked, p_reason, v_earlier.node_id);
  RETURN 'held';
END
$$;
REVOKE ALL ON FUNCTION registry.precheck_ownership_conflict(text, boolean, boolean, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.precheck_ownership_conflict(text, boolean, boolean, text, text, text) TO app_rw;

-- 7. 判定（改寫 0079）----------------------------------------------------------------
-- 簽名、授權與回傳形狀不變。改了三件事：
--   1. 遮罩的登記名義人多一道檢查：含證號的值拒絕（22023），不再只靠表單。
--   2. 兩項都相符時先取「這個鍵」的建議鎖再查別的組織是否已有已驗證的節點，兩個項目同時判定同一個鍵時，
--      後到的看得到先到的結果，不會兩邊都通過。
--   3. 有衝突時建立衝突個案（open_ownership_conflict），不再只在 payload 加旗標。項目已有未決的個案時，
--      不論輸入是什麼都回 held，不重複寫判定紀錄；該項目只能經 decide_ownership_conflict 決定。
-- 誰能呼叫：app_rw，在 operator 脈絡內。app.operator_id 必須是平台組織的成員，app.org_id 必須是項目的登錄方組織。
-- 正常情況下衝突在 precheck_ownership_conflict 就被攔下；這裡的偵測只處理兩個交易之間的競態。
CREATE OR REPLACE FUNCTION registry.decide_ownership_check(
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
  v_earlier  registry.verified_ownership_keys;
  v_conflict boolean := false;
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
  IF NOT registry.holder_masked_acceptable(p_holder_masked) THEN
    RAISE EXCEPTION '登記名義人只填謄本上遮罩後的姓名，不得含證號' USING ERRCODE = '22023';
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

  -- 已有未決的個案：只能經 decide_ownership_conflict 決定
  IF EXISTS (SELECT 1 FROM registry.ownership_conflicts c WHERE c.item_id = p_item_id AND c.status = 'open') THEN
    RETURN QUERY SELECT 'held'::text, v_node.id, NULL::text, v_node.status;
    RETURN;
  END IF;

  IF p_key_match AND p_holder_match THEN
    PERFORM registry.ownership_key_lock(v_sub.city_code, v_sub.town_code, v_sub.section_code, v_sub.building_no, v_sub.sub_no);
    SELECT v.* INTO v_earlier
      FROM registry.verified_ownership_keys v
     WHERE v.org_id <> v_org
       AND v.city_code = v_sub.city_code AND v.town_code = v_sub.town_code AND v.section_code = v_sub.section_code
       AND v.building_no = v_sub.building_no AND v.sub_no = v_sub.sub_no
     ORDER BY v.verified_at, v.node_id
     LIMIT 1;
    v_conflict := FOUND;
  END IF;

  IF v_conflict THEN
    PERFORM registry.open_ownership_conflict(
      p_item_id, v_op, v_org, v_node.id, v_sub.id, p_decision_id, p_key_match, p_holder_match, p_holder_masked, p_reason, v_earlier.node_id);
    RETURN QUERY SELECT 'held'::text, v_node.id, NULL::text, v_node.status;
    RETURN;
  END IF;

  v_outcome := CASE WHEN p_key_match AND p_holder_match THEN 'verified' ELSE 'failed' END;

  INSERT INTO registry.ownership_decisions (
    id, item_id, org_id, node_id, submission_id, key_match, holder_match, outcome, holder_masked, reason, decided_by)
  VALUES (p_decision_id, p_item_id, v_org, v_node.id, v_sub.id, p_key_match, p_holder_match, v_outcome,
          btrim(p_holder_masked), btrim(p_reason), v_op);

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

-- 8. 營運者讀衝突個案 ----------------------------------------------------------------
-- 誰能呼叫：app_rw，且必須是平台營運者在平台組織的脈絡（registry.assert_operator）。
-- 回傳（jsonb）：個案狀態與決定、雙方的組織 ID 與名稱、節點 ID、送件 ID、遮罩的登記名義人、先前一方通過核對的時間、
--   鍵與段名、全部聯絡紀錄。項目沒有個案時回 NULL。
-- 只回判定所需的欄位：不含主張的所有權人、信託資料、檔案的 key 與 SHA-256，也不讀組織表。
--   取得時間與原檔各自經組織脈絡取得（org.read_ownership_file，每次各寫一筆稽核到該組織的鏈）。
CREATE FUNCTION registry.ownership_conflict_detail(p_item_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, registry, pg_temp
AS $$
DECLARE
  v_c registry.ownership_conflicts;
BEGIN
  PERFORM registry.assert_operator();
  SELECT c.* INTO v_c FROM registry.ownership_conflicts c WHERE c.item_id = p_item_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'id', v_c.id, 'item_id', v_c.item_id, 'status', v_c.status, 'created_at', v_c.created_at,
    'decision', v_c.decision, 'decision_basis', v_c.decision_basis, 'decision_reason', v_c.decision_reason,
    'affected_case_count', v_c.affected_case_count, 'decided_by', v_c.decided_by, 'decided_at', v_c.decided_at,
    'claimed_key', jsonb_build_object(
      'city_code', v_c.city_code, 'town_code', v_c.town_code, 'section_code', v_c.section_code,
      'building_no', v_c.building_no, 'sub_no', v_c.sub_no),
    'later', jsonb_build_object(
      'org_id', v_c.later_org_id, 'org_name', (SELECT o.name FROM control.orgs o WHERE o.id = v_c.later_org_id),
      'node_id', v_c.later_node_id, 'submission_id', v_c.later_submission_id, 'holder_masked', v_c.later_holder_masked),
    'earlier', jsonb_build_object(
      'org_id', v_c.earlier_org_id, 'org_name', (SELECT o.name FROM control.orgs o WHERE o.id = v_c.earlier_org_id),
      'node_id', v_c.earlier_node_id, 'submission_id', v_c.earlier_submission_id, 'holder_masked', v_c.earlier_holder_masked,
      'verified_at', v_c.earlier_verified_at),
    'contacts', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', k.id, 'target', k.target, 'channel', k.channel, 'outcome', k.outcome,
               'contacted_at', k.contacted_at, 'recorded_by', k.recorded_by, 'recorded_at', k.recorded_at)
             ORDER BY k.contacted_at, k.id)
        FROM registry.ownership_contacts k WHERE k.conflict_id = v_c.id), '[]'::jsonb));
END
$$;
REVOKE ALL ON FUNCTION registry.ownership_conflict_detail(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.ownership_conflict_detail(text) TO app_rw;

-- 9. 記一筆聯絡 ----------------------------------------------------------------------
-- 誰能呼叫：app_rw，且必須是平台營運者在平台組織的脈絡（registry.assert_operator）。記錄人取自交易脈絡，呼叫者不能傳入。
-- 對象：earlier（先前的一方）或 later（後來的一方）。管道：phone、email、other。結果：500 字以內的文字。
-- 時間：p_contacted_at，空值時是現在；不得晚於現在，不得早於個案建立。
-- 做什麼：寫聯絡紀錄與平台鏈事件 ownership.conflict.contact（payload 只放個案、聯絡編號、對象與管道，不放結果文字）。
--   個案已決定時仍可記錄（決定之後的告知電話）。
-- 回傳一列 (outcome, contact_id)：recorded 或 not_found（項目沒有個案）。
CREATE FUNCTION registry.record_ownership_contact(
  p_item_id      text,
  p_contact_id   text,
  p_target       text,
  p_channel      text,
  p_outcome      text,
  p_contacted_at timestamptz
) RETURNS TABLE (outcome text, contact_id text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_op   text := registry.assert_operator();
  v_c    registry.ownership_conflicts;
  v_when timestamptz := coalesce(p_contacted_at, now());
BEGIN
  IF p_contact_id IS NULL OR p_target NOT IN ('earlier', 'later') OR p_channel NOT IN ('phone', 'email', 'other')
     OR btrim(coalesce(p_outcome, '')) = '' OR length(p_outcome) > 500 THEN
    RAISE EXCEPTION '聯絡紀錄需要對象、管道與 500 字以內的結果' USING ERRCODE = '22023';
  END IF;
  SELECT c.* INTO v_c FROM registry.ownership_conflicts c WHERE c.item_id = p_item_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;
  IF v_when > now() OR v_when < v_c.created_at THEN
    RAISE EXCEPTION '聯絡時間不得晚於現在，也不得早於衝突建立' USING ERRCODE = '22023';
  END IF;

  INSERT INTO registry.ownership_contacts (id, conflict_id, target, channel, outcome, contacted_at, recorded_by)
  VALUES (p_contact_id, v_c.id, p_target, p_channel, btrim(p_outcome), v_when, v_op);

  PERFORM audit.append_platform_ownership_conflict(
    'ownership.conflict.contact', v_op, v_c.id,
    jsonb_build_object('contact_id', p_contact_id, 'target', p_target, 'channel', p_channel));
  RETURN QUERY SELECT 'recorded'::text, p_contact_id;
END
$$;
REVOKE ALL ON FUNCTION registry.record_ownership_contact(text, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.record_ownership_contact(text, text, text, text, text, timestamptz) TO app_rw;

-- 10. 三種決定 ------------------------------------------------------------------------
-- 誰能呼叫：app_rw，在 operator 脈絡內，app.org_id 是「後來的一方」的組織（與 decide_ownership_check 相同：
--   withTx 進入後來的一方，寫一筆 operator.access，工單號與一般判定相同）。app.operator_id 必須是平台組織的成員。
--   個案的後來的一方不是目前的組織時拒絕（42501）。
-- 輸入：
--   p_decision  later_prevails（後來的成立、先前的失效）、later_rejected（後來的不成立）、coexist（兩方並存）。
--   p_basis     只有 later_rejected 要填，key_mismatch、holder_mismatch 或 both_mismatch：後來的節點依它記錄兩項比對，
--               走既有的 failed 路徑與既有的固定訊息，不新增訊息。其他決定必須是空值。
--   p_later_notice / p_earlier_notice  站內通知的 {id, kind, title, body}，由 TypeScript 的 messages.ts 提供。
--               後來的一方：成立與並存是 property.verification_passed，不成立是 property.verification_failed。
--               先前的一方只有 later_prevails 需要，kind 是 property.verification_lapsed，文字不得提另一方。
-- 做什麼（同一個交易，同一個鍵的建議鎖）：
--   all    個案轉已決定，後來的節點照決定轉已驗證或驗證失敗，寫判定紀錄，項目結案（match 或 mismatch），
--          在後來的一方的鏈寫 rental_right.judge，寫站內通知（與一般判定的內容、事件相同）。
--   later_prevails   先前的節點轉已失效，刪它在 verified_ownership_keys 的列（lapse_ownership_node）。
--          為此暫時進入先前的一方的組織，補一筆 operator.access（工單號只含它自己的節點 ID），寫 rental_right.revoke 與通知。
--          先前一方既有的案件與合約不自動取消；回傳進行中的案件數（只回數字）。
--          鍵有多個並存的已驗證節點時不支援（0A000）。
--   coexist  後來的錨點併入先前的錨點（anchors 與整戶單位的 merged_into_id，被合併的 ID 持續有效），
--          兩方的鍵都標記並存，後來一方的撞號項目結案。
-- 回傳一列 (outcome, affected_case_count)：outcome 是決定、not_found（項目沒有個案）或 already_decided。
--   affected_case_count 只有 later_prevails 有值，其餘是 0。
-- 鎖的順序：後來的一方的鏈（withTx）、先前的一方的鏈、平台鏈。
CREATE FUNCTION registry.decide_ownership_conflict(
  p_item_id        text,
  p_decision       text,
  p_reason         text,
  p_basis          text,
  p_decision_id    text,
  p_later_notice   jsonb,
  p_earlier_notice jsonb
) RETURNS TABLE (outcome text, affected_case_count integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_op            text := registry.assert_platform_operator();
  v_org           text := nullif(current_setting('app.org_id', true), '');
  v_ticket        text := coalesce(current_setting('app.ticket_id', true), '');
  v_c             registry.ownership_conflicts;
  v_item          registry.review_items;
  v_node          org.ownership_nodes;
  v_earlier       registry.verified_ownership_keys;
  v_others        integer;
  v_key_match     boolean := true;
  v_holder_match  boolean := true;
  v_cases         integer := 0;
  v_property      text;
  v_e_property    text;
  v_survivor      text;
  v_survivor_unit text;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'registry.decide_ownership_conflict 必須在組織脈絡內呼叫' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('later_prevails', 'later_rejected', 'coexist') OR p_decision_id IS NULL
     OR btrim(coalesce(p_reason, '')) = '' OR length(p_reason) > 500 THEN
    RAISE EXCEPTION '決定需要三種決定之一、決定編號與 500 字以內的理由' USING ERRCODE = '22023';
  END IF;
  IF (p_decision = 'later_rejected') <> (p_basis IS NOT NULL)
     OR (p_basis IS NOT NULL AND p_basis NOT IN ('key_mismatch', 'holder_mismatch', 'both_mismatch')) THEN
    RAISE EXCEPTION '只有後來的不成立需要填不符的項目（key_mismatch、holder_mismatch、both_mismatch）' USING ERRCODE = '22023';
  END IF;
  PERFORM registry.assert_conflict_notice(
    p_later_notice, CASE WHEN p_decision = 'later_rejected' THEN 'property.verification_failed' ELSE 'property.verification_passed' END);
  IF p_decision = 'later_prevails' THEN
    PERFORM registry.assert_conflict_notice(p_earlier_notice, 'property.verification_lapsed');
  ELSIF p_earlier_notice IS NOT NULL THEN
    RAISE EXCEPTION '只有後來的成立需要通知先前的一方' USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO v_c FROM registry.ownership_conflicts c WHERE c.item_id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, 0;
    RETURN;
  END IF;
  IF v_c.later_org_id <> v_org THEN
    RAISE EXCEPTION '審核項目不屬於目前的組織' USING ERRCODE = '42501';
  END IF;
  IF v_c.status <> 'open' THEN
    RETURN QUERY SELECT 'already_decided'::text, 0;
    RETURN;
  END IF;

  PERFORM registry.ownership_key_lock(v_c.city_code, v_c.town_code, v_c.section_code, v_c.building_no, v_c.sub_no);
  SELECT r.* INTO v_item FROM registry.review_items r WHERE r.id = p_item_id AND r.type = 'leasing_authority' AND r.status = 'open' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '審核項目不在待處理狀態' USING ERRCODE = '55000';
  END IF;
  SELECT n.* INTO v_node FROM org.ownership_nodes n WHERE n.id = v_c.later_node_id FOR UPDATE;
  IF NOT FOUND OR v_node.status <> 'pending_verification' THEN
    RAISE EXCEPTION '所有權節點不在待驗證狀態' USING ERRCODE = '55000';
  END IF;

  SELECT v.* INTO v_earlier FROM registry.verified_ownership_keys v WHERE v.node_id = v_c.earlier_node_id;
  IF p_decision = 'coexist' AND NOT FOUND THEN
    RAISE EXCEPTION '先前的一方已不是已驗證，不能並存' USING ERRCODE = '55000';
  END IF;
  IF p_decision = 'later_prevails' THEN
    SELECT count(*) INTO v_others FROM registry.verified_ownership_keys v
     WHERE v.org_id <> v_org
       AND v.city_code = v_c.city_code AND v.town_code = v_c.town_code AND v.section_code = v_c.section_code
       AND v.building_no = v_c.building_no AND v.sub_no = v_c.sub_no;
    IF v_others > 1 THEN
      RAISE EXCEPTION '這個鍵有多個並存的已驗證節點，尚不支援讓後來的成立' USING ERRCODE = '0A000';
    END IF;
  END IF;

  IF p_decision = 'later_rejected' THEN
    v_key_match := p_basis = 'holder_mismatch';
    v_holder_match := p_basis = 'key_mismatch';
  END IF;

  -- 後來的一方：與一般判定相同的寫法
  INSERT INTO registry.ownership_decisions (
    id, item_id, org_id, node_id, submission_id, key_match, holder_match, outcome, holder_masked, reason, decided_by)
  VALUES (p_decision_id, p_item_id, v_org, v_node.id, v_c.later_submission_id, v_key_match, v_holder_match,
          CASE WHEN p_decision = 'later_rejected' THEN 'failed' ELSE 'verified' END,
          v_c.later_holder_masked, btrim(p_reason), v_op);
  UPDATE org.ownership_nodes n
     SET status = CASE WHEN p_decision = 'later_rejected' THEN 'failed' ELSE 'verified' END,
         key_match = v_key_match, holder_match = v_holder_match, holder_masked = v_c.later_holder_masked,
         checked_at = now(), updated_at = now(), status_changed_at = now()
   WHERE n.id = v_node.id;
  UPDATE registry.review_items r
     SET status = 'resolved', resolved_at = now(), resolved_by = v_op,
         resolution = CASE WHEN p_decision = 'later_rejected' THEN 'mismatch' ELSE 'match' END
   WHERE r.id = p_item_id;
  PERFORM audit.append('rental_right.judge', 'ownership_node', v_node.id,
    jsonb_build_object('outcome', CASE WHEN p_decision = 'later_rejected' THEN 'failed' ELSE 'verified' END,
                       'key_match', v_key_match, 'holder_match', v_holder_match));
  SELECT p.id INTO v_property
    FROM registry.rental_units u
    JOIN org.properties p ON p.rental_unit_id = u.id
   WHERE u.anchor_id = v_node.anchor_id
   ORDER BY (p.archived_at IS NOT NULL), u.suffix, p.id
   LIMIT 1;
  INSERT INTO org.notifications (id, org_id, kind, title, body, link_path)
  VALUES (p_later_notice ->> 'id', v_org, p_later_notice ->> 'kind', p_later_notice ->> 'title', p_later_notice ->> 'body',
          CASE WHEN v_property IS NULL THEN NULL ELSE '/properties/' || v_property END);

  -- 先前的一方失效。暫時進入它的組織，補一筆 operator.access（工單號只含它自己的節點 ID，不含這一邊的任何 ID）
  IF p_decision = 'later_prevails' AND v_earlier.node_id IS NOT NULL THEN
    PERFORM set_config('app.org_id', v_earlier.org_id, true);
    PERFORM set_config('app.ticket_id', 'desk:lapse:' || v_earlier.node_id, true);
    PERFORM audit.record_operator_access();

    SELECT count(*)::integer INTO v_cases
      FROM org.cases cs
     WHERE cs.rental_unit_id IN (SELECT u.id FROM registry.rental_units u WHERE u.anchor_id = v_earlier.anchor_id)
       AND cs.state NOT IN ('closed', 'aborted', 'terminated', 'expired');
    PERFORM registry.lapse_ownership_node(v_earlier.node_id);
    PERFORM audit.append('rental_right.revoke', 'ownership_node', v_earlier.node_id, jsonb_build_object('outcome', 'lapsed'));
    SELECT p.id INTO v_e_property
      FROM registry.rental_units u
      JOIN org.properties p ON p.rental_unit_id = u.id
     WHERE u.anchor_id = v_earlier.anchor_id
     ORDER BY (p.archived_at IS NOT NULL), u.suffix, p.id
     LIMIT 1;
    INSERT INTO org.notifications (id, org_id, kind, title, body, link_path)
    VALUES (p_earlier_notice ->> 'id', v_earlier.org_id, p_earlier_notice ->> 'kind', p_earlier_notice ->> 'title', p_earlier_notice ->> 'body',
            CASE WHEN v_e_property IS NULL THEN NULL ELSE '/properties/' || v_e_property END);

    PERFORM set_config('app.org_id', v_org, true);
    PERFORM set_config('app.ticket_id', v_ticket, true);
  END IF;

  -- 個案轉已決定。必須在寫 verified_ownership_keys 的並存標記之前：觸發器要看到「並存」的決定。已決定的個案不再改
  UPDATE registry.ownership_conflicts c
     SET status = 'decided', decision = p_decision, decision_basis = p_basis, decision_reason = btrim(p_reason),
         affected_case_count = v_cases, decided_by = v_op, decided_at = now()
   WHERE c.id = v_c.id;

  IF p_decision = 'later_prevails' THEN
    INSERT INTO registry.verified_ownership_keys (node_id, org_id, anchor_id, city_code, town_code, section_code, building_no, sub_no)
    VALUES (v_node.id, v_org, v_node.anchor_id, v_c.city_code, v_c.town_code, v_c.section_code, v_c.building_no, v_c.sub_no);

  ELSIF p_decision = 'coexist' THEN
    -- 這個鍵上還沒有標記的列（第一次並存時只有先前的一方）標成這次的決定；已在並存群組內的列保持原標記
    UPDATE registry.verified_ownership_keys v SET coexist_conflict_id = v_c.id
     WHERE v.coexist_conflict_id IS NULL
       AND v.city_code = v_c.city_code AND v.town_code = v_c.town_code AND v.section_code = v_c.section_code
       AND v.building_no = v_c.building_no AND v.sub_no = v_c.sub_no;
    INSERT INTO registry.verified_ownership_keys (node_id, org_id, anchor_id, city_code, town_code, section_code, building_no, sub_no, coexist_conflict_id)
    VALUES (v_node.id, v_org, v_node.anchor_id, v_c.city_code, v_c.town_code, v_c.section_code, v_c.building_no, v_c.sub_no, v_c.id);

    -- 後來的錨點併入先前的錨點存續的那一個（先前的錨點本身已被合併時，沿鏈走到最後）。被合併的 ID 持續有效
    WITH RECURSIVE chain (id, merged_into_id, depth) AS (
      SELECT a.id, a.merged_into_id, 0 FROM registry.anchors a WHERE a.id = v_earlier.anchor_id
      UNION ALL
      SELECT n.id, n.merged_into_id, c.depth + 1 FROM chain c JOIN registry.anchors n ON n.id = c.merged_into_id WHERE c.depth < 10
    )
    SELECT ch.id INTO v_survivor FROM chain ch ORDER BY ch.depth DESC LIMIT 1;
    IF v_survivor <> v_node.anchor_id
       AND (SELECT a.merged_into_id FROM registry.anchors a WHERE a.id = v_node.anchor_id) IS NULL THEN
      SELECT u.id INTO v_survivor_unit FROM registry.rental_units u WHERE u.anchor_id = v_survivor AND u.unit_type = 'whole';
      UPDATE registry.anchors a SET status = 'merged', merged_into_id = v_survivor, updated_at = now() WHERE a.id = v_node.anchor_id;
      IF v_survivor_unit IS NOT NULL THEN
        UPDATE registry.rental_units u
           SET status = 'merged', merged_into_id = v_survivor_unit, updated_at = now()
         WHERE u.anchor_id = v_node.anchor_id AND u.unit_type = 'whole' AND u.merged_into_id IS NULL;
      END IF;
    END IF;
    -- 後來一方的撞號項目結案（superseded：被合併取代）：它宣稱的鍵現在由存續的錨點提供
    UPDATE registry.review_items r
       SET status = 'resolved', resolved_at = now(), resolved_by = v_op, resolution = 'superseded'
     WHERE r.type = 'anchor_collision' AND r.subject_id = v_node.anchor_id AND r.status = 'open';
  END IF;

  PERFORM audit.append_platform_ownership_conflict(
    'ownership.conflict.decide', v_op, v_c.id,
    jsonb_build_object('item_id', p_item_id, 'decision', p_decision, 'later_org_id', v_org, 'earlier_org_id', v_c.earlier_org_id,
                       'affected_case_count', v_cases));
  RETURN QUERY SELECT p_decision, v_cases;
END
$$;
REVOKE ALL ON FUNCTION registry.decide_ownership_conflict(text, text, text, text, text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.decide_ownership_conflict(text, text, text, text, text, jsonb, jsonb) TO app_rw;

-- 11. 營運者看審核項目的標頭（改寫 0079，只加欄位）-----------------------------------------------
-- 簽名、授權與既有欄位不變。多兩個欄位：conflict_id 與 conflict_status（項目沒有衝突個案時是 NULL）。
-- 誰能呼叫：app_rw，且必須是平台營運者脈絡（assert_operator）。
CREATE OR REPLACE FUNCTION registry.ownership_review_item(p_item_id text) RETURNS jsonb
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
    'held', coalesce((v_item.payload ->> 'held')::boolean, false),
    'conflict_id', (SELECT c.id FROM registry.ownership_conflicts c WHERE c.item_id = v_item.id),
    'conflict_status', (SELECT c.status FROM registry.ownership_conflicts c WHERE c.item_id = v_item.id));
END
$$;

-- 12. 讀取：被合併的物件讀存續物件的鍵（改寫 0076）--------------------------------------------------
-- 兩方並存之後，後來的一方的錨點併入先前的錨點（merged_into_id），它自己的撞號項目已結案，鍵欄位是空的。
-- 這個函式沿 merged_into_id 走到存續的錨點，鍵、座標與狀態取存續錨點的值，讓後來的一方的物件仍顯示自己的鍵。
-- anchor_id 維持單位自己的錨點：組織表的節點與送件都掛在它，不能換。沒有合併過的錨點，結果與 0076 完全相同。
-- 誰能呼叫與隔離方式不變：app_rw，只回呼叫者組織有物件指向的單位。
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
  WITH RECURSIVE own AS (
    SELECT u.id AS unit_id, a.id AS anchor_id, a.merged_into_id
      FROM registry.rental_units u
      JOIN registry.anchors a ON a.id = u.anchor_id
     WHERE u.id = ANY (p_unit_ids)
       AND EXISTS (SELECT 1 FROM org.properties p WHERE p.rental_unit_id = u.id)
  ),
  chain (unit_id, id, merged_into_id, depth) AS (
    SELECT o.unit_id, o.anchor_id, o.merged_into_id, 0 FROM own o
    UNION ALL
    SELECT c.unit_id, n.id, n.merged_into_id, c.depth + 1
      FROM chain c
      JOIN registry.anchors n ON n.id = c.merged_into_id
     WHERE c.depth < 10
  ),
  survivor AS (
    SELECT DISTINCT ON (unit_id) unit_id, id FROM chain ORDER BY unit_id, depth DESC
  ),
  shown AS (
    SELECT o.unit_id, o.anchor_id, sa.status, sa.latitude, sa.longitude,
           coalesce(c.ck ->> 'city_code', sa.city_code)       AS city_code,
           coalesce(c.ck ->> 'town_code', sa.town_code)       AS town_code,
           coalesce(c.ck ->> 'section_code', sa.section_code) AS section_code,
           coalesce(c.ck ->> 'building_no', sa.building_no)   AS building_no,
           coalesce(c.ck ->> 'sub_no', sa.sub_no)             AS sub_no
      FROM own o
      JOIN survivor sv ON sv.unit_id = o.unit_id
      JOIN registry.anchors sa ON sa.id = sv.id
      LEFT JOIN LATERAL (
        SELECT r.payload -> 'claimed_key' AS ck
          FROM registry.review_items r
         WHERE r.type = 'anchor_collision' AND r.status = 'open' AND r.subject_id = o.anchor_id
           AND r.payload ->> 'claimant_org_id' = nullif(current_setting('app.org_id', true), '')
         ORDER BY r.created_at DESC
         LIMIT 1
      ) c ON true
  )
  SELECT s.unit_id, s.anchor_id, s.status, s.city_code, s.town_code, s.section_code, s.building_no, s.sub_no,
         ar.city_name, ar.town_name, se.name, se.sub_name, s.latitude, s.longitude
    FROM shown s
    LEFT JOIN registry.areas ar ON ar.city_code = s.city_code AND ar.town_code = s.town_code
    LEFT JOIN registry.sections se
           ON se.city_code = s.city_code AND se.town_code = s.town_code AND se.code = s.section_code
$$;
