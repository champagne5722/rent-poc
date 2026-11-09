-- 稽核鏈的每日錨定（MIL-88，ADR-0019 決議 7、8、10、13）。
-- 由 runner 以 app_owner 執行。與 0010 相同，用 SET LOCAL ROLE audit_owner 建物件：
-- 沒有 BYPASSRLS 的角色擁有這些表，三張表都 FORCE RLS，audit_owner 有自己的政策。
--
-- 資料模型：
--   anchor_batches  一次錨定一列：樹根、服務商、回執。
--   anchor_leaves   葉：鏈、序號、鏈頭雜湊，加上 Merkle 證明。單一組織只憑自己的葉與證明就能推回樹根，
--                   不需要看到別的組織的葉（ADR-0019 決議 8）。
--   anchor_runs     每次嘗試的結果，用來數「連續失敗」。
-- app_rw 對三張表沒有任何權限，讀寫都只經下面的定義者函式，函式只回傳雜湊與回執，不回傳事件內容。
--
-- 「這條鏈有沒有未錨定的事件」不另存狀態：鏈頭序號大於該鏈最後一片葉的序號，就是未錨定。
-- 錨定失敗時什麼都不寫進葉，下一次排程自然把未錨定的鏈頭一起送出（ADR-0019 決議 10）。

SET LOCAL ROLE audit_owner;

-- 1. 表 -------------------------------------------------------------------
CREATE TABLE audit.anchor_batches (
  batch_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anchored_at timestamptz NOT NULL,                       -- 排程傳入的時間，不讀資料庫時鐘
  provider    text        NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]*$'),
  root        text        NOT NULL CHECK (root ~ '^[0-9a-f]{64}$'),
  receipt     text        NOT NULL CHECK (receipt <> ''), -- base64，內容由服務商決定
  issued_at   timestamptz NOT NULL,                       -- 服務商簽進回執的時間
  leaf_count  integer     NOT NULL CHECK (leaf_count > 0)
);

