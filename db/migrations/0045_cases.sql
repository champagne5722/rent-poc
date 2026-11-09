-- 案件、案件成員、案件事件（MIL-115，ADR-0016、ADR-0023、ADR-0012 決議 7）。C 線 migration，0043、0044 是 MIL-109 的。
-- 由 runner 以 app_owner 執行。寫法照 0004、0009：org_id、複合唯一鍵、複合外鍵、ENABLE 與 FORCE RLS。
--
-- 本票只寫自管租賃案件。下列欄位先建好，值留給下一批票，省得再開 migration：
--   linked_mandate_case_id  代管租賃案件連到的委託管理案件（MIL-116、MIL-119）
--   valid_until             委託管理案件的委託期間最後一天（MIL-119）
-- predecessor_case_id、handover_id 是跨組織引用（ADR-0024），依 ADR-0012 陷阱 5 的相反方向處理：
-- 單欄外鍵會穿透 RLS，所以不加外鍵，只存文字。
--
-- 案件 ID、合約 ID、成員 ID 一律是 ULID 文字，金額是整數元。

-- 1. org.cases：案件 ----------------------------------------------------------
-- state 存 text，不用 PostgreSQL enum（ADR-0016 決議 17）。(kind, state) 的 CHECK 與 src/lib/cases/transitions.ts 的
-- LEASE_CASE_STATES、MANAGEMENT_CASE_STATES 一致，case-schema.test.ts 逐一驗證。
-- 租期與租金欄位讓 owner 關係只讀 cases 就看得到租期（ADR-0016 決議 15）。後繼案件沒有合約列，由呼叫端寫入（ADR-0024 決議 4）。
CREATE TABLE org.cases (
  id                     text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id                 text NOT NULL REFERENCES control.orgs (id),
  kind                   text NOT NULL CHECK (kind IN ('lease', 'management')),
  state                  text NOT NULL,
  -- 樂觀鎖。dispatch() 以讀到的版本更新，版本不符時整個交易回滾（ADR-0016 決議 1、11）
  state_version          integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  -- 業務類型：自管、代管、包租。只有租賃案件有（ADR-0016 決議 17）
  business_type          text CHECK (business_type IN ('self_managed', 'managed', 'master_lease')),
  -- 物件名稱與地址的快照。成員不屬於主辦組織時讀不到物件表，案件清單靠它顯示
  title                  text NOT NULL DEFAULT '',
  -- org 到 registry 的外鍵：app_rw 沒有 registry 權限也能寫入有效 ID（ADR-0013 決議 11）。
  -- 可為空：舊資料的合約若沒有物件，遷移時不補。route 建案件時一定帶值
  rental_unit_id         text REFERENCES registry.rental_units (id),
  property_id            text,
  -- 案件只認這份合約的送簽、全員完成、拒簽、撤回（ADR-0016 決議 11）。後繼案件沒有合約，是 NULL
  current_contract_id    text,
  linked_mandate_case_id text,
  predecessor_case_id    text,
  handover_id            text,
  valid_until            date,
  lease_start            date,
  lease_end              date,
  monthly_rent           integer CHECK (monthly_rent IS NULL OR monthly_rent >= 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz,
  UNIQUE (org_id, id),
  -- 物件被刪除時（草稿合約刪除、案件放棄之後），案件保留，property_id 清成 NULL；title 與 rental_unit_id 是快照
  FOREIGN KEY (org_id, property_id) REFERENCES org.properties (org_id, id) ON DELETE SET NULL (property_id),
  FOREIGN KEY (org_id, linked_mandate_case_id) REFERENCES org.cases (org_id, id),
  CHECK ((kind = 'lease') = (business_type IS NOT NULL)),
  CHECK (
    (kind = 'lease' AND state IN ('draft', 'signing', 'active', 'move_out', 'settling', 'closed', 'aborted'))
    OR (kind = 'management' AND state IN ('draft', 'signing', 'active', 'terminated', 'expired', 'aborted'))
  ),
  CHECK (kind = 'management' OR valid_until IS NULL)
);

CREATE INDEX cases_org_created ON org.cases (org_id, id DESC);
CREATE INDEX cases_property ON org.cases (org_id, property_id) WHERE property_id IS NOT NULL;
CREATE INDEX cases_rental_unit ON org.cases (org_id, rental_unit_id) WHERE rental_unit_id IS NOT NULL;

-- 2. org.contracts 加 case_id ----------------------------------------------------
-- 可為空：遷移前的合約、執業主體組織的合約（MIL-116 接手）、委託管理合約（MIL-74、MIL-119）沒有租賃案件。
-- 與 cases.current_contract_id 互相參照：先建案件、再建合約、最後回填 current_contract_id，三個語句在同一交易。
ALTER TABLE org.contracts ADD COLUMN case_id text;
ALTER TABLE org.contracts ADD FOREIGN KEY (org_id, case_id) REFERENCES org.cases (org_id, id);
CREATE INDEX contracts_case ON org.contracts (org_id, case_id) WHERE case_id IS NOT NULL;

-- 草稿合約被刪除時，案件的目前合約清成 NULL（欄位清單形式只清這一欄，org_id 不動）。
ALTER TABLE org.cases ADD FOREIGN KEY (org_id, current_contract_id) REFERENCES org.contracts (org_id, id)
  ON DELETE SET NULL (current_contract_id);

-- 3. org.case_members：案件成員 -------------------------------------------------
-- valid_period 是成員關係有效的區間。結案不結束它（ADR-0016 決議 15，唯讀由 authorize() 依案件狀態判斷）；
-- 委託終止或移交生效時由系統關閉受託人的列（MIL-119）。
CREATE TABLE org.case_members (
  id           text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id       text NOT NULL REFERENCES control.orgs (id),
  case_id      text NOT NULL,
  -- parties 是全域表，承租人跨組織（0040）。成員用 party，不用帳號：承租人登入前就可以是成員
  party_id     text NOT NULL REFERENCES control.parties (id),
  relation     text NOT NULL CHECK (relation IN ('lessor', 'lessee', 'co_lessee', 'mandator', 'mandatary', 'owner', 'practitioner', 'broker')),
  valid_period tstzrange NOT NULL DEFAULT tstzrange(now(), NULL, '[)'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, case_id) REFERENCES org.cases (org_id, id),
  CHECK (NOT isempty(valid_period) AND NOT lower_inf(valid_period))
);

-- 同一人在同一案件的同一關係，同時間只有一列有效。關閉後可以再加入
CREATE UNIQUE INDEX case_members_active_unique ON org.case_members (org_id, case_id, party_id, relation)
  WHERE upper_inf(valid_period);
CREATE INDEX case_members_case_party ON org.case_members (case_id, party_id);
CREATE INDEX case_members_party ON org.case_members (party_id);

-- 4. org.case_events：案件事件 ---------------------------------------------------
-- 只記案件的轉移與案件層動作，不抄合約歷程（ADR-0016 決議 2）。append-only，資料庫層用 trigger 擋下（照 0009）。
-- type 的清單與 src/lib/cases/transitions.ts 的 CASE_EVENT_TYPES 一致，case-schema.test.ts 逐一驗證。
CREATE TABLE org.case_events (
  id             text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  org_id         text NOT NULL REFERENCES control.orgs (id),
  case_id        text NOT NULL,
  type           text NOT NULL CHECK (type IN (
                   'created', 'succeeded', 'migrated', 'input_rejected',
                   'contract_sent', 'contract_completed', 'contract_declined', 'contract_voided',
                   'aborted', 'move_out_started', 'move_out_cancelled', 'move_out_inspection_completed',
                   'advanced_after_notice', 'closed', 'paper_contract_registered', 'terminated', 'expired',
                   'handed_over', 'member_added', 'contract_attached')),
  from_state     text,
  to_state       text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  -- 行為者。NULL 是系統（遷移、worker、簽署事件）。payload 不放個資，只放 ID
  actor_party_id text REFERENCES control.parties (id),
  occurred_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, case_id) REFERENCES org.cases (org_id, id)
);

