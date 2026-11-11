-- 申請的接受、未接受與結束（MIL-210 前半資料段，spec MIL-193，ADR-0029 決議 2、6，ADR-0028）。
-- 由 runner 以 app_owner 執行。
--
-- 這份 migration 只做申請本身的轉移與通知：
--   接受：registry.accept_mandate_request。只有業者的組織管理員（admin）能做，必須指派自己組織的、現在有效的租賃住宅管理人員。
--   未接受：registry.decline_mandate_request。只有業者的 admin 能做，不收原因，資料庫也不存原因。
--   結束：registry.end_mandate_request。已接受的申請，業者（admin）與屋主（admin、staff）都能結束，不收原因。
-- 每個轉移在同一個交易通知另一方。通知只寫申請的種類與租賃單位的數量，不帶對方的 email 與名稱。
--
-- 設計原則（主控已定）：
-- 1. 呼叫者的組織與角色由函式自己判斷：組織來自 app.org_id，角色來自 control.org_memberships，不相信呼叫端傳入的角色。
--    別的組織的申請與不存在的申請都回 not_found，逐位元相同。
-- 2. 接受、未接受、結束與收回（0086）都先 FOR UPDATE 同一列，後到的請求看到新狀態，回 not_pending。
-- 3. 已失效（expired）的申請不能接受、不能未接受、不能結束，回應與狀態不符（not_pending）相同。失效不寫入，也不通知。
-- 4. 接受之後，這份申請不改變任何組織之間的關係，也不讓業者讀到屋主的物件。物件的可見性不在這份 migration（MIL-210 第二塊）。
--    這份 migration 不寫案件成員，不改呼叫者關係的判定函式，不改 org.properties 的政策。
-- 5. 管理人員資格的判定（業別、證書、任職三層都已驗證，期間涵蓋現在）在 TypeScript 的 credentialStatusAt，
--    route 在同一個交易內先判定，再呼叫 accept_mandate_request。這裡的函式只再檢查三件不依賴時間的事實：
--    任職屬於呼叫者自己組織的執業主體、是租賃住宅管理人員、任職與證書的狀態是 verified，以及申請對應的業別仍是 verified。
-- 6. 新函式沿用 0086 對 p_now 的檢查：p_now 不得晚於資料庫時間超過 5 分鐘。

-- 1. 欄位與檢查約束 ------------------------------------------------------------------
-- manager_employment_id：接受時指派的管理人員的任職（registry.practitioner_employments.id）。屋主端的函式不回傳。
-- closed_by：結束或未接受的是哪一方。declined 一律是 practice。
ALTER TABLE registry.mandate_requests
  ADD COLUMN manager_employment_id text REFERENCES registry.practitioner_employments (id),
  ADD COLUMN closed_by             text CHECK (closed_by IN ('owner', 'practice'));

-- 已接受（以及由已接受而來的已結束、已完成）必須有接受時間與管理人員
ALTER TABLE registry.mandate_requests
  ADD CONSTRAINT mandate_requests_accepted_has_manager
    CHECK (status NOT IN ('accepted', 'ended', 'completed') OR (accepted_at IS NOT NULL AND manager_employment_id IS NOT NULL)),
  ADD CONSTRAINT mandate_requests_manager_only_after_accept
    CHECK (manager_employment_id IS NULL OR status IN ('accepted', 'ended', 'completed')),
  -- 未接受與已結束必須有結束時間與結束的一方。未接受只能是業者
  ADD CONSTRAINT mandate_requests_closed_has_actor
    CHECK (status NOT IN ('declined', 'ended') OR (closed_at IS NOT NULL AND closed_by IS NOT NULL)),
  ADD CONSTRAINT mandate_requests_declined_by_practice
    CHECK (status <> 'declined' OR closed_by = 'practice'),
  ADD CONSTRAINT mandate_requests_closed_by_only_when_closed
    CHECK (closed_by IS NULL OR status IN ('declined', 'ended'));

