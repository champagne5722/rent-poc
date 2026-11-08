-- control.orgs 與種子組織（MIL-79，ADR-0012 決議 3、ADR-0022 決議 4）。
-- control 不掛組織 RLS，權限逐表授予。

CREATE TABLE control.orgs (
  id         text PRIMARY KEY CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  name       text NOT NULL,
  -- 種類只有這三個。C 線的 migration 可再加欄位，不要在這裡加執業主體專屬的必填欄位
  kind       text NOT NULL CHECK (kind IN ('owner', 'practice', 'platform')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 平台組織只有一個
CREATE UNIQUE INDEX orgs_one_platform ON control.orgs (kind) WHERE kind = 'platform';

REVOKE ALL ON control.orgs FROM PUBLIC;
GRANT SELECT ON control.orgs TO app_rw;

-- 種子。ID 固定，讓環境變數與測試能指到同一個組織（時間部分全 0，排序在所有真實 ULID 之前）。
--   平台組織：持有沒有組織脈絡的稽核事件（ADR-0019 決議 2）。
--   預設組織：既有的 demo 資料全掛在這裡（MIL-90），requestContext() 在 C 線完成前回傳它。
--             不寫成執業主體。C 線（MIL-103）用環境變數 SEED_OWNER_EMAIL 指定的帳號當它的 admin，
--             把它轉成屋主組織，只需要 UPDATE 這一列與新增成員，不需要改結構。
INSERT INTO control.orgs (id, name, kind) VALUES
  ('00000000000000000000000001', '平台', 'platform'),
  ('00000000000000000000000002', '預設組織', 'owner')
ON CONFLICT (id) DO NOTHING;
