-- 押金帳戶規則表（MIL-118，ADR-0014 決議 13，ADR-0050 決議 11）。E 線的 migration 從 0050 起。
-- 由 runner 以 app_owner 執行。control 不掛組織 RLS，權限逐表授予（ADR-0012 決議 3）。
--
-- 規則屬平台層級，組織不得覆寫，Phase 1 沒有管理畫面：app_rw 只能 SELECT，修法時由 migration 改列。
-- 修法時新增新版本的列取代舊列：同一個 rule_id 取版本最大的一列（見 src/lib/payment-accounts 的 loadHolderRules）。
-- 舊版本的列保留，持有人確認紀錄的 (rule_id, version) 才找得到當時的規則。
-- 條件欄位為 NULL 表示不限。內容與 src/lib/deposit-rules 的 DEPOSIT_HOLDER_RULES 一致，
-- deposit-holder-rules-table.test.ts 逐欄比對。缺列時 DHR-05 不在，evaluateHolderRule 會回 warn，
-- 但萬用列消失代表 migration 壞了，所以測試檢查 5 列都在。

CREATE TABLE control.deposit_holder_rules (
  rule_id                  text    NOT NULL CHECK (rule_id ~ '^DHR-[0-9]{2,}$'),
  version                  integer NOT NULL CHECK (version >= 1),
  business_type            text    CHECK (business_type IN ('self_managed', 'managed', 'master_lease')),
  social_housing           boolean,
  holder_kind              text    CHECK (holder_kind IN ('lessor', 'owner', 'manager', 'other')),
  mandate_includes_deposit boolean,
  action                   text    NOT NULL CHECK (action IN ('allow', 'warn', 'warn_fix_mandate', 'block')),
  notify_mandator          boolean NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, version)
);

INSERT INTO control.deposit_holder_rules
  (rule_id, version, business_type, social_housing, holder_kind, mandate_includes_deposit, action, notify_mandator)
VALUES
  ('DHR-01', 1, 'managed',      true,  'manager', NULL,  'block',            false),
  ('DHR-02', 1, 'managed',      false, 'manager', true,  'warn',             true),
  ('DHR-03', 1, 'managed',      false, 'manager', false, 'warn_fix_mandate', true),
  ('DHR-04', 1, 'master_lease', false, 'lessor',  NULL,  'allow',            false),
  ('DHR-05', 1, NULL,           NULL,  NULL,      NULL,  'allow',            false);

REVOKE ALL ON control.deposit_holder_rules FROM PUBLIC;
GRANT SELECT ON control.deposit_holder_rules TO app_rw;