-- 2. 業者接受 ------------------------------------------------------------------------
-- 誰能呼叫：app_rw，在業者組織的成員脈絡內，而且呼叫者在這個組織的角色必須是 admin（函式自己查 control.org_memberships）。
-- 營運者脈絡、沒有成員（party）的脈絡、staff 與 viewer 都被拒（42501）。
-- 做什麼：申請必須是呼叫者組織的、待業者接受、沒失效。管理人員必須是呼叫者自己執業主體的租賃住宅管理人員，任職與證書都是 verified，
-- 申請對應的業別仍是 verified。檢查都通過時，狀態改成已接受，accepted_at 記接受時間，manager_employment_id 記管理人員。
-- 同交易對屋主組織寫一則站內通知（種類 request.accepted），只寫申請種類與租賃單位數量，不帶業者與管理人員的名稱。
-- 回傳一列 (outcome)：
--   accepted               接受成功。
--   not_found              申請不是呼叫者組織的（含不存在、別的組織的）。
--   not_pending            申請不是待業者接受（已接受、未接受、已收回、已結束等），或已失效。後者與前者逐位元相同。
--   license_not_verified   申請對應的業別已不是 verified。
--   manager_not_eligible   任職不是呼叫者自己組織的、不是租賃住宅管理人員，或任職或證書不是 verified。
-- 為什麼：只有組織管理員能代表業者承接屋主的申請。指派的管理人員必須是自己組織的人，否則業者能指派別家的管理人員。
-- 管理人員的任職期間與證書效期涵蓋現在，由 TypeScript 在同一個交易內先判定（credentialStatusAt），這裡不另寫一份。
CREATE FUNCTION registry.accept_mandate_request(p_id text, p_manager_employment_id text, p_notification_id text, p_now timestamptz)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org   text := nullif(current_setting('app.org_id', true), '');
  v_party text := nullif(current_setting('app.party_id', true), '');
  v_role  text;
  v_req   registry.mandate_requests;
  v_units integer;
  v_label text;
BEGIN
  IF v_org IS NULL OR v_party IS NULL OR nullif(current_setting('app.operator_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'registry.accept_mandate_request 必須由組織成員呼叫' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role
    FROM control.org_memberships m JOIN control.users u ON u.id = m.user_id
   WHERE m.org_id = v_org AND u.party_id = v_party;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION '只有組織管理員能接受申請' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR p_manager_employment_id IS NULL OR p_now IS NULL OR p_notification_id IS NULL THEN
    RAISE EXCEPTION '申請 ID、管理人員、通知 ID 與時間必須由呼叫端提供' USING ERRCODE = '22023';
  END IF;
  IF p_now > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'p_now 不得晚於資料庫時間' USING ERRCODE = '22023';
  END IF;

  SELECT r.* INTO v_req FROM registry.mandate_requests r WHERE r.id = p_id AND r.practice_org_id = v_org FOR UPDATE OF r;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text;
    RETURN;
  END IF;
  IF registry.mandate_request_status_at(v_req.status, v_req.link_expires_at, v_req.submitted_at, v_req.accepted_at, v_req.contract_sent_at, p_now)
     <> 'pending_practice' THEN
    RETURN QUERY SELECT 'not_pending'::text;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM registry.practice_licenses l
     WHERE l.entity_id = v_req.entity_id AND l.kind = v_req.kind AND l.state = 'verified') THEN
    RETURN QUERY SELECT 'license_not_verified'::text;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM registry.practitioner_employments m
      JOIN registry.practitioners p ON p.id = m.practitioner_id
      JOIN registry.practice_entities e ON e.id = m.entity_id
     WHERE m.id = p_manager_employment_id
       AND e.org_id = v_org
       AND m.certificate_kind = 'rental_housing_manager'
       AND m.state = 'verified'
       AND p.state = 'verified') THEN
    RETURN QUERY SELECT 'manager_not_eligible'::text;
    RETURN;
  END IF;

  UPDATE registry.mandate_requests r
     SET status = 'accepted', accepted_at = p_now, manager_employment_id = p_manager_employment_id
   WHERE r.id = p_id;

  SELECT count(*)::integer INTO v_units FROM registry.mandate_request_units u WHERE u.request_id = p_id;
  v_label := CASE v_req.kind WHEN 'management' THEN '委託管理申請' ELSE '住宅包租申請' END;
  PERFORM set_config('app.org_id', v_req.owner_org_id, true);
  INSERT INTO org.notifications (id, org_id, kind, title, body, link_path)
  VALUES (p_notification_id, v_req.owner_org_id, 'request.accepted', '申請已接受',
          '業者接受了你送出的' || v_label || '，含 ' || v_units || ' 個租賃單位。', '/requests/' || p_id);
  PERFORM set_config('app.org_id', v_org, true);

  RETURN QUERY SELECT 'accepted'::text;