CREATE INDEX case_events_by_case ON org.case_events (org_id, case_id, id);

CREATE FUNCTION org.case_events_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '案件事件寫入後不得修改或刪除';
END;
$$;

CREATE TRIGGER case_events_immutable
  BEFORE UPDATE ON org.case_events
  FOR EACH ROW EXECUTE FUNCTION org.case_events_guard();

CREATE TRIGGER case_events_no_delete
  BEFORE DELETE ON org.case_events
  FOR EACH ROW EXECUTE FUNCTION org.case_events_guard();

-- 5. 成員讀取：目前身分在這個案件有效的關係 -------------------------------------------
-- 成員政策要問「我在這個案件有哪些關係」，答案在 case_members，而 case_members 自己的政策也要問同一件事。
-- PostgreSQL 會在政策直接引用自己的表時報無限遞迴，所以包成函式。函式是 INVOKER：用目前請求的身分查，
-- 受 case_members 的 org_isolation 與 self_read 限制，只會看到自己的列。不用 SECURITY DEFINER：
-- FORCE 下函式擁有者也受 RLS 限制（ADR-0012 決議 5 實測），定義者函式沒有任何好處。
-- 執行期的遞迴由 app.in_member_lookup 擋：函式內查 case_members 時，peer_read 政策會再呼叫函式，那一層回空陣列。
-- 時間用資料庫的 now()：政策不能收參數。
CREATE FUNCTION org.case_relations_of_current_party(p_case_id text) RETURNS text[]
LANGUAGE plpgsql
VOLATILE
SET search_path = org, pg_temp
AS $$
DECLARE
  previous text := coalesce(current_setting('app.in_member_lookup', true), '');
  result   text[];
