import {
  AUDIT_TABLES,
  CONTROL_TABLE_EXCEPTIONS,
  CROSS_ORG_UNIQUE_KEY_EXCEPTIONS,
  DEFINER_ONLY_TABLES,
  ORG_TABLE_CASES,
} from './rls-cases';

// 系統目錄檢查（MIL-89，ADR-0012 決議 6、8）。每個函式查系統目錄，回傳違規清單，空陣列代表通過。
// 檢查自己找出所有表、view 與定義者函式，不靠手寫的表名清單。新增的表、view 或函式只要不合規就讓 CI 失敗。
// 同一組檢查跑在兩個地方：PGlite（rls-catalog.test.ts，每次 npm test）與真實 PostgreSQL（rls-catalog.pg.test.ts）。

/** 查詢函式。PGlite 與 pg 都包成這個形狀。 */
export type CatalogQuery = <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

/** 系統自己的 schema，不檢查。 */
const SYSTEM_SCHEMAS = `('pg_catalog', 'information_schema', 'pg_toast')`;
const USER_SCHEMA_FILTER = `n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname NOT LIKE 'pg\\_%'`;

/** 應用程式的角色。它們不得是 superuser，也不得有 BYPASSRLS、CREATEROLE、CREATEDB（陷阱 1）。 */
export const APP_ROLES = ['app_owner', 'app_rw', 'audit_owner', 'vault_owner'] as const;

/** 每個 schema 的表由哪一份登記管。不在這張表內的 schema 有表就是違規。 */
const SCHEMA_REGISTRIES: Record<string, Record<string, unknown>> = {
  org: ORG_TABLE_CASES,
  control: CONTROL_TABLE_EXCEPTIONS,
  registry: DEFINER_ONLY_TABLES,
  vault: DEFINER_ONLY_TABLES,
  audit: AUDIT_TABLES,
};

