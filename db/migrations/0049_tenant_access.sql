-- 承租人端的資料庫部分（MIL-121，ADR-0022 決議 6、ADR-0023 決議 5、ADR-0016 決議 15）。C 線 migration，0046 到 0048 留給別的票。
-- 由 runner 以 app_owner 執行。
--
-- 做三件事：
-- 1. 案件事件加 member_replaced（承租人 email 更新，P0-21 AC5）。
-- 2. org.party_has_tenant_membership(party_id)：登入時判斷帳號有沒有「承租人」身分。
-- 3. 已簽合約檔案的成員讀取政策：org.sign_task_files 的 member_read。

-- 1. 案件事件類型 -------------------------------------------------------------
-- 清單與 src/lib/cases/transitions.ts 的 CASE_EVENT_TYPES 一致，case-rls.test.ts 逐一驗證。
ALTER TABLE org.case_events DROP CONSTRAINT case_events_type_check;
ALTER TABLE org.case_events ADD CONSTRAINT case_events_type_check CHECK (type IN (
  'created', 'succeeded', 'migrated', 'input_rejected',
  'contract_sent', 'contract_completed', 'contract_declined', 'contract_voided',
  'aborted', 'move_out_started', 'move_out_cancelled', 'move_out_inspection_completed',
  'advanced_after_notice', 'closed', 'paper_contract_registered', 'terminated', 'expired',
  'handed_over', 'member_added', 'contract_attached', 'member_replaced'));

-- 2. 承租人身分 ---------------------------------------------------------------
-- 登入時的交易是 control 脈絡，沒有 app.party_id，org.case_members 的 self_read 讀不到任何列。
-- 這個函式跨組織讀成員表，只回傳一個 boolean：這個 party 是不是任何案件的有效承租人或共同承租人。
-- 它是跨組織讀取的函式，MIL-89 的系統目錄檢查必須納入。
--
-- 呼叫端限制：登入流程在驗證碼通過之前不得呼叫它，否則回應差異會洩漏 email 有沒有案件（P0-21 AC6）。
--
-- SECURITY DEFINER，search_path 固定，PUBLIC 不能執行，只授予 app_rw。
-- 注意：case_members 是 FORCE RLS，擁有者 app_owner 也受政策限制（ADR-0012 決議 5），
-- 所以定義者身分本身看不到列。函式在交易內暫時設定 app.party_id，走 self_read 的路徑，查完立刻還原。
-- 有效期用資料庫的 now()，與讀取政策同一個時鐘。
CREATE FUNCTION org.party_has_tenant_membership(p_party_id text) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = org, pg_temp
AS $$
DECLARE
  previous text := coalesce(current_setting('app.party_id', true), '');
  found    boolean;
BEGIN
  IF p_party_id IS NULL OR p_party_id = '' THEN
    RETURN false;
  END IF;
  PERFORM set_config('app.party_id', p_party_id, true);
  SELECT EXISTS (
    SELECT 1 FROM org.case_members m
     WHERE m.party_id = p_party_id
       AND m.relation IN ('lessee', 'co_lessee')
       AND m.valid_period @> now()
  ) INTO found;
  PERFORM set_config('app.party_id', previous, true);
  RETURN found;
END;
$$;

REVOKE ALL ON FUNCTION org.party_has_tenant_membership(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org.party_has_tenant_membership(text) TO app_rw;

-- 3. 已簽合約檔案的成員讀取 -----------------------------------------------------
-- org.sign_task_files 沒有 case_id，要經 簽署任務 → 合約 → 案件 才找得到案件。
-- 成員（承租人）讀不到 sign_tasks（只開放 lessor、mandator、mandatary），所以政策不能直接在子查詢查它。
-- 這個函式暫時把 app.org_id 設成檔案列自己的 org_id，查出案件，立刻還原，再回傳目前 party 在該案件的關係。
-- 它只回傳關係陣列，不回傳任何資料列。INVOKER，與 case_relations_of_current_party 相同。
CREATE FUNCTION org.case_relations_of_sign_task(p_org_id text, p_sign_task_id text) RETURNS text[]
LANGUAGE plpgsql
VOLATILE
SET search_path = org, pg_temp
AS $$
DECLARE
  previous_org text := coalesce(current_setting('app.org_id', true), '');
  v_case_id    text;
BEGIN
  IF coalesce(current_setting('app.party_id', true), '') = '' THEN
    RETURN ARRAY[]::text[];
  END IF;
  PERFORM set_config('app.org_id', p_org_id, true);
  SELECT c.case_id INTO v_case_id
    FROM org.sign_tasks t
    JOIN org.contracts c ON c.id = t.subject_id AND c.org_id = t.org_id
   WHERE t.id = p_sign_task_id AND t.org_id = p_org_id AND t.subject_type = 'contract';
  PERFORM set_config('app.org_id', previous_org, true);
  IF v_case_id IS NULL THEN
    RETURN ARRAY[]::text[];
  END IF;
  RETURN org.case_relations_of_current_party(v_case_id);
END;
$$;

REVOKE ALL ON FUNCTION org.case_relations_of_sign_task(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org.case_relations_of_sign_task(text, text) TO app_rw;

-- 成員只讀已簽 PDF（kind = 'signed_pdf'），不讀 Audit Trail File。
-- 可讀的關係與 contracts 的 member_read 相同，owner 讀不到（P0-09 AC5）。
CREATE POLICY member_read ON org.sign_task_files FOR SELECT
  USING (kind = 'signed_pdf'
         AND org.case_relations_of_sign_task(org_id, sign_task_id)
             && ARRAY['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker', 'mandator', 'mandatary']);
