-- 收款帳戶持有人的外鍵（MIL-187，補 MIL-118 的 0052）。
-- 由 runner 以 app_owner 執行。
--
-- 0052 的 holder_party_id 沒有外鍵，因為當時 control.parties 還沒有（C 線 0040 之後才有）。
-- 入帳確認（MIL-125）要用持有人判定押金規則，持有人指到不存在的 party 時判定結果不可靠。
--
-- 這個 migration 只用 ADD CONSTRAINT，不修改任何既有列。檔名接在全域最大號之後：runner 依檔名排序，
-- 已套用到 0073 的資料庫再加一個較小的編號，順序會回頭，所以不用 E 線區段的 0057。
--
-- 既有列指到不存在的 party 時，migration 失敗並說明，不靜默刪除或改寫。
-- 處理方式由人決定：把該列的持有人改成真實的 party，或把該帳戶停用後另行處理。
--
-- org.payment_accounts 是 FORCE RLS，沒有組織脈絡的 app_owner 讀不到任何列。
-- 而且 ADD CONSTRAINT 自己的驗證查詢也受 FORCE RLS 影響：它只看得到脈絡內的列，所以孤兒列會被靜默放行。
-- 因此先逐一設定每個組織的脈絡，用 RLS 允許的方式找孤兒列，找到就失敗。
-- control.parties 不掛 RLS，之後的外鍵檢查也不受組織脈絡影響
-- （org.case_members、org.case_events 對 control.parties 的外鍵是前例）。

DO $$
DECLARE
  prev_org  text := coalesce(current_setting('app.org_id', true), '');
  one_org   record;
  org_count integer;
  org_ids   text[];
  total     integer := 0;
  ids       text[] := ARRAY[]::text[];
BEGIN
  FOR one_org IN SELECT id FROM control.orgs ORDER BY id LOOP
    PERFORM set_config('app.org_id', one_org.id, true);
    SELECT count(*), coalesce((array_agg(a.id ORDER BY a.id))[1:20], ARRAY[]::text[])
      INTO org_count, org_ids
      FROM org.payment_accounts a
     WHERE a.holder_party_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM control.parties p WHERE p.id = a.holder_party_id);
    total := total + org_count;
    ids := ids || org_ids;
  END LOOP;
  PERFORM set_config('app.org_id', prev_org, true);

  IF total > 0 THEN
    RAISE EXCEPTION
      '收款帳戶的持有人指到不存在的 party，共 % 列（最多列出 20 個帳戶 ID：%）。請先修正這些列的 holder_party_id，再套用此 migration。migration 不會刪除或改寫它們。',
      total, array_to_string(ids[1:20], '、');
  END IF;
END
$$;

ALTER TABLE org.payment_accounts
  ADD CONSTRAINT payment_accounts_holder_party_fk
  FOREIGN KEY (holder_party_id) REFERENCES control.parties (id);