CREATE TABLE audit.anchor_leaves (
  batch_id  bigint NOT NULL REFERENCES audit.anchor_batches (batch_id),
  chain_id  text   NOT NULL CHECK (chain_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  seq       bigint NOT NULL CHECK (seq >= 1),
  head_hash text   NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  proof     jsonb  NOT NULL CHECK (jsonb_typeof(proof) = 'array'),
  PRIMARY KEY (batch_id, chain_id)
);
CREATE INDEX anchor_leaves_chain_seq ON audit.anchor_leaves (chain_id, seq DESC);

CREATE TABLE audit.anchor_runs (
  run_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at   timestamptz NOT NULL,
  outcome  text        NOT NULL CHECK (outcome IN ('anchored', 'failed')),
  batch_id bigint      REFERENCES audit.anchor_batches (batch_id),
  error    text        CHECK (error IS NULL OR length(error) <= 500),
  CHECK ((outcome = 'anchored') = (batch_id IS NOT NULL))
);

-- 2. 禁止修改 -------------------------------------------------------------
-- 與事件表相同：UPDATE、DELETE、TRUNCATE 一律由觸發器擋下，擁有者 audit_owner 也一樣。
CREATE TRIGGER batches_no_change BEFORE UPDATE OR DELETE ON audit.anchor_batches
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER batches_no_truncate BEFORE TRUNCATE ON audit.anchor_batches
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER leaves_no_change BEFORE UPDATE OR DELETE ON audit.anchor_leaves
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER leaves_no_truncate BEFORE TRUNCATE ON audit.anchor_leaves
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER runs_no_change BEFORE UPDATE OR DELETE ON audit.anchor_runs
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
CREATE TRIGGER runs_no_truncate BEFORE TRUNCATE ON audit.anchor_runs
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();

-- 3. RLS ------------------------------------------------------------------
ALTER TABLE audit.anchor_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.anchor_batches FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit.anchor_leaves  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.anchor_leaves  FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit.anchor_runs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.anchor_runs    FORCE  ROW LEVEL SECURITY;
-- 只有擁有者的政策。app_rw 沒有政策也沒有權限，兩層都擋。
-- 政策名不用 owner_all：0010 的測試以這個名稱斷言事件表與鏈頭表各有一條，新表用別的名稱。
CREATE POLICY anchor_owner_all ON audit.anchor_batches FOR ALL TO audit_owner USING (true) WITH CHECK (true);
CREATE POLICY anchor_owner_all ON audit.anchor_leaves  FOR ALL TO audit_owner USING (true) WITH CHECK (true);
CREATE POLICY anchor_owner_all ON audit.anchor_runs    FOR ALL TO audit_owner USING (true) WITH CHECK (true);

-- 4. 函式（定義者權限，owner 是 audit_owner）---------------------------------

-- 還沒錨定的鏈頭：鏈頭序號大於該鏈最後一片葉的序號（沒有葉則為 0）。跨組織，只回傳鏈、序號、雜湊。
-- 沒有新事件的鏈不會出現。回傳 0 列時，呼叫端不得呼叫外部服務（ADR-0019 決議 7）。
CREATE FUNCTION audit.unanchored_heads() RETURNS SETOF audit.event_ref
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT h.chain_id, h.seq, h.head_hash
    FROM audit.chain_heads h
   WHERE h.seq > coalesce((SELECT max(l.seq) FROM audit.anchor_leaves l WHERE l.chain_id = h.chain_id), 0)
   ORDER BY h.chain_id
$$;

-- 保存一次成功的錨定：批次、葉與證明、一筆成功的執行紀錄。回傳批次編號。
-- p_leaves 是陣列，每個元素 {chain, seq, hash, proof}。
-- 檢查：每片葉必須對得上目前的事件（鏈、序號、雜湊），而且序號必須比該鏈已錨定的更新。
-- 後者擋下兩個排程同時執行：後到的拿到 SQLSTATE AU001，呼叫端當成「已被前一個涵蓋」。
-- 樹根是否等於葉的 Merkle 樹根不在這裡算，由 verify-audit 依證明檢查。
CREATE FUNCTION audit.record_anchor(
  p_at        timestamptz,
  p_provider  text,
  p_root      text,
  p_receipt   text,
  p_issued_at timestamptz,
  p_leaves    jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_batch bigint;
  v_leaf  jsonb;
BEGIN
  IF p_leaves IS NULL OR jsonb_typeof(p_leaves) <> 'array' OR jsonb_array_length(p_leaves) = 0 THEN
    RAISE EXCEPTION '錨定至少要有一片葉';
  END IF;

  -- 兩個錨定同時保存時排隊，後到的在下面的檢查會看到前一個已提交的葉
  PERFORM pg_advisory_xact_lock(hashtextextended('audit.record_anchor', 0));

  FOR v_leaf IN SELECT * FROM jsonb_array_elements(p_leaves) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM audit.events e
       WHERE e.chain_id = v_leaf ->> 'chain'
         AND e.seq = (v_leaf ->> 'seq')::bigint
         AND e.hash = v_leaf ->> 'hash'
    ) THEN
      RAISE EXCEPTION '葉 %:% 對不上任何事件', v_leaf ->> 'chain', v_leaf ->> 'seq' USING ERRCODE = 'AU002';
    END IF;
    IF (v_leaf ->> 'seq')::bigint <= coalesce(
         (SELECT max(l.seq) FROM audit.anchor_leaves l WHERE l.chain_id = v_leaf ->> 'chain'), 0) THEN
      RAISE EXCEPTION '鏈 % 的序號 % 已被較新的錨定涵蓋', v_leaf ->> 'chain', v_leaf ->> 'seq' USING ERRCODE = 'AU001';
    END IF;
  END LOOP;

  INSERT INTO audit.anchor_batches (anchored_at, provider, root, receipt, issued_at, leaf_count)
  VALUES (p_at, p_provider, p_root, p_receipt, p_issued_at, jsonb_array_length(p_leaves))
  RETURNING batch_id INTO v_batch;

  INSERT INTO audit.anchor_leaves (batch_id, chain_id, seq, head_hash, proof)
  SELECT v_batch, l ->> 'chain', (l ->> 'seq')::bigint, l ->> 'hash', l -> 'proof'
    FROM jsonb_array_elements(p_leaves) AS l;

  INSERT INTO audit.anchor_runs (ran_at, outcome, batch_id) VALUES (p_at, 'anchored', v_batch);
  RETURN v_batch;
END
$$;

-- 記一次失敗，回傳目前連續失敗的次數（自上一次成功之後的失敗筆數）。
-- 錯誤文字只存前 500 字。呼叫端不得放事件內容，錨定服務的錯誤訊息裡本來就沒有。
CREATE FUNCTION audit.record_anchor_failure(p_at timestamptz, p_error text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO audit.anchor_runs (ran_at, outcome, error) VALUES (p_at, 'failed', left(coalesce(p_error, ''), 500));
  RETURN (SELECT count(*)::integer FROM audit.anchor_runs r
           WHERE r.outcome = 'failed'
             AND r.run_id > coalesce((SELECT max(s.run_id) FROM audit.anchor_runs s WHERE s.outcome = 'anchored'), 0));
END
$$;

-- 自己這條鏈的所有葉，連同批次的樹根與回執。鏈由 app.org_id 決定，沒有參數。
-- 只回傳雜湊、證明與回執，不回傳事件內容。證明只含兄弟節點的雜湊，看不到別的組織的葉。
CREATE FUNCTION audit.chain_anchors() RETURNS TABLE (
  batch_id    bigint,
  anchored_at timestamptz,
  provider    text,
  root        text,
  receipt     text,
  issued_at   timestamptz,
  seq         bigint,
  head_hash   text,
  proof       jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT b.batch_id, b.anchored_at, b.provider, b.root, b.receipt, b.issued_at, l.seq, l.head_hash, l.proof
    FROM audit.anchor_leaves l
    JOIN audit.anchor_batches b ON b.batch_id = l.batch_id
   WHERE l.chain_id = audit.current_chain()
   ORDER BY b.batch_id
$$;

-- 5. 權限 -----------------------------------------------------------------
REVOKE ALL ON audit.anchor_batches, audit.anchor_leaves, audit.anchor_runs FROM PUBLIC;
REVOKE ALL ON FUNCTION
  audit.unanchored_heads(),
  audit.record_anchor(timestamptz, text, text, text, timestamptz, jsonb),
  audit.record_anchor_failure(timestamptz, text),
  audit.chain_anchors()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  audit.unanchored_heads(),
  audit.record_anchor(timestamptz, text, text, text, timestamptz, jsonb),
  audit.record_anchor_failure(timestamptz, text),
  audit.chain_anchors()
  TO app_rw;
