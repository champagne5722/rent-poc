-- 稽核紀錄（MIL-82，ADR-0019）。每個組織一條 hash chain，只增不改。
-- 由 runner 以 app_owner 執行。audit 的物件要歸 audit_owner，所以先在 app_owner 身分授權 control，
-- 再 SET LOCAL ROLE audit_owner 建表與函式（app_owner 對 audit_owner 有 SET 成員資格，見 0001）。
-- 沒有 BYPASSRLS 的角色擁有這些物件，事件表與鏈頭表都 FORCE RLS，audit_owner 有自己的政策。

-- 1. control：函式要查平台組織（沒有組織脈絡時寫它的鏈）
GRANT USAGE ON SCHEMA control TO audit_owner;
GRANT SELECT ON control.orgs TO audit_owner;

SET LOCAL ROLE audit_owner;

-- 2. 表 -------------------------------------------------------------------
-- 鏈頭：每條鏈一列。app_rw 沒有任何權限，只能經 audit.chain_head() 讀自己那條。
CREATE TABLE audit.chain_heads (
  chain_id   text PRIMARY KEY CHECK (chain_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  seq        bigint NOT NULL CHECK (seq >= 0),
  head_hash  text NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL
);

-- 事件。canonical 是寫入當下由資料庫產生的 JSON 文字，雜湊算在這份文字上，驗證時不重新序列化（ADR-0019 決議 4）。
-- 其他欄位是 canonical 內容的拆欄，供查詢使用。verifyChain 會比對兩者是否一致。
CREATE TABLE audit.events (
  chain_id    text   NOT NULL CHECK (chain_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  seq         bigint NOT NULL CHECK (seq >= 1),
  occurred_at timestamptz NOT NULL,
  actor_type  text   NOT NULL CHECK (actor_type IN ('operator', 'party', 'system', 'break_glass')),
  actor_id    text,
  action      text   NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  object_type text,
  object_id   text,
  payload     jsonb  NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  prev_hash   text   NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash        text   NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  canonical   text   NOT NULL,
  PRIMARY KEY (chain_id, seq)
);

CREATE TYPE audit.event_ref AS (chain_id text, seq bigint, hash text);

-- 3. 禁止修改 -------------------------------------------------------------
-- UPDATE、DELETE、TRUNCATE 一律由觸發器擋下，擁有者 audit_owner 也一樣。
CREATE FUNCTION audit.forbid_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '稽核紀錄只增不改：不得對 % 執行 %', TG_TABLE_NAME, TG_OP;
END
$$;

CREATE TRIGGER events_no_update_delete BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON audit.events
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
-- 鏈頭只允許函式推進序號，不得刪除或清空
CREATE TRIGGER heads_no_delete BEFORE DELETE ON audit.chain_heads
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER heads_no_truncate BEFORE TRUNCATE ON audit.chain_heads
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();

-- 4. RLS ------------------------------------------------------------------
ALTER TABLE audit.events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.events      FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit.chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.chain_heads FORCE  ROW LEVEL SECURITY;

-- 擁有者要有自己的政策，否則 FORCE 之後連 audit.append() 都會被擋。
-- 用 FOR ALL 而不是只開 SELECT 與 INSERT：UPDATE 與 DELETE 要讓列可見，觸發器才會執行並丟出明確的錯誤。
CREATE POLICY owner_all ON audit.events      FOR ALL TO audit_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_all ON audit.chain_heads FOR ALL TO audit_owner USING (true) WITH CHECK (true);
-- 應用程式只讀得到當下組織的鏈。沒有組織脈絡時 current_setting 回傳 NULL 或空字串，結果是 0 筆。
CREATE POLICY org_read ON audit.events FOR SELECT TO app_rw
  USING (chain_id = nullif(current_setting('app.org_id', true), ''));

-- 5. 函式 -----------------------------------------------------------------
-- 5.1 內部函式（不授權給 app_rw，只被下面的定義者函式呼叫）

-- 當下的鏈：app.org_id 決定。沒有組織脈絡（未設定或空字串）時是平台組織。
CREATE FUNCTION audit.current_chain() RETURNS text
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_chain text := nullif(current_setting('app.org_id', true), '');
BEGIN
  IF v_chain IS NULL THEN
    SELECT o.id INTO v_chain FROM control.orgs o WHERE o.kind = 'platform';
    IF v_chain IS NULL THEN
      RAISE EXCEPTION '找不到平台組織，無法決定稽核鏈';
    END IF;
  END IF;
  RETURN v_chain;
END
$$;

-- 寫一筆事件。鎖住鏈頭到提交為止，同一條鏈的寫入在這裡排隊。交易回滾時鏈頭一併回滾，序號不推進。
CREATE FUNCTION audit.write_event(
  p_chain text, p_actor_type text, p_actor_id text, p_action text,
  p_object_type text, p_object_id text, p_payload jsonb
) RETURNS audit.event_ref
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_head      audit.chain_heads;
  v_seq       bigint;
  v_at        timestamptz;
  v_canonical text;
  v_hash      text;
BEGIN
  -- 第一次寫入時建立鏈頭。兩個交易同時建，後到的在這裡等前一個提交或回滾
  INSERT INTO audit.chain_heads (chain_id, seq, head_hash, updated_at)
  VALUES (p_chain, 0, repeat('0', 64), clock_timestamp())
  ON CONFLICT (chain_id) DO NOTHING;

  SELECT h.* INTO v_head FROM audit.chain_heads h WHERE h.chain_id = p_chain FOR UPDATE;

  v_seq := v_head.seq + 1;
  -- 鎖到手之後才取時間，同一條鏈上的時間不會倒退
  v_at := clock_timestamp();

  -- 時間固定輸出成 UTC，格式與 session 時區無關。canonical 是文字，寫入後不重新序列化。
  v_canonical := json_build_object(
    'v', 1,
    'chain', p_chain,
    'seq', v_seq,
    'at', to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor', json_build_object('type', p_actor_type, 'id', p_actor_id),
    'action', p_action,
    'object', json_build_object('type', p_object_type, 'id', p_object_id),
    'payload', p_payload
  )::text;

  v_hash := encode(sha256(convert_to(v_head.head_hash || v_canonical, 'UTF8')), 'hex');

  INSERT INTO audit.events (
    chain_id, seq, occurred_at, actor_type, actor_id, action, object_type, object_id,
    payload, prev_hash, hash, canonical
  ) VALUES (
    p_chain, v_seq, v_at, p_actor_type, p_actor_id, p_action, p_object_type, p_object_id,
    p_payload, v_head.head_hash, v_hash, v_canonical
  );

  UPDATE audit.chain_heads
     SET seq = v_seq, head_hash = v_hash, updated_at = v_at
   WHERE chain_id = p_chain;

  RETURN ROW(p_chain, v_seq, v_hash)::audit.event_ref;
END
$$;

-- 5.2 對外函式（定義者權限，owner 是 audit_owner）

-- 各模組寫稽核事件的唯一入口。鏈由 app.org_id 決定，沒有參數可以指定。
-- 行為者預設從交易脈絡取：有 app.operator_id 是營運者，有 app.party_id 是使用者，否則是系統。
-- 登入前的動作（例如承租人登入）脈絡裡沒有行為者，呼叫端可以明確指定。
CREATE FUNCTION audit.append(
  p_action      text,
  p_object_type text  DEFAULT NULL,
  p_object_id   text  DEFAULT NULL,
  p_payload     jsonb DEFAULT '{}'::jsonb,
  p_actor_type  text  DEFAULT NULL,
  p_actor_id    text  DEFAULT NULL
) RETURNS audit.event_ref
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_operator text := nullif(current_setting('app.operator_id', true), '');
  v_party    text := nullif(current_setting('app.party_id', true), '');
  v_type     text := p_actor_type;
  v_id       text := p_actor_id;
BEGIN
  IF v_type IS NULL THEN
    IF v_operator IS NOT NULL THEN
      v_type := 'operator'; v_id := v_operator;
    ELSIF v_party IS NOT NULL THEN
      v_type := 'party'; v_id := v_party;
    ELSE
      v_type := 'system'; v_id := NULL;
    END IF;
  END IF;
  RETURN audit.write_event(audit.current_chain(), v_type, v_id, p_action, p_object_type, p_object_id, p_payload);
END
$$;

-- 平台營運者存取組織資料時，由 withTx 的 operator 脈絡在同交易呼叫（P0-23 AC5）。
-- 所有值都讀交易內的設定，呼叫端不能指定，缺任何一個就拒絕。鏈是目標組織。
CREATE FUNCTION audit.record_operator_access() RETURNS audit.event_ref
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org      text := nullif(current_setting('app.org_id', true), '');
  v_operator text := nullif(current_setting('app.operator_id', true), '');
  v_ticket   text := nullif(current_setting('app.ticket_id', true), '');
BEGIN
  IF v_org IS NULL OR v_operator IS NULL OR v_ticket IS NULL THEN
    RAISE EXCEPTION '營運者存取紀錄需要 app.org_id、app.operator_id 與 app.ticket_id';
  END IF;
  RETURN audit.write_event(v_org, 'operator', v_operator, 'operator.access', 'org', v_org,
                           jsonb_build_object('ticket', v_ticket));
END
$$;

-- break-glass 的使用紀錄。只有 break_glass 角色能呼叫，步驟見 docs/deployment.md。
-- 行為者記資料庫的登入身分（session_user），不放姓名或 email。
-- p_org 有值時寫該組織的鏈（組織匯出看得到），否則寫平台鏈。
CREATE FUNCTION audit.record_break_glass(
  p_phase  text,
  p_ticket text,
  p_reason text,
  p_org    text DEFAULT NULL
) RETURNS audit.event_ref
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_chain text;
BEGIN
  IF p_phase NOT IN ('start', 'end') THEN
    RAISE EXCEPTION 'p_phase 必須是 start 或 end';
  END IF;
  IF p_ticket IS NULL OR p_ticket !~ '^[A-Za-z0-9][A-Za-z0-9._:#-]{0,63}$' THEN
    RAISE EXCEPTION 'break-glass 必須帶工單號（字母數字開頭，64 字內）';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'break-glass 必須寫明理由';
  END IF;
  v_chain := coalesce(p_org, (SELECT o.id FROM control.orgs o WHERE o.kind = 'platform'));
  RETURN audit.write_event(v_chain, 'break_glass', session_user::text, 'break_glass.' || p_phase,
                           CASE WHEN p_org IS NULL THEN NULL ELSE 'org' END, p_org,
                           jsonb_build_object('ticket', p_ticket, 'reason', p_reason));
END
$$;

-- 讀自己那條鏈的鏈頭，供 verifyChain 比對。沒有這條鏈時回傳 0 列。
CREATE FUNCTION audit.chain_head() RETURNS SETOF audit.event_ref
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT h.chain_id, h.seq, h.head_hash FROM audit.chain_heads h WHERE h.chain_id = audit.current_chain()
$$;

-- 6. 權限 -----------------------------------------------------------------
REVOKE ALL ON audit.events, audit.chain_heads FROM PUBLIC;
GRANT SELECT ON audit.events TO app_rw;     -- 寫入只能經 audit.append()，鏈頭表 app_rw 沒有權限

REVOKE ALL ON FUNCTION
  audit.forbid_change(), audit.current_chain(),
  audit.write_event(text, text, text, text, text, text, jsonb),
  audit.append(text, text, text, jsonb, text, text),
  audit.record_operator_access(), audit.record_break_glass(text, text, text, text), audit.chain_head()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  audit.append(text, text, text, jsonb, text, text),
  audit.record_operator_access(),
  audit.chain_head()
  TO app_rw;

GRANT USAGE ON SCHEMA audit TO break_glass;
GRANT EXECUTE ON FUNCTION audit.record_break_glass(text, text, text, text) TO break_glass;