BEGIN
  IF previous = '1' OR coalesce(current_setting('app.party_id', true), '') = '' THEN
    RETURN ARRAY[]::text[];
  END IF;
  PERFORM set_config('app.in_member_lookup', '1', true);
  SELECT coalesce(array_agg(m.relation), ARRAY[]::text[]) INTO result
    FROM org.case_members m
   WHERE m.case_id = p_case_id
     AND m.party_id = current_setting('app.party_id', true)
     AND m.valid_period @> now();
  PERFORM set_config('app.in_member_lookup', previous, true);
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION org.case_relations_of_current_party(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org.case_relations_of_current_party(text) TO app_rw;

-- 6. RLS 與讀取政策 ---------------------------------------------------------------
-- 每張案件範圍表必須列出可讀的關係（ADR-0016 決議 15）。清單在 src/lib/pg/rls-cases.ts 的 CASE_SCOPED_READS，
-- 這裡的政策與它一致，case-rls.test.ts 逐表、逐關係驗證。
--
--   cases           8 種關係全部
--   case_members    lessor、mandator、mandatary 讀整個案件的成員；其他關係只讀自己的列（self_read，ADR-0012 決議 7）
--   case_events     lessor、mandator、mandatary
--   contracts       lessor、lessee、co_lessee、practitioner、broker、mandator、mandatary（owner 讀不到，P0-09 AC5）
--   sign_tasks      lessor、mandator、mandatary（簽署任務，MIL-94 的總覽需求）
--   signers         同 sign_tasks
-- 成員政策只開 SELECT。寫入一律經 org_isolation，成員跨組織的寫入走 withCaseMemberTx（ADR-0016 決議 16）。
ALTER TABLE org.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.cases FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.cases
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
CREATE POLICY member_read ON org.cases FOR SELECT
  USING (org.case_relations_of_current_party(id)
         && ARRAY['lessor', 'lessee', 'co_lessee', 'mandator', 'mandatary', 'owner', 'practitioner', 'broker']);

ALTER TABLE org.case_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.case_members FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.case_members
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
CREATE POLICY self_read ON org.case_members FOR SELECT
  USING (party_id = current_setting('app.party_id', true));
CREATE POLICY peer_read ON org.case_members FOR SELECT
  USING (org.case_relations_of_current_party(case_id) && ARRAY['lessor', 'mandator', 'mandatary']);

ALTER TABLE org.case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.case_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org.case_events
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));
CREATE POLICY member_read ON org.case_events FOR SELECT
  USING (org.case_relations_of_current_party(case_id) && ARRAY['lessor', 'mandator', 'mandatary']);

CREATE POLICY member_read ON org.contracts FOR SELECT
  USING (case_id IS NOT NULL
         AND org.case_relations_of_current_party(case_id)
             && ARRAY['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker', 'mandator', 'mandatary']);

CREATE POLICY member_read ON org.sign_tasks FOR SELECT
  USING (subject_type = 'contract'
         AND EXISTS (SELECT 1 FROM org.contracts c
                      WHERE c.id = sign_tasks.subject_id
                        AND c.case_id IS NOT NULL
                        AND org.case_relations_of_current_party(c.case_id) && ARRAY['lessor', 'mandator', 'mandatary']));

CREATE POLICY member_read ON org.signers FOR SELECT
  USING (EXISTS (SELECT 1 FROM org.sign_tasks t WHERE t.id = signers.sign_task_id));
