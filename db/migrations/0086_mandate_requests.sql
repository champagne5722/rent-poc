-- 申請：委託管理申請與住宅包租申請（MIL-206，spec MIL-193，ADR-0029、ADR-0030、ADR-0028）。
-- 由 runner 以 app_owner 執行。
--
-- 流程：業者在線下把連結（或 QR code）交給屋主。屋主自己登入、選租賃單位、送出。業者在屋主送出前什麼都不知道。
-- 平台不經由任何管道主動寄信給屋主。
--
-- 設計原則（主控已定，這份 migration 的每個函式都照它寫）：
-- 1. 申請跨兩個組織，org 表的單一 org_id RLS 裝不了。申請表放 registry schema，app_rw 沒有任何權限，
--    讀寫都經定義者函式，函式依呼叫者的組織脈絡（app.org_id）決定能讀寫哪些列。
-- 2. 申請不會讓任何組織之間的關係變成 bound。registry.caller_relation 不讀這兩張表，也不寫 org.case_members。
--    relation = 'mandatary' 的案件成員只能來自被接受的申請，那是 MIL-210 的事，這份 migration 不寫它（MIL-200 結案紀錄）。
-- 3. 連結的隨機碼只存 SHA-256。碼 32 位元組隨機，明碼只在產生連結的那次回應出現。
-- 4. 期限在讀取時判定，時間由參數 p_now 傳入。狀態表與常數在 TypeScript 的 src/lib/mandate-requests/status.ts，
--    SQL 的 registry.mandate_request_status_at 與它同值，兩邊由 mandate-requests-schema.test.ts 逐格比對。
-- 5. 業者代填的資料只存在申請列的 jsonb。它不建錨點、不進審核台、不進 registry.verified_ownership_keys，也不佔建號。
--    屋主確認時才走既有的 registerProperty，登錄在屋主自己的組織。
-- 6. 屋主打開連結、登入、綁定、確認代填資料，都不改變業者能讀到的任何東西。業者讀申請的函式不回傳 owner_org_id、claimed_at、
--    draft_confirmed_at。屋主送出後業者才收到站內通知。

-- 1. 申請本體 ---------------------------------------------------------------------
CREATE TABLE registry.mandate_requests (
  id                  text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  -- management 是委託管理申請，master_lease 是住宅包租申請（GLOSSARY，ADR-0030）
  kind                text NOT NULL CHECK (kind IN ('management', 'master_lease')),
  practice_org_id     text NOT NULL REFERENCES control.orgs (id),
  entity_id           text NOT NULL REFERENCES registry.practice_entities (id),
  created_by_party_id text NOT NULL REFERENCES control.parties (id),
  -- 隨機碼的 SHA-256（16 進位）。不存明碼
  code_hash           text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  -- 資料庫存的狀態。失效（expired）不存，讀取時依期限判定。accepted、declined、ended、completed 由 MIL-210、211、212 寫入
  status              text NOT NULL DEFAULT 'pending_owner'
                      CHECK (status IN ('pending_owner', 'pending_practice', 'accepted', 'declined', 'withdrawn', 'ended', 'completed')),
  -- 業者代填的房子資料，欄位集合與 PropertyInput 一致。屋主確認時由 registerProperty 重新驗證，不信任存放的值
  draft               jsonb CHECK (draft IS NULL OR (jsonb_typeof(draft) = 'object' AND pg_column_size(draft) <= 20000)),
  -- 業者代傳的謄本：FileStore 的 key、雜湊、檔名與謄本表單欄位。屋主送出、收回或連結失效時清掉，檔案同時刪除
  draft_transcript    jsonb CHECK (draft_transcript IS NULL OR (jsonb_typeof(draft_transcript) = 'object' AND pg_column_size(draft_transcript) <= 20000)),
  -- 屋主確認代填資料之後登錄的租賃單位。只有屋主端讀得到，業者端的函式不回傳
  draft_confirmed_at  timestamptz,
  confirmed_unit_id   text REFERENCES registry.rental_units (id),
  created_at          timestamptz NOT NULL,
  link_expires_at     timestamptz NOT NULL,
  -- 第一位登入並綁定的屋主組織。綁定前是 NULL。業者端的函式不回傳這兩欄
  owner_org_id        text REFERENCES control.orgs (id),
  claimed_at          timestamptz,
  submitted_at        timestamptz,
  withdrawn_at        timestamptz,
  -- 以下三欄在 MIL-206 都是 NULL，留給 MIL-210（接受、結束）與 MIL-211、212（送出合約）
  accepted_at         timestamptz,
  contract_sent_at    timestamptz,
  closed_at           timestamptz,
  CHECK (link_expires_at > created_at),
  CHECK ((owner_org_id IS NULL) = (claimed_at IS NULL)),
  CHECK ((status = 'pending_owner') = (submitted_at IS NULL)),
  CHECK (status = 'pending_owner' OR owner_org_id IS NOT NULL),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CHECK ((draft_confirmed_at IS NULL) = (confirmed_unit_id IS NULL))
);
CREATE INDEX mandate_requests_by_practice ON registry.mandate_requests (practice_org_id, id DESC);
CREATE INDEX mandate_requests_by_owner ON registry.mandate_requests (owner_org_id, id DESC) WHERE owner_org_id IS NOT NULL;

