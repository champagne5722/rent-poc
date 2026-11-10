import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ROLES,
  appRwDefinerFunctions,
  auditTableViolations,
  definerFunctionViolations,
  foreignKeyViolations,
  orgTableRlsViolations,
  roleViolations,
  tableRegistrationViolations,
  uniqueKeyViolations,
  viewViolations,
  type CatalogQuery,
} from './rls-catalog-kit';
import { CROSS_ORG_UNIQUE_KEY_EXCEPTIONS } from './rls-cases';

// 系統目錄檢查的測試本體（MIL-89）。rls-catalog.test.ts（PGlite）與 rls-catalog.pg.test.ts（真實 PostgreSQL）共用。

export interface CatalogTarget {
  /** 以 superuser 身分查系統目錄。 */
  q: CatalogQuery;
  /** 以 superuser 身分執行 DDL。與 q 同一條連線，所以 BEGIN 與 ROLLBACK 對兩者都有效。 */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** 在交易內執行 DDL，跑完檢查就回滾，資料庫恢復原狀。 */
async function mutated<T>(target: CatalogTarget, ddl: string, check: () => Promise<T>): Promise<T> {
  await target.exec('BEGIN');
  try {
    await target.exec(ddl);
    return await check();
  } finally {
    await target.exec('ROLLBACK');
  }
}

export function describeRlsCatalog(label: string, setup: () => Promise<CatalogTarget>) {
  describe(`系統目錄檢查：${label}`, () => {
    let t: CatalogTarget;
    beforeAll(async () => {
      t = await setup();
    }, 120_000);
    afterAll(() => t?.close());
    const target = async () => t;

    describe('現況必須全部合規（有違規就失敗，違規項目會列在訊息裡）', () => {
      it('每張表都登記在所屬 schema 的清單，不認得的 schema 不得有表', async () => {
        expect(await tableRegistrationViolations((await target()).q)).toEqual([]);
      });
      it('org 的每張表：org_id 不為空、ENABLE 與 FORCE RLS、至少一條政策（陷阱 2）', async () => {
        expect(await orgTableRlsViolations((await target()).q)).toEqual([]);
      });
      it('audit 的每張表：歸 audit_owner、FORCE RLS、app_rw 的權限與登記一致', async () => {
        expect(await auditTableViolations((await target()).q)).toEqual([]);
      });
      it('應用程式角色不是 superuser、沒有 BYPASSRLS，app_rw 不擁有任何物件（陷阱 1、2）', async () => {
        expect(await roleViolations((await target()).q)).toEqual([]);
      });
      it('所有 view 都設 security_invoker = true，app_rw 只有 SELECT（陷阱 4）', async () => {
        expect(await viewViolations((await target()).q)).toEqual([]);
      });
      it('參照 org 表的外鍵都含成對的 org_id（陷阱 5）', async () => {
        expect(await foreignKeyViolations((await target()).q)).toEqual([]);
      });
      it('org 表的唯一鍵都含 org_id，例外要登記（陷阱 6）', async () => {
        expect(await uniqueKeyViolations((await target()).q)).toEqual([]);
      });
      it('所有定義者函式固定 search_path、PUBLIC 不能執行、擁有者不繞過 RLS', async () => {
        expect(await definerFunctionViolations((await target()).q)).toEqual([]);
      });
      it('app_rw 能執行的定義者函式清單有東西可查（避免查詢寫壞而假通過）', async () => {
        const names = await appRwDefinerFunctions((await target()).q);
        expect(names).toEqual(expect.arrayContaining(['audit.append', 'org.party_has_tenant_membership', 'registry.create_pending_anchor']));
      });
    });

    // 機制本身有效：故意做出違規，確認同一個檢查抓得到。沒有這一組，檢查查詢寫壞時會一直回空陣列而假通過。
    describe('機制本身有效：故意違規會被抓到', () => {
      it('沒登記的 org 表、沒有 RLS、org_id 可為空', async () => {
        const s = await target();
        await mutated(s, 'CREATE TABLE org.zz_probe (id text PRIMARY KEY, org_id text)', async () => {
          expect(await tableRegistrationViolations(s.q)).toContainEqual(expect.stringContaining('org.zz_probe'));
          const v = await orgTableRlsViolations(s.q);
          expect(v).toContain('org.zz_probe：沒有 ENABLE ROW LEVEL SECURITY');
          expect(v).toContain('org.zz_probe：沒有 FORCE ROW LEVEL SECURITY');
          expect(v).toContain('org.zz_probe：沒有任何政策');
          expect(v).toContain('org.zz_probe：org_id 可為空');
        });
      });

      it('只有 ENABLE 沒有 FORCE', async () => {
        const s = await target();
        await mutated(
          s,
          `CREATE TABLE org.zz_probe (id text PRIMARY KEY, org_id text NOT NULL);
           ALTER TABLE org.zz_probe ENABLE ROW LEVEL SECURITY;
           CREATE POLICY p ON org.zz_probe USING (org_id = current_setting('app.org_id', true))`,
          async () => {
            expect(await orgTableRlsViolations(s.q)).toEqual(['org.zz_probe：沒有 FORCE ROW LEVEL SECURITY']);
          },
        );
      });

      it('新的 schema 放了表', async () => {
        const s = await target();
        await mutated(s, 'CREATE SCHEMA zz_rogue; CREATE TABLE zz_rogue.t (id int)', async () => {
          expect(await tableRegistrationViolations(s.q)).toContainEqual(expect.stringContaining('zz_rogue.t'));
        });
      });

      it('沒登記的 audit 表，與 app_rw 多出的權限', async () => {
        const s = await target();
        await mutated(s, 'CREATE TABLE audit.zz_probe (id int)', async () => {
          expect(await tableRegistrationViolations(s.q)).toContainEqual(expect.stringContaining('audit.zz_probe'));
          const v = await auditTableViolations(s.q);
          expect(v).toContain('audit.zz_probe：擁有者是 postgres，必須是 audit_owner');
        });
        await mutated(s, 'GRANT SELECT ON audit.chain_heads TO app_rw', async () => {
          expect(await auditTableViolations(s.q)).toContainEqual(expect.stringContaining('audit.chain_heads：app_rw 的權限是 [SELECT]'));
        });
      });

      it('view 沒有 security_invoker，且 app_rw 多了寫入權限', async () => {
        const s = await target();
        await mutated(s, 'CREATE VIEW org.zz_view AS SELECT 1 AS x; GRANT INSERT ON org.zz_view TO app_rw', async () => {
          const v = await viewViolations(s.q);
          expect(v).toContain('org.zz_view：沒有 security_invoker = true');
          expect(v).toContainEqual(expect.stringContaining('org.zz_view：app_rw 對 view 多了 INSERT'));
        });
      });

      it('materialized view', async () => {
        const s = await target();
        await mutated(s, 'CREATE MATERIALIZED VIEW org.zz_mv AS SELECT 1 AS x', async () => {
          expect(await viewViolations(s.q)).toContainEqual(expect.stringContaining('org.zz_mv：materialized view'));
        });
      });

      it('單欄外鍵參照 org 表', async () => {
        const s = await target();
        await mutated(
          s,
          `CREATE TABLE org.zz_parent (id text PRIMARY KEY, org_id text NOT NULL, UNIQUE (org_id, id));
           CREATE TABLE org.zz_child (id text PRIMARY KEY, org_id text NOT NULL, parent_id text REFERENCES org.zz_parent (id))`,
          async () => {
            expect(await foreignKeyViolations(s.q)).toContainEqual(expect.stringContaining('org.zz_child 的外鍵'));
          },
        );
      });

      it('含 org_id 但位置對不上的外鍵也被抓到', async () => {
        const s = await target();
        await mutated(
          s,
          `CREATE TABLE org.zz_parent (id text, org_id text NOT NULL, UNIQUE (org_id, id));
           CREATE TABLE org.zz_child (id text PRIMARY KEY, org_id text NOT NULL, parent_id text, FOREIGN KEY (parent_id, org_id) REFERENCES org.zz_parent (org_id, id))`,
          async () => {
            expect(await foreignKeyViolations(s.q)).toContainEqual(expect.stringContaining('org.zz_child 的外鍵'));
          },
        );
      });

      it('唯一鍵不含 org_id，含部分唯一索引', async () => {
        const s = await target();
        const ddl = `CREATE TABLE org.zz_probe (id text PRIMARY KEY, org_id text NOT NULL, code text);
                     CREATE UNIQUE INDEX zz_code_key ON org.zz_probe (code);
                     CREATE UNIQUE INDEX zz_partial_key ON org.zz_probe (code) WHERE code IS NOT NULL`;
        await mutated(s, ddl, async () => {
          const v = await uniqueKeyViolations(s.q);
          expect(v).toContainEqual(expect.stringContaining('org.zz_code_key'));
          expect(v).toContainEqual(expect.stringContaining('org.zz_partial_key'));
        });
      });

      it('主鍵不是 (id) 也不含 org_id', async () => {
        const s = await target();
        await mutated(s, 'CREATE TABLE org.zz_probe (code text PRIMARY KEY, org_id text NOT NULL)', async () => {
          expect(await uniqueKeyViolations(s.q)).toContainEqual(expect.stringContaining('org.zz_probe 的主鍵'));
        });
      });

      it('定義者函式沒有固定 search_path、PUBLIC 能執行、擁有者是 superuser', async () => {
        const s = await target();
        await mutated(
          s,
          `CREATE FUNCTION audit.zz_fn() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`,
          async () => {
            const v = await definerFunctionViolations(s.q);
            expect(v).toContain('audit.zz_fn()：沒有固定 search_path');
            expect(v).toContain('audit.zz_fn()：PUBLIC 能執行，必須 REVOKE ... FROM PUBLIC');
            expect(v).toContainEqual(expect.stringContaining('audit.zz_fn()：擁有者'));
          },
        );
      });

      it('search_path 含 public，或 pg_temp 不在最後', async () => {
        const s = await target();
        await mutated(
          s,
          `CREATE FUNCTION audit.zz_fn() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS 'SELECT 1';
           CREATE FUNCTION audit.zz_fn2() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_temp, pg_catalog AS 'SELECT 1'`,
          async () => {
            const v = await definerFunctionViolations(s.q);
            expect(v).toContainEqual(expect.stringContaining('audit.zz_fn()：search_path 含 public'));
            expect(v).toContainEqual(expect.stringContaining('audit.zz_fn2()：search_path 的 pg_temp 必須排最後'));
          },
        );
      });

      it('app_rw 變成 superuser 或有 BYPASSRLS，或擁有表', async () => {
        const s = await target();
        await mutated(s, 'ALTER ROLE app_rw BYPASSRLS', async () => {
          expect(await roleViolations(s.q)).toContain('角色 app_rw 有 BYPASSRLS');
        });
        await mutated(s, 'ALTER ROLE app_owner CREATEROLE', async () => {
          expect(await roleViolations(s.q)).toContain('角色 app_owner 有 CREATEROLE');
        });
        await mutated(s, 'CREATE TABLE org.zz_probe (id int); ALTER TABLE org.zz_probe OWNER TO app_rw', async () => {
          expect(await roleViolations(s.q)).toContainEqual(expect.stringContaining('app_rw 擁有 class org.zz_probe'));
        });
        await mutated(s, 'GRANT app_owner TO app_rw', async () => {
          expect(await roleViolations(s.q)).toContain('app_rw 是角色 app_owner 的成員');
        });
        await mutated(s, 'ALTER ROLE break_glass LOGIN', async () => {
          expect(await roleViolations(s.q)).toContain('角色 break_glass 可以登入');
        });
      });

      it('唯一鍵例外清單明列 registry 與主要出租權源，每一項都有理由', () => {
        expect(Object.keys(CROSS_ORG_UNIQUE_KEY_EXCEPTIONS)).toEqual(expect.arrayContaining(['registry', 'pending:primary-leasing-authority']));
        for (const [name, exception] of Object.entries(CROSS_ORG_UNIQUE_KEY_EXCEPTIONS)) {
          expect(exception.reason.length, `${name} 沒有理由`).toBeGreaterThan(10);
        }
      });

      it('檢查涵蓋的角色清單沒有被悄悄縮短', () => {
        expect([...APP_ROLES]).toEqual(['app_owner', 'app_rw', 'audit_owner', 'vault_owner']);
      });
    });
  });
}
