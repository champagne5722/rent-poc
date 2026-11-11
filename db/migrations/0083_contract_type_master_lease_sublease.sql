-- 合約類型加入包租與轉租（MIL-199，ADR-0030 決議 6）。由 runner 以 app_owner 執行。
--
-- 合約類型從兩種（lease、management）變成四種：
--   lease          住宅租賃契約
--   management     委託管理租賃住宅契約書
--   master_lease   住宅包租契約（屋主租給包租業者那一份），與案件種類 master_lease 同名同義
--   sublease       住宅轉租契約（包租業者租給承租人那一份），與案件種類 sublease 同名同義
-- 注意：舊業務類型（business_type）的 master_lease 指轉租，與這裡的 master_lease 相反。
--
-- 只放寬 CHECK，不改任何既有資料列。不回填：既有的包租與轉租合約仍是 lease，既有草稿照常開啟與送簽。
-- 欄位預設值仍是 lease。新的類型只由建立合約的程式寫入（contractTypeForCaseKind）。

ALTER TABLE org.contracts DROP CONSTRAINT contracts_contract_type_check;

ALTER TABLE org.contracts
  ADD CONSTRAINT contracts_contract_type_check
  CHECK (contract_type IN ('lease', 'management', 'master_lease', 'sublease'));