END
$$;
REVOKE ALL ON FUNCTION registry.accept_mandate_request(text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.accept_mandate_request(text, text, text, timestamptz) TO app_rw;

-- 3. 業者不接受 ----------------------------------------------------------------------
-- 誰能呼叫：app_rw，在業者組織的成員脈絡內，角色必須是 admin（同 accept_mandate_request）。
-- 做什麼：申請必須是呼叫者組織的、待業者接受、沒失效。狀態改成未接受，closed_at 記時間，closed_by 固定是 practice。
-- 不收原因，資料庫也不存原因。同交易對屋主組織寫一則站內通知（種類 request.declined），文字只寫「未接受」與申請種類。
-- 回傳一列 (outcome)：declined、not_found、not_pending（含已失效）。
-- 為什麼：屋主只需要知道業者沒有接受。原因是業者的商業判斷，不經平台傳給屋主。
CREATE FUNCTION registry.decline_mandate_request(p_id text, p_notification_id text, p_now timestamptz)
RETURNS TABLE (outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org   text := nullif(current_setting('app.org_id', true), '');
  v_party text := nullif(current_setting('app.party_id', true), '');
  v_role  text;
  v_req   registry.mandate_requests;
  v_label text;
BEGIN
  IF v_org IS NULL OR v_party IS NULL OR nullif(current_setting('app.operator_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'registry.decline_mandate_request 必須由組織成員呼叫' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role
    FROM control.org_memberships m JOIN control.users u ON u.id = m.user_id
   WHERE m.org_id = v_org AND u.party_id = v_party;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION '只有組織管理員能不接受申請' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR p_now IS NULL OR p_notification_id IS NULL THEN
    RAISE EXCEPTION '申請 ID、通知 ID 與時間必須由呼叫端提供' USING ERRCODE = '22023';
  END IF;
  IF p_now > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'p_now 不得晚於資料庫時間' USING ERRCODE = '22023';
  END IF;

  SELECT r.* INTO v_req FROM registry.mandate_requests r WHERE r.id = p_id AND r.practice_org_id = v_org FOR UPDATE OF r;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text;
    RETURN;
  END IF;
  IF registry.mandate_request_status_at(v_req.status, v_req.link_expires_at, v_req.submitted_at, v_req.accepted_at, v_req.contract_sent_at, p_now)
     <> 'pending_practice' THEN
    RETURN QUERY SELECT 'not_pending'::text;
    RETURN;
  END IF;

  UPDATE registry.mandate_requests r SET status = 'declined', closed_at = p_now, closed_by = 'practice' WHERE r.id = p_id;

  v_label := CASE v_req.kind WHEN 'management' THEN '委託管理申請' ELSE '住宅包租申請' END;
  PERFORM set_config('app.org_id', v_req.owner_org_id, true);
  INSERT INTO org.notifications (id, org_id, kind, title, body, link_path)
  VALUES (p_notification_id, v_req.owner_org_id, 'request.declined', '申請未接受', '你送出的' || v_label || '未接受。', '/requests/' || p_id);
  PERFORM set_config('app.org_id', v_org, true);

  RETURN QUERY SELECT 'declined'::text;
END
$$;
REVOKE ALL ON FUNCTION registry.decline_mandate_request(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.decline_mandate_request(text, text, timestamptz) TO app_rw;

-- 4. 結束已接受的申請 ------------------------------------------------------------------
-- 誰能呼叫：app_rw，在申請當事人的組織成員脈絡內。業者那一方的角色必須是 admin，屋主那一方是 admin 或 staff（viewer 被拒）。
-- 函式依呼叫者的組織判斷是哪一方：呼叫者組織是申請的業者就是 practice，是申請綁定的屋主就是 owner。兩者都不是的申請回 not_found。
-- 做什麼：申請必須是已接受（合約全員完成之前）而且沒失效。狀態改成已結束，closed_at 記時間，closed_by 記結束的一方。
-- 不收原因，資料庫也不存原因。同交易對另一方的組織寫一則站內通知（種類 request.ended）：
-- 業者結束時屋主看到「業者已結束申請」，屋主結束時業者看到「屋主已結束申請」。文字只寫申請種類。
-- 回傳一列 (outcome, ended_by)：
--   ended       結束成功。ended_by 是 owner 或 practice。
--   not_found   申請不是呼叫者組織的（含不存在、別的組織的、第三個屋主的）。ended_by 是 NULL。
--   not_pending 申請不是已接受（待業者接受、未接受、已收回、已結束、已完成），或已失效。ended_by 是 NULL。
-- 為什麼：合約完成之前，雙方都能退出。結束之後，申請不再佔用租賃單位，屋主能再送別的申請。
CREATE FUNCTION registry.end_mandate_request(p_id text, p_notification_id text, p_now timestamptz)
RETURNS TABLE (outcome text, ended_by text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org    text := nullif(current_setting('app.org_id', true), '');
  v_party  text := nullif(current_setting('app.party_id', true), '');
  v_role   text;
  v_req    registry.mandate_requests;
  v_side   text;
  v_target text;
  v_label  text;
BEGIN
  IF v_org IS NULL OR v_party IS NULL OR nullif(current_setting('app.operator_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'registry.end_mandate_request 必須由組織成員呼叫' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR p_now IS NULL OR p_notification_id IS NULL THEN
    RAISE EXCEPTION '申請 ID、通知 ID 與時間必須由呼叫端提供' USING ERRCODE = '22023';
  END IF;
  IF p_now > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'p_now 不得晚於資料庫時間' USING ERRCODE = '22023';
  END IF;

  SELECT r.* INTO v_req FROM registry.mandate_requests r
   WHERE r.id = p_id AND (r.practice_org_id = v_org OR r.owner_org_id = v_org)
     FOR UPDATE OF r;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;
  v_side := CASE WHEN v_req.practice_org_id = v_org THEN 'practice' ELSE 'owner' END;
  SELECT m.role INTO v_role
    FROM control.org_memberships m JOIN control.users u ON u.id = m.user_id
   WHERE m.org_id = v_org AND u.party_id = v_party;
  IF v_role IS NULL OR (v_side = 'practice' AND v_role <> 'admin') OR (v_side = 'owner' AND v_role NOT IN ('admin', 'staff')) THEN
    RAISE EXCEPTION '呼叫者在這個組織的角色不能結束申請' USING ERRCODE = '42501';
  END IF;
  IF registry.mandate_request_status_at(v_req.status, v_req.link_expires_at, v_req.submitted_at, v_req.accepted_at, v_req.contract_sent_at, p_now)
     <> 'accepted' THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::text;
    RETURN;
  END IF;

  UPDATE registry.mandate_requests r SET status = 'ended', closed_at = p_now, closed_by = v_side WHERE r.id = p_id;

  v_label := CASE v_req.kind WHEN 'management' THEN '委託管理申請' ELSE '住宅包租申請' END;
  v_target := CASE v_side WHEN 'practice' THEN v_req.owner_org_id ELSE v_req.practice_org_id END;
  PERFORM set_config('app.org_id', v_target, true);
  INSERT INTO org.notifications (id, org_id, kind, title, body, link_path)
  VALUES (p_notification_id, v_target, 'request.ended',
          CASE v_side WHEN 'practice' THEN '業者已結束申請' ELSE '屋主已結束申請' END,
          CASE v_side WHEN 'practice' THEN '業者結束了一份' ELSE '屋主結束了一份' END || v_label || '。',
          '/requests/' || p_id);
  PERFORM set_config('app.org_id', v_org, true);

  RETURN QUERY SELECT 'ended'::text, v_side;
END
$$;
REVOKE ALL ON FUNCTION registry.end_mandate_request(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.end_mandate_request(text, text, timestamptz) TO app_rw;

-- 5. 業者讀自己的申請（加回新欄位）-----------------------------------------------------
-- 回傳形狀改變，必須先刪再建。政策同 0086：app_rw，在組織脈絡內，營運者脈絡被拒，只回呼叫者組織自己的申請。
-- 新增三欄：manager_employment_id（業者自己指派的管理人員，業者看得到）、closed_at、closed_by（未接受與已結束的時間與一方）。
-- 不得回傳：owner_org_id、claimed_at、draft_confirmed_at、confirmed_unit_id、屋主組織的任何資料。
DROP FUNCTION registry.mandate_requests_for_practice(text, timestamptz);
CREATE FUNCTION registry.mandate_requests_for_practice(p_id text, p_now timestamptz)
RETURNS TABLE (
  request_id text, kind text, status text, created_at timestamptz, link_expires_at timestamptz,
  submitted_at timestamptz, withdrawn_at timestamptz, accepted_at timestamptz, contract_sent_at timestamptz,
  draft jsonb, transcript_file_name text, unit_count integer,
  manager_employment_id text, closed_at timestamptz, closed_by text
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
              ELSE (SELECT count(*)::integer FROM registry.mandate_request_units u WHERE u.request_id = r.id) END,
         r.manager_employment_id, r.closed_at, r.closed_by
    FROM registry.mandate_requests r
   WHERE r.practice_org_id = v_org
     AND (p_id IS NULL OR r.id = p_id)
   ORDER BY r.id DESC
   LIMIT 200;
END
$$;
REVOKE ALL ON FUNCTION registry.mandate_requests_for_practice(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.mandate_requests_for_practice(text, timestamptz) TO app_rw;

-- 6. 屋主讀自己的申請（加回新欄位）-----------------------------------------------------
-- 政策同 0086：屋主組織專用，只回 owner_org_id 等於呼叫者組織的申請。
-- 新增兩欄：closed_at、closed_by。屋主看得到已接受、未接受、已結束，以及結束的是哪一方。
-- 不回傳 manager_employment_id 與任何管理人員的資料：管理人員的姓名在合約上才揭露。
-- 未接受的申請不帶任何能推出原因的欄位：資料庫沒有存原因，這個函式也沒有回傳業者端的任何欄位。
DROP FUNCTION registry.mandate_requests_for_owner(text, timestamptz);
CREATE FUNCTION registry.mandate_requests_for_owner(p_id text, p_now timestamptz)
RETURNS TABLE (
  request_id text, kind text, status text, created_at timestamptz, link_expires_at timestamptz, claimed_at timestamptz,
  submitted_at timestamptz, withdrawn_at timestamptz, accepted_at timestamptz, contract_sent_at timestamptz,
  practice_name text, tax_id text, verified_kinds text[],
  draft jsonb, has_transcript boolean, transcript_file_name text,
  draft_confirmed_at timestamptz, confirmed_unit_id text, unit_ids text[],
  closed_at timestamptz, closed_by text
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = registry, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org text := nullif(current_setting('app.org_id', true), '');
BEGIN
  IF v_org IS NULL OR nullif(current_setting('app.operator_id', true), '') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM control.orgs o WHERE o.id = v_org AND o.kind = 'owner') THEN
    RAISE EXCEPTION 'registry.mandate_requests_for_owner 必須由屋主組織的成員呼叫' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id, r.kind, r.status, r.created_at, r.link_expires_at, r.claimed_at,
         r.submitted_at, r.withdrawn_at, r.accepted_at, r.contract_sent_at,
         e.name, e.tax_id,
         coalesce((SELECT array_agg(l.kind ORDER BY l.kind) FROM registry.practice_licenses l WHERE l.entity_id = e.id AND l.state = 'verified'), ARRAY[]::text[]),
         CASE WHEN registry.mandate_request_status_at(r.status, r.link_expires_at, r.submitted_at, r.accepted_at, r.contract_sent_at, p_now) = 'pending_owner'
              THEN r.draft END,
         (r.draft_transcript IS NOT NULL
          AND registry.mandate_request_status_at(r.status, r.link_expires_at, r.submitted_at, r.accepted_at, r.contract_sent_at, p_now) = 'pending_owner'),
         CASE WHEN registry.mandate_request_status_at(r.status, r.link_expires_at, r.submitted_at, r.accepted_at, r.contract_sent_at, p_now) = 'pending_owner'
              THEN r.draft_transcript ->> 'file_name' END,
         r.draft_confirmed_at, r.confirmed_unit_id,
         coalesce((SELECT array_agg(u.rental_unit_id ORDER BY u.rental_unit_id) FROM registry.mandate_request_units u WHERE u.request_id = r.id), ARRAY[]::text[]),
         r.closed_at, r.closed_by
    FROM registry.mandate_requests r
    JOIN registry.practice_entities e ON e.id = r.entity_id
   WHERE r.owner_org_id = v_org
     AND (p_id IS NULL OR r.id = p_id)
   ORDER BY r.id DESC
   LIMIT 200;
END
$$;
REVOKE ALL ON FUNCTION registry.mandate_requests_for_owner(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.mandate_requests_for_owner(text, timestamptz) TO app_rw;
