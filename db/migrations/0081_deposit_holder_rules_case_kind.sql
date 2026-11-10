-- 押金帳戶規則改看案件種類（MIL-198，ADR-0030 決議 2、3）。
-- 由 runner 以 app_owner 執行。規則的內容不變，只換判斷的依據：
--
--   DHR-01 到 DHR-03：業務類型代管，改成「租賃案件，業務類型代管」。
--   DHR-04：業務類型 master_lease（舊值，指轉租），改成「轉租案件」，業務類型不限。
--   DHR-05：萬用列，不變。
--
-- 包租案件（案件種類 master_lease）在資料上是自管租賃，原本就走萬用列 DHR-05，沿用自管的規則，待法務確認。
-- 列的 (rule_id, version) 不變：這不是修法，是同一條規則換了寫法，所以不新增版本。
-- 持有人確認紀錄指向的 (rule_id, version) 仍找得到同一條規則，評估結果與 ruleId、ruleVersion 都和改之前相同。
-- 欄位 business_type 的 CHECK 仍允許舊值，資料庫的舊值不動，移除舊值屬 MIL-203。
-- 內容與 src/lib/deposit-rules 的 DEPOSIT_HOLDER_RULES 一致，由 holder-rules-store.test.ts 逐欄比對。

ALTER TABLE control.deposit_holder_rules
  ADD COLUMN case_kind text CHECK (case_kind IN ('lease', 'management', 'master_lease', 'sublease'));

UPDATE control.deposit_holder_rules
   SET case_kind = 'lease'
 WHERE business_type = 'managed';

UPDATE control.deposit_holder_rules
   SET case_kind = 'sublease', business_type = NULL
 WHERE business_type = 'master_lease';
