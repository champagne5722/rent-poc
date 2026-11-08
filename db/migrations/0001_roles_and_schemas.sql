-- 角色、五區 schema 與權限骨架（MIL-79，ADR-0012 決議 3、4）。
-- 由管理者身分執行（PGlite 的 postgres、CI 容器的 postgres、Cloud SQL 的 postgres）。
-- 之後的 migration 由 runner 以 runAs=app_owner 執行，物件自動歸 app_owner。
--
-- 角色不設密碼。需要登入的角色（app_owner、app_rw）由維運人員用 ALTER ROLE ... PASSWORD 設定。
-- 沒有任何角色加 BYPASSRLS，break_glass 例外，見下方。

-- 1. 角色 -----------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner LOGIN;   -- CI 與部署用它跑 migration，應用程式不得持有
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw LOGIN;      -- 應用程式與 worker
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_owner') THEN
    CREATE ROLE audit_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vault_owner') THEN
    CREATE ROLE vault_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'break_glass') THEN
    -- 只有 superuser 能建立 BYPASSRLS 角色。Cloud SQL 的 postgres 不是 superuser，
    -- 所以那裡的 break_glass 沒有 BYPASSRLS，替代做法由 MIL-89 與 MIL-92 決定。
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      CREATE ROLE break_glass NOLOGIN BYPASSRLS;
    ELSE
      RAISE NOTICE 'break_glass 沒有 BYPASSRLS：目前身分 % 不是 superuser', current_user;
      CREATE ROLE break_glass NOLOGIN;
    END IF;
  END IF;

  -- 角色若先被手動建立，確認它沒有多餘的權力（陷阱 1）
  IF EXISTS (
    SELECT FROM pg_roles
     WHERE rolname IN ('app_owner', 'app_rw', 'audit_owner', 'vault_owner')
       AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)
  ) THEN
    RAISE EXCEPTION 'app_owner、app_rw、audit_owner、vault_owner 不得有 SUPERUSER、BYPASSRLS、CREATEROLE、CREATEDB';
  END IF;
END
$$;

-- 非 superuser 的管理者（Cloud SQL 的 postgres）要先成為這些角色的成員，才能指定擁有者與設預設權限
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT app_owner, audit_owner, vault_owner TO %I WITH INHERIT FALSE, SET TRUE', current_user);
  END IF;
END
$$;

-- app_owner 要能 SET ROLE 成 audit_owner 與 vault_owner，MIL-82 等票的 migration 才建得出 audit、vault 的函式
GRANT audit_owner, vault_owner TO app_owner WITH INHERIT FALSE, SET TRUE;

-- 2. schema ---------------------------------------------------------------
-- control 在 runner 啟動時已建立（schema_migrations 放在裡面），這裡改擁有者
ALTER SCHEMA control OWNER TO app_owner;
ALTER TABLE control.schema_migrations OWNER TO app_owner;
CREATE SCHEMA org      AUTHORIZATION app_owner;
CREATE SCHEMA registry AUTHORIZATION app_owner;
CREATE SCHEMA audit    AUTHORIZATION audit_owner;
CREATE SCHEMA vault    AUTHORIZATION vault_owner;

-- 3. 權限 -----------------------------------------------------------------
-- app_rw 對五區都有 USAGE，才解析得到函式名稱。表的權限各區不同，見下。
GRANT USAGE ON SCHEMA org, registry, audit, vault, control TO app_rw;

-- control.schema_migrations 只給 app_owner
REVOKE ALL ON control.schema_migrations FROM PUBLIC, app_rw;

-- org：每張表都掛 RLS，所以 app_rw 預設有 DML，隔離靠 RLS 政策
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA org
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;

-- control、registry、audit、vault：新表沒有任何預設權限。
-- 每張表的建立者（含其他線的 migration）自己 REVOKE 與 GRANT，逐表授予。

-- 函式預設不開放給 PUBLIC。SECURITY DEFINER 函式要明確 GRANT EXECUTE 給 app_rw
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner   REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE audit_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE vault_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- public schema 不給任何人建物件
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