export async function listTables(q: CatalogQuery): Promise<string[]> {
  const rows = await q<{ name: string }>(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND ${USER_SCHEMA_FILTER} ORDER BY 1`,
  );
  return rows.map((r) => r.name);
}

/** 每張表都在它所屬 schema 的登記裡；登記裡沒有不存在的表；不認得的 schema 有表也算違規。 */
export async function tableRegistrationViolations(q: CatalogQuery): Promise<string[]> {
  const tables = await listTables(q);
  const violations: string[] = [];
  for (const table of tables) {
    const schema = table.split('.')[0];
    const registry = SCHEMA_REGISTRIES[schema];
    if (!registry) violations.push(`${table}：schema ${schema} 沒有對應的登記，新 schema 必須先在 rls-catalog-kit.ts 的 SCHEMA_REGISTRIES 加入`);
    else if (!(table in registry)) violations.push(`${table}：沒有登記在 ${schema} 的清單`);
  }
  const existing = new Set(tables);
  for (const [schema, registry] of Object.entries(SCHEMA_REGISTRIES)) {
    for (const name of Object.keys(registry)) {
      // registry 與 vault 共用 DEFINER_ONLY_TABLES，只檢查名稱屬於這個 schema 的項目
      if (name.startsWith(`${schema}.`) && !existing.has(name)) violations.push(`${name}：登記了不存在的表`);
    }
  }
  return violations;
}

interface RlsRow {
  name: string;
  enabled: boolean;
  forced: boolean;
  policies: number;
  org_id_not_null: boolean | null;
  owner: string;
}

/** org 的每張表：org_id 不得為空、ENABLE 且 FORCE RLS、至少一條政策（陷阱 2）。 */
export async function orgTableRlsViolations(q: CatalogQuery): Promise<string[]> {
  const rows = await q<RlsRow & Record<string, unknown>>(
    `SELECT n.nspname || '.' || c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies,
            (SELECT a.attnotnull FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped) AS org_id_not_null,
            pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'org' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`,
  );
  const violations: string[] = [];
  for (const r of rows) {
    if (!r.enabled) violations.push(`${r.name}：沒有 ENABLE ROW LEVEL SECURITY`);
    if (!r.forced) violations.push(`${r.name}：沒有 FORCE ROW LEVEL SECURITY`);
    if (r.policies === 0) violations.push(`${r.name}：沒有任何政策`);
    if (r.org_id_not_null === null) violations.push(`${r.name}：沒有 org_id 欄位`);
    else if (!r.org_id_not_null) violations.push(`${r.name}：org_id 可為空`);
  }
  return violations;
}

/** audit 的每張表：歸 audit_owner、FORCE RLS，app_rw 的直接權限與登記一致，PUBLIC 沒有權限。 */
export async function auditTableViolations(q: CatalogQuery): Promise<string[]> {
  const rows = await q<RlsRow & Record<string, unknown>>(
    `SELECT n.nspname || '.' || c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
            pg_get_userbyid(c.relowner) AS owner,
            (SELECT array_agg(p ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p
              WHERE has_table_privilege('app_rw', c.oid, p)) AS app_rw,
            EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 0) AS public_grant
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'audit' AND c.relkind IN ('r', 'p') ORDER BY 1`,
  );
  const violations: string[] = [];
  for (const r of rows as Array<RlsRow & { app_rw: string[] | null; public_grant: boolean }>) {
    if (r.owner !== 'audit_owner') violations.push(`${r.name}：擁有者是 ${r.owner}，必須是 audit_owner`);
    if (!r.enabled || !r.forced) violations.push(`${r.name}：必須 ENABLE 且 FORCE ROW LEVEL SECURITY`);
    if (r.public_grant) violations.push(`${r.name}：不得對 PUBLIC 授權`);
    const expected = [...(AUDIT_TABLES[r.name]?.appRw ?? [])].sort();
    const actual = r.app_rw ?? [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      violations.push(`${r.name}：app_rw 的權限是 [${actual.join(', ')}]，登記的是 [${expected.join(', ')}]`);
    }
  }
  return violations;
}

/**
 * 角色檢查（陷阱 1、2）：
 * 1. 應用程式的四個角色不是 superuser，沒有 BYPASSRLS、CREATEROLE、CREATEDB。
 * 2. app_rw 不擁有任何表、view、序列、函式、型別或 schema，也不是任何擁有者角色或 break_glass 的成員。
 * 3. break_glass 不是 superuser，也不能登入。BYPASSRLS 有無都接受：CI 容器上有，Cloud SQL 上沒有（MIL-79）。
 */
export async function roleViolations(q: CatalogQuery): Promise<string[]> {
  const violations: string[] = [];
  const roles = await q<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolcanlogin: boolean }>(
    `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles
      WHERE rolname = ANY($1::text[]) ORDER BY 1`,
    [[...APP_ROLES, 'break_glass']],
  );
  const found = new Set(roles.map((r) => r.rolname));
  for (const name of [...APP_ROLES, 'break_glass']) if (!found.has(name)) violations.push(`角色 ${name} 不存在`);
  for (const r of roles) {
    if (r.rolsuper) violations.push(`角色 ${r.rolname} 是 superuser`);
    if (r.rolname === 'break_glass') {
      if (r.rolcanlogin) violations.push('角色 break_glass 可以登入');
      continue;
    }
    if (r.rolbypassrls) violations.push(`角色 ${r.rolname} 有 BYPASSRLS`);
    if (r.rolcreaterole) violations.push(`角色 ${r.rolname} 有 CREATEROLE`);
    if (r.rolcreatedb) violations.push(`角色 ${r.rolname} 有 CREATEDB`);
  }

  if (found.has('app_rw')) {
    const owned = await q<{ what: string }>(
      `SELECT 'class ' || n.nspname || '.' || c.relname || '（' || c.relkind::text || '）' AS what
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relowner = 'app_rw'::regrole
       UNION ALL SELECT 'function ' || n.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proowner = 'app_rw'::regrole
       UNION ALL SELECT 'schema ' || nspname FROM pg_namespace WHERE nspowner = 'app_rw'::regrole
       UNION ALL SELECT 'type ' || n.nspname || '.' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE t.typowner = 'app_rw'::regrole AND t.typtype <> 'c' AND t.typelem = 0`,
    );
    for (const o of owned) violations.push(`app_rw 擁有 ${o.what}`);
    const memberships = await q<{ role: string }>(
      `SELECT r.rolname AS role FROM pg_roles r
        WHERE r.rolname <> 'app_rw' AND pg_has_role('app_rw', r.oid, 'MEMBER')
          AND (r.rolname = ANY($1::text[]) OR r.rolsuper OR r.rolbypassrls OR r.rolname = 'break_glass')`,
      [[...APP_ROLES, 'break_glass']],
    );
    for (const m of memberships) violations.push(`app_rw 是角色 ${m.role} 的成員`);
  }
  return violations;
}

/** 所有 view 都設 security_invoker = true（陷阱 4），不用 materialized view（它不受 RLS 約束），app_rw 對 view 只有 SELECT。 */
export async function viewViolations(q: CatalogQuery): Promise<string[]> {
  const rows = await q<{ name: string; kind: string; invoker: boolean; extra: string[] | null }>(
    `SELECT n.nspname || '.' || c.relname AS name, c.relkind AS kind,
            coalesce(c.reloptions::text[] @> ARRAY['security_invoker=true'] OR c.reloptions::text[] @> ARRAY['security_invoker=on'], false) AS invoker,
            (SELECT array_agg(p ORDER BY p) FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p
              WHERE has_table_privilege('app_rw', c.oid, p)) AS extra
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('v', 'm') AND ${USER_SCHEMA_FILTER} ORDER BY 1`,
  );
  const violations: string[] = [];
  for (const r of rows) {
    if (r.kind === 'm') violations.push(`${r.name}：materialized view 不受 RLS 約束，不得使用`);
    else if (!r.invoker) violations.push(`${r.name}：沒有 security_invoker = true`);
    if (r.extra && r.extra.length > 0) violations.push(`${r.name}：app_rw 對 view 多了 ${r.extra.join('、')} 權限，只該有 SELECT`);
  }
  return violations;
}

/**
 * 外鍵穿透（陷阱 5）：凡是參照 org 表的外鍵，被參照欄位與參照欄位都必須含 org_id，而且位置相同。
 * 單欄外鍵會讓別的組織用 ID 探測某一列是否存在（RLS 不約束外鍵檢查）。
 */
export async function foreignKeyViolations(q: CatalogQuery): Promise<string[]> {
  const rows = await q<{ child: string; name: string; child_cols: string[]; parent: string; parent_cols: string[] }>(
    `SELECT con.conrelid::regclass::text AS child, con.conname AS name, con.confrelid::regclass::text AS parent,
            (SELECT array_agg(a.attname::text ORDER BY u.ord) FROM unnest(con.conkey) WITH ORDINALITY u(k, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.k) AS child_cols,
            (SELECT array_agg(a.attname::text ORDER BY u.ord) FROM unnest(con.confkey) WITH ORDINALITY u(k, ord)
               JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = u.k) AS parent_cols
       FROM pg_constraint con
       JOIN pg_class pc ON pc.oid = con.confrelid JOIN pg_namespace pn ON pn.oid = pc.relnamespace
      WHERE con.contype = 'f' AND pn.nspname = 'org' ORDER BY 1, 2`,
  );
  const violations: string[] = [];
  for (const r of rows) {
    const at = r.parent_cols.indexOf('org_id');
    if (at === -1 || r.child_cols[at] !== 'org_id') {
      violations.push(`${r.child} 的外鍵 ${r.name}（${r.child_cols.join(', ')}）→ ${r.parent}（${r.parent_cols.join(', ')}）沒有成對的 org_id`);
    }
  }
  return violations;
}

/**
 * 唯一鍵穿透（陷阱 6）：org 表的主鍵必須是 (id) 或含 org_id（id 是 ULID，由應用程式產生）。
 * 其他唯一索引（含部分唯一索引）必須含 org_id，除非登記在 CROSS_ORG_UNIQUE_KEY_EXCEPTIONS。
 * registry、control、vault、audit 不是 org 表，不在這裡檢查。
 */
export async function uniqueKeyViolations(q: CatalogQuery): Promise<string[]> {
  const rows = await q<{ table: string; index: string; is_primary: boolean; cols: string[]; def: string }>(
    `SELECT n.nspname || '.' || c.relname AS "table", n.nspname || '.' || ic.relname AS "index", i.indisprimary AS is_primary,
            (SELECT array_agg(a.attname::text ORDER BY u.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY u(k, ord)
               JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.k) AS cols,
            pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'org' AND i.indisunique AND c.relkind IN ('r', 'p') ORDER BY 1, 2`,
  );
  const violations: string[] = [];
  for (const r of rows) {
    // 運算式索引的欄位清單不含欄位名，從索引定義判斷
    const hasOrgId = r.cols.includes('org_id') || /\(\s*org_id\b|,\s*org_id\b/.test(r.def);
    if (hasOrgId) continue;
    if (r.is_primary && r.cols.length === 1 && r.cols[0] === 'id') continue;
    if (CROSS_ORG_UNIQUE_KEY_EXCEPTIONS[r.index]?.scope === 'index') continue;
    violations.push(`${r.table} 的${r.is_primary ? '主鍵' : '唯一索引'} ${r.index}（${r.cols.join(', ')}）不含 org_id`);
  }
  const existing = new Set(rows.map((r) => r.index));
  for (const [name, exception] of Object.entries(CROSS_ORG_UNIQUE_KEY_EXCEPTIONS)) {
    if (exception.scope === 'index' && !existing.has(name)) violations.push(`${name}：例外清單登記了不存在的索引`);
    if (exception.scope === 'schema' && !(name in SCHEMA_REGISTRIES)) violations.push(`${name}：例外清單登記了不存在的 schema`);
  }
  return violations;
}

/**
 * 定義者函式（ADR-0012 決議 8）：所有 SECURITY DEFINER 函式，不分 schema。
 * 1. 固定 search_path，而且路徑只含 pg_catalog、自己的 schema 與 pg_temp，pg_temp 排最後。
 * 2. PUBLIC 不能執行。
 * 3. 擁有者不是 superuser，也沒有 BYPASSRLS。
 */
export async function definerFunctionViolations(q: CatalogQuery): Promise<string[]> {
  const rows = await q<{ name: string; config: string[] | null; public_exec: boolean; owner: string; unsafe_owner: boolean }>(
    `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
            (SELECT array_agg(c) FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS config,
            has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
            pg_get_userbyid(p.proowner) AS owner, (r.rolsuper OR r.rolbypassrls) AS unsafe_owner
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.prosecdef AND ${USER_SCHEMA_FILTER} ORDER BY 1`,
  );
  const violations: string[] = [];
  for (const r of rows) {
    const schema = r.name.split('.')[0];
    if (!r.config || r.config.length === 0) {
      violations.push(`${r.name}：沒有固定 search_path`);
    } else {
      const path = r.config[0].slice('search_path='.length).split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
      const extra = path.filter((s) => s !== 'pg_catalog' && s !== 'pg_temp' && s !== schema);
      if (extra.length > 0) violations.push(`${r.name}：search_path 含 ${extra.join('、')}，只該有 pg_catalog、${schema}、pg_temp`);
      if (path[path.length - 1] !== 'pg_temp') violations.push(`${r.name}：search_path 的 pg_temp 必須排最後`);
    }
    if (r.public_exec) violations.push(`${r.name}：PUBLIC 能執行，必須 REVOKE ... FROM PUBLIC`);
    if (r.unsafe_owner) violations.push(`${r.name}：擁有者 ${r.owner} 是 superuser 或有 BYPASSRLS`);
  }
  return violations;
}

/** 回傳 app_rw 能執行的定義者函式，供「誰能呼叫」清單與特別限制的檢查使用。 */
export async function appRwDefinerFunctions(q: CatalogQuery): Promise<string[]> {
  const rows = await q<{ name: string }>(
    `SELECT n.nspname || '.' || p.proname AS name
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND ${USER_SCHEMA_FILTER} AND has_function_privilege('app_rw', p.oid, 'EXECUTE') ORDER BY 1`,
  );
  return rows.map((r) => r.name);
}
