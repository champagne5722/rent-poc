-- 系統目錄檢查找到的機械式違規（MIL-89）。由 runner 以 app_owner 執行。
-- 檢查在 src/lib/pg/rls-catalog-kit.ts，跑在 PGlite 與真實 PostgreSQL。
--
-- 違規：org.deposit_balances 是 view，app_rw 卻有 INSERT、UPDATE、DELETE。
-- 原因：0001 對 org schema 設了預設權限，app_owner 之後建的每個物件都自動給 app_rw 四種 DML。
-- 0056 只授予 SELECT，沒有撤除預設給的三種。
-- 影響：這個 view 含 GROUP BY，不是可更新的 view，所以 DML 本來就會被資料庫拒絕。
-- 但 view 只該有 SELECT，之後有人改成可更新時不能因此多出寫入路徑。
--
-- 沒有改變任何行為：應用程式對這個 view 只做 SELECT。
REVOKE INSERT, UPDATE, DELETE ON org.deposit_balances FROM app_rw;

-- 錨定函式只准沒有組織脈絡的 job 呼叫（MIL-89，MIL-88 的待辦，主控決定採做法 A）。
-- 問題：audit.unanchored_heads() 把所有組織的鏈編號（就是組織編號）、序號與鏈頭雜湊給任何 app_rw 連線，
-- org 脈絡的請求也讀得到別的組織的鏈。record_anchor() 與 record_anchor_failure() 讓任何脈絡寫入錨定紀錄。
-- 做法：三個函式開頭檢查 app.org_id 與 app.party_id 都是空的，不是就丟 42501。
-- anchor-audit job 本來就用 control 脈絡（src/lib/audit/anchor/store.ts），行為不變。
-- chain_anchors() 只回自己的鏈，不受影響。
-- 誰能呼叫：app_rw，而且交易必須是 control 脈絡。回什麼：與原來相同。
-- 這道檢查擋的是應用程式內走錯脈絡的程式碼，不是惡意的 app_rw 連線。惡意連線自己能開 control 脈絡。
-- 隔離到角色層級（專用登入角色與第二個連線池）列在上線前待辦。
SET LOCAL ROLE audit_owner;

CREATE FUNCTION audit.assert_control_context() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.org_id', true), '') <> '' OR coalesce(current_setting('app.party_id', true), '') <> '' THEN
    RAISE EXCEPTION '錨定函式只能在沒有組織脈絡的 control 交易呼叫' USING ERRCODE = '42501';
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION audit.assert_control_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.assert_control_context() TO app_rw;

CREATE OR REPLACE FUNCTION audit.unanchored_heads() RETURNS SETOF audit.event_ref
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM audit.assert_control_context();
  RETURN QUERY
  SELECT h.chain_id, h.seq, h.head_hash
    FROM audit.chain_heads h
   WHERE h.seq > coalesce((SELECT max(l.seq) FROM audit.anchor_leaves l WHERE l.chain_id = h.chain_id), 0)
   ORDER BY h.chain_id;
END
$$;

CREATE OR REPLACE FUNCTION audit.record_anchor_failure(p_at timestamptz, p_error text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM audit.assert_control_context();
  INSERT INTO audit.anchor_runs (ran_at, outcome, error) VALUES (p_at, 'failed', left(coalesce(p_error, ''), 500));
  RETURN (SELECT count(*)::integer FROM audit.anchor_runs r
           WHERE r.outcome = 'failed'
             AND r.run_id > coalesce((SELECT max(s.run_id) FROM audit.anchor_runs s WHERE s.outcome = 'anchored'), 0));
END
$$;

CREATE OR REPLACE FUNCTION audit.record_anchor(
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
  PERFORM audit.assert_control_context();
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
