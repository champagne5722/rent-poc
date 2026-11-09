-- 接上案件之二：鏡像帳掛上 cases（MIL-123，ADR-0015 決議 12，ADR-0050 決議 2）。
-- 由 runner 以 app_owner 執行。0050 把 case_id 先存成文字，這裡用 ADD CONSTRAINT 補複合外鍵，並加案件成員的讀取政策。
--
-- ADD CONSTRAINT 不改既有列，所以不違反只增不改（ADR-0050 決議 2）。
-- 外鍵用 NOT VALID：只檢查之後新寫入的分錄，不回頭檢查既有列。0050 到 0055 之間寫入的分錄只有測試資料，
-- 但 demo 資料庫若留有用任意文字當 case_id 的列，驗證式的外鍵會讓 migration 失敗而擋住部署。
-- 新分錄一律受外鍵保護：寫入時案件必須存在，且屬於同一個組織。

-- 1. 複合外鍵 ----------------------------------------------------------------------------
ALTER TABLE org.ledger_journals
  ADD CONSTRAINT ledger_journals_case_fk
  FOREIGN KEY (org_id, case_id) REFERENCES org.cases (org_id, id) NOT VALID;

-- 2. 案件成員的讀取政策 ----------------------------------------------------------------------
-- 與動作表的 ledger.read 一致：出租人（代管案件是屋主）、承租人、共同承租人。
-- 政策只開 SELECT。寫入一律經 ledger 模組的 org_isolation_insert，成員不能寫。
-- 兩張表各自加政策，不經 view：政策直接掛在表上，security_invoker 的 view 才會繼承它。
CREATE POLICY member_read ON org.ledger_journals FOR SELECT TO app_rw
  USING (org.case_relations_of_current_party(case_id) && ARRAY['lessor', 'lessee', 'co_lessee']);
CREATE POLICY member_read ON org.ledger_entries FOR SELECT TO app_rw
  USING (org.case_relations_of_current_party(case_id) && ARRAY['lessor', 'lessee', 'co_lessee']);

-- 3. 押金餘額 view ---------------------------------------------------------------------------
-- 餘額一律由 liability.deposit.{case} 即時加總（ADR-0015 決議 6）。view 設 security_invoker = true（決議 12）：
-- 以呼叫者的身分讀 ledger_entries，所以主辦組織與案件成員各自只看得到自己能讀的列。
-- 不設的話 view 以擁有者的身分讀表，FORCE RLS 下擁有者雖受限，但成員政策會失效，行為難以預期。
CREATE VIEW org.deposit_balances WITH (security_invoker = true) AS
SELECT org_id,
       case_id,
       sum(credit - debit)::bigint AS balance
  FROM org.ledger_entries
 WHERE account = 'liability.deposit.' || case_id
 GROUP BY org_id, case_id;

REVOKE ALL ON org.deposit_balances FROM PUBLIC;
GRANT SELECT ON org.deposit_balances TO app_rw;