-- 2. 申請含的租賃單位（一次申請能含多個）-----------------------------------------------
-- 屋主送出時寫入，之後不改。只有送出過的申請有列。屋主端的租賃單位歸屬由送出當下的 org.properties 檢查
CREATE TABLE registry.mandate_request_units (
  request_id     text NOT NULL REFERENCES registry.mandate_requests (id),
  rental_unit_id text NOT NULL REFERENCES registry.rental_units (id),
  PRIMARY KEY (request_id, rental_unit_id)
);
CREATE INDEX mandate_request_units_by_unit ON registry.mandate_request_units (rental_unit_id);

REVOKE ALL ON registry.mandate_requests, registry.mandate_request_units FROM PUBLIC, app_rw;

-- 3. 讀取時的狀態 -------------------------------------------------------------------
-- 與 status.ts 的 effectiveStatus 同值：期限的時間點（含）起算失效。連結 7 天、送出後 7 天、接受後 30 天。
-- 內部函式，不授權給 app_rw。用小時算，避免 interval '7 days' 受 session 時區影響。
CREATE FUNCTION registry.mandate_request_status_at(
  p_status           text,
  p_link_expires_at  timestamptz,
  p_submitted_at     timestamptz,
  p_accepted_at      timestamptz,
  p_contract_sent_at timestamptz,
  p_now              timestamptz
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_status = 'pending_owner' AND p_now >= p_link_expires_at THEN 'expired'
    WHEN p_status = 'pending_practice' AND p_submitted_at IS NOT NULL
         AND p_now >= p_submitted_at + interval '168 hours' THEN 'expired'
    WHEN p_status = 'accepted' AND p_contract_sent_at IS NULL AND p_accepted_at IS NOT NULL
         AND p_now >= p_accepted_at + interval '720 hours' THEN 'expired'
    ELSE p_status
  END
$$;
REVOKE ALL ON FUNCTION registry.mandate_request_status_at(text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz) FROM PUBLIC;

-- 4. 被佔用的租賃單位 ---------------------------------------------------------------
-- 屋主送出時用：這些租賃單位有沒有已經被佔用。只讀屋主自己組織的申請（owner_org_id = p_owner_org），
-- 不跨組織，所以結果不會透露別的業者的任何事（ADR-0029 決議 9，ADR-0028 決議 1）。
-- 佔用的來源：
--   1. 進行中的申請：待業者接受，或已接受而且沒失效（本票）。
--   2. 有效的委託（委託管理案件）：MIL-212 補在下面的 UNION ALL。
--   3. 有效的包租（包租案件）：MIL-211 補在下面的 UNION ALL。
-- 內部函式，不授權給 app_rw。p_exclude_request 是屋主正在送出的那一份，不算自己。
CREATE FUNCTION registry.occupied_rental_units(
  p_owner_org       text,
  p_unit_ids        text[],
  p_now             timestamptz,
  p_exclude_request text DEFAULT NULL
) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
  SELECT DISTINCT u.rental_unit_id
    FROM registry.mandate_request_units u
    JOIN registry.mandate_requests r ON r.id = u.request_id
   WHERE r.owner_org_id = p_owner_org
     AND u.rental_unit_id = ANY (p_unit_ids)
     AND (p_exclude_request IS NULL OR r.id <> p_exclude_request)
     AND registry.mandate_request_status_at(r.status, r.link_expires_at, r.submitted_at, r.accepted_at, r.contract_sent_at, p_now)
         IN ('pending_practice', 'accepted')
$$;
REVOKE ALL ON FUNCTION registry.occupied_rental_units(text, text[], timestamptz, text) FROM PUBLIC;

-- 5. 業者產生連結 -------------------------------------------------------------------
-- 誰能呼叫：app_rw，在組織脈絡內，app.party_id 必須有值，營運者脈絡被拒。呼叫者的組織必須有執業主體，
-- 而且那個執業主體對應的業別（委託管理申請對 management，住宅包租申請對 master_lease）是 verified。
-- 做什麼：寫一列待屋主確認的申請，連結 7 天後失效（不論有沒有代填資料）。碼的雜湊由呼叫端產生，函式不接觸明碼。
-- 回傳一列：申請 ID、種類、狀態、建立時間、連結失效時間。呼叫者的組織沒有通過驗證的對應業別時回零列，什麼都不寫。
-- 不含碼，也不含任何別的組織的資料。
-- 為什麼：只有通過業別驗證的業者能發出申請。代填的資料原樣存起來，不查建號有沒有被別人登錄，
-- 所以代填的建號與別人已登錄的相同時，業者得到的回應與不相同時沒有差異。
-- 這個函式不寫 org.case_members，也不讓 registry.caller_relation 回傳 bound。
CREATE FUNCTION registry.create_mandate_request(
  p_id        text,
  p_kind      text,
  p_code_hash text,
  p_draft     jsonb,
  p_now       timestamptz
)
RETURNS TABLE (request_id text, kind text, status text, created_at timestamptz, link_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org    text := nullif(current_setting('app.org_id', true), '');
  v_party  text := nullif(current_setting('app.party_id', true), '');
  v_entity text;
BEGIN
  IF v_org IS NULL OR v_party IS NULL OR nullif(current_setting('app.operator_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'registry.create_mandate_request 必須由組織成員呼叫' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR p_now IS NULL OR p_kind IS NULL OR p_kind NOT IN ('management', 'master_lease')
     OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
     OR (p_draft IS NOT NULL AND jsonb_typeof(p_draft) <> 'object') THEN
    RAISE EXCEPTION '申請的種類、碼的雜湊或代填資料格式不符' USING ERRCODE = '22023';
  END IF;

  SELECT e.id INTO v_entity
    FROM registry.practice_entities e
    JOIN registry.practice_licenses l ON l.entity_id = e.id
   WHERE e.org_id = v_org AND l.kind = p_kind AND l.state = 'verified';
  IF v_entity IS NULL THEN
    -- 零列代表沒有通過驗證的對應業別。不丟錯，交易不會中止，route 可以直接回 403
    RETURN;
  END IF;

  INSERT INTO registry.mandate_requests (id, kind, practice_org_id, entity_id, created_by_party_id, code_hash, draft, created_at, link_expires_at)
  VALUES (p_id, p_kind, v_org, v_entity, v_party, p_code_hash, p_draft, p_now, p_now + interval '168 hours');

  RETURN QUERY SELECT r.id, r.kind, r.status, r.created_at, r.link_expires_at FROM registry.mandate_requests r WHERE r.id = p_id;
END
$$;
REVOKE ALL ON FUNCTION registry.create_mandate_request(text, text, text, jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.create_mandate_request(text, text, text, jsonb, timestamptz) TO app_rw;

-- 6. 登入前的連結頁 -----------------------------------------------------------------
-- 誰能呼叫：app_rw，任何脈絡（登入前走 control 脈絡，沒有 app.org_id；登入後走組織脈絡）。
-- 回什麼：有效的連結回一列 (種類, 業者名稱, 統編, 已驗證的業別, 連結失效時間)；其餘回零列。
-- 零列涵蓋所有無效的原因，route 對它們回逐位元相同的回應：查無此碼、已過期、已送出或已收回（狀態不是待屋主確認）、
-- 業者的該業別已不是 verified、已被別的屋主組織綁定。函式不區分原因，也沒有第二個回傳欄位能區分。
-- 為什麼：業者的名稱、統編與業別是業者自己的公開資訊（ADR-0029：登入前只顯示這三項）。碼有 256 位元，查不出別的碼。
-- 不得回傳：代填的地址、建號、謄本、屋主組織、綁定與否、任何物件資料。
-- 綁定判斷：呼叫者是屋主組織（owner 種類）時，已被別的組織綁定的連結回零列。登入前與業者、平台組織的呼叫者看不出綁定與否，
-- 一律當作沒有綁定，所以業者自己打開連結也探不出屋主有沒有開過（MIL-206 驗收 13）。
CREATE FUNCTION registry.mandate_request_link_view(p_code_hash text, p_now timestamptz)
RETURNS TABLE (kind text, practice_name text, tax_id text, verified_kinds text[], expires_at timestamptz)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org      text := nullif(current_setting('app.org_id', true), '');
  v_is_owner boolean := false;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' OR p_now IS NULL THEN
    RETURN;
  END IF;
  IF v_org IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM control.orgs o WHERE o.id = v_org AND o.kind = 'owner') INTO v_is_owner;
  END IF;
  RETURN QUERY
  SELECT r.kind, e.name, e.tax_id,
         (SELECT array_agg(l.kind ORDER BY l.kind) FROM registry.practice_licenses l WHERE l.entity_id = e.id AND l.state = 'verified'),
         r.link_expires_at
    FROM registry.mandate_requests r
    JOIN registry.practice_entities e ON e.id = r.entity_id
   WHERE r.code_hash = p_code_hash
     AND r.status = 'pending_owner'
     AND p_now < r.link_expires_at
     AND EXISTS (SELECT 1 FROM registry.practice_licenses l WHERE l.entity_id = e.id AND l.kind = r.kind AND l.state = 'verified')
     AND (NOT v_is_owner OR r.owner_org_id IS NULL OR r.owner_org_id = v_org);
END
$$;
REVOKE ALL ON FUNCTION registry.mandate_request_link_view(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.mandate_request_link_view(text, timestamptz) TO app_rw;

-- 7. 業者讀自己的申請 ---------------------------------------------------------------
-- 誰能呼叫：app_rw，在組織脈絡內，營運者脈絡被拒。p_id 為 NULL 時列出呼叫者組織的申請（最新的 200 筆），
-- 有值時只回那一筆。不是呼叫者組織的申請與不存在的申請都回零列，逐位元相同。
-- 回什麼：申請 ID、種類、資料庫的狀態、建立與失效時間、送出與收回時間、接受與送出合約的時間（本票是 NULL）、
-- 代填資料（連結失效後是 NULL）、謄本檔名、租賃單位數量（送出前是 NULL）。
-- 不得回傳：owner_org_id、claimed_at、draft_confirmed_at、confirmed_unit_id、屋主組織的任何資料。
-- 為什麼：「沒人打開」「有人打開」「已綁定但沒送出」三種情況，業者讀到的內容必須逐位元相同（MIL-206 驗收 13）。
-- 回傳的是資料庫的狀態，TypeScript 的 effectiveStatus 依 now 判定失效。
CREATE FUNCTION registry.mandate_requests_for_practice(p_id text, p_now timestamptz)
RETURNS TABLE (
  request_id text, kind text, status text, created_at timestamptz, link_expires_at timestamptz,
  submitted_at timestamptz, withdrawn_at timestamptz, accepted_at timestamptz, contract_sent_at timestamptz,
  draft jsonb, transcript_file_name text, unit_count integer
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org text := nullif(current_setting('app.org_id', true), '');
BEGIN
  IF v_org IS NULL OR nullif(current_setting('app.operator_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'registry.mandate_requests_for_practice 必須由組織成員呼叫' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id, r.kind, r.status, r.created_at, r.link_expires_at,
         r.submitted_at, r.withdrawn_at, r.accepted_at, r.contract_sent_at,
         CASE WHEN registry.mandate_request_status_at(r.status, r.link_expires_at, r.submitted_at, r.accepted_at, r.contract_sent_at, p_now) = 'expired'
              THEN NULL ELSE r.draft END,
         CASE WHEN registry.mandate_request_status_at(r.status, r.link_expires_at, r.submitted_at, r.accepted_at, r.contract_sent_at, p_now) = 'expired'
              THEN NULL ELSE r.draft_transcript ->> 'file_name' END,
         CASE WHEN r.submitted_at IS NULL THEN NULL
              ELSE (SELECT count(*)::integer FROM registry.mandate_request_units u WHERE u.request_id = r.id) END
    FROM registry.mandate_requests r
   WHERE r.practice_org_id = v_org
     AND (p_id IS NULL OR r.id = p_id)
   ORDER BY r.id DESC
   LIMIT 200;
END
$$;
REVOKE ALL ON FUNCTION registry.mandate_requests_for_practice(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.mandate_requests_for_practice(text, timestamptz) TO app_rw;

-- 8. 清除失效申請的代填資料與謄本 -----------------------------------------------------------
-- 誰能呼叫：app_rw，任何脈絡。業者端的清單與產生連結的 route 順手呼叫，也可以由排程呼叫。
-- 做什麼：待屋主確認而且連結已失效的申請，把 draft 與 draft_transcript 清成 NULL（代填資料不能再使用）。
-- 回傳被清掉的謄本檔案 key，呼叫端把檔案從 FileStore 刪除。回傳值只有 key，不帶申請 ID、組織或個資。
-- 為什麼：失效後讀取的函式本來就不回傳代填資料，這裡再把資料真的清掉，檔案也不留。
-- p_now 不得晚於資料庫時間超過 5 分鐘：這個函式會永久清資料，不能靠傳入未來的時間清掉還沒失效的申請。
CREATE FUNCTION registry.expire_mandate_requests(p_now timestamptz)
RETURNS SETOF text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
BEGIN
  IF p_now IS NULL OR p_now > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'p_now 不得晚於資料庫時間' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  -- RETURNING 讀到的是更新後的值，所以先把要清的列和舊的 key 選出來並鎖住，再更新
  WITH victims AS (
    SELECT r.id, r.draft_transcript ->> 'object_key' AS object_key
      FROM registry.mandate_requests r
     WHERE r.status = 'pending_owner' AND p_now >= r.link_expires_at
       AND (r.draft IS NOT NULL OR r.draft_transcript IS NOT NULL)
       FOR UPDATE OF r
  ), cleared AS (
    UPDATE registry.mandate_requests r
       SET draft = NULL, draft_transcript = NULL
      FROM victims v
     WHERE r.id = v.id
    RETURNING v.object_key
  )
  SELECT c.object_key FROM cleared c WHERE c.object_key IS NOT NULL;
END
$$;
REVOKE ALL ON FUNCTION registry.expire_mandate_requests(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.expire_mandate_requests(timestamptz) TO app_rw;
