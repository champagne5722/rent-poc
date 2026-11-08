import { newUlid } from './ulid';
import type { OrgTx } from './with-tx';

// 滲透測試的案例清單（ADR-0012 決議 6，MIL-81 建骨架，MIL-89 擴充）。
//
// 規則：org schema 的每張表必須在 ORG_TABLE_CASES 登記一個案例。
// rls-penetration.test.ts 從系統目錄列出 org 的所有表，缺案例就讓測試失敗，
// 所以新增 org 表的人不能略過隔離測試。
//
// 一個案例只需要說明「怎麼在某個組織寫入一列」。測試對每張表自動跑通用探測：
//   1. 自己看得到、改得到、刪得到
//   2. 別的組織看不到、改不到、刪不到（UPDATE 與 DELETE 影響 0 列）
//   3. 在 A 的脈絡寫入 B 的 org_id，被 RLS 擋下
//   4. 沒有組織脈絡時 0 筆
//   5. 兩個組織用同一組業務鍵各寫一列，都成功（陷阱 6：唯一鍵必須含 org_id）
// 表專屬的探測（複合外鍵穿透、view 的 security_invoker、併發）由 MIL-89 在 extra 欄位補。

export interface OrgTableCase {
  /**
   * 在 tx 的脈絡內寫入一列，org_id 欄位用傳入的 orgId，回傳主鍵（欄位名一律是 id）。
   * 業務鍵必須固定，不得每次隨機：探測 5 靠兩個組織寫入同一組業務鍵，驗證唯一鍵含 org_id。
   * 需要父列（例如 registry 的租賃單位）時，在這裡一併建立。
   */
  seed(tx: OrgTx, orgId: string): Promise<string>;
}

export const ORG_TABLE_CASES: Record<string, OrgTableCase> = {
  'org.properties': {
    async seed(tx, orgId) {
      const unitId = newUlid();
      await tx.query('SELECT * FROM registry.create_pending_anchor($1, $2, $3)', [newUlid(), unitId, '滲透測試地址']);
      const id = newUlid();
      await tx.query(
        'INSERT INTO org.properties (id, org_id, rental_unit_id, name, address) VALUES ($1, $2, $3, $4, $5)',
        [id, orgId, unitId, '滲透測試物件', '滲透測試地址'],
      );
      return id;
    },
  },
  'org.equipment_vocabulary': {
    async seed(tx, orgId) {
      const id = newUlid();
      await tx.query('INSERT INTO org.equipment_vocabulary (id, org_id, name, is_custom) VALUES ($1, $2, $3, true)', [
        id,
        orgId,
        '滲透測試設備',
      ]);
      return id;
    },
  },
};

/** 傳入系統目錄列出的 org 表名（schema.table），回傳沒有登記案例的表。 */
export function tablesWithoutCase(tables: readonly string[]): string[] {
  return tables.filter((t) => !(t in ORG_TABLE_CASES));
}

// control schema 的表不掛組織 RLS（ADR-0012 決議 3），所以不進 ORG_TABLE_CASES。
// 規則：control 的每張表必須在這裡登記「為什麼不掛 RLS」與「app_rw 拿到哪些權限」，
// rls-penetration.test.ts 從系統目錄列出 control 的所有表，缺登記就讓測試失敗。
// 這些表的資料不屬於任何一個組織（帳號、成員關係、session），權限逐表授予，不靠 RLS。
export interface ControlTableException {
  reason: string;
  /** app_rw 在這張表上的權限，測試會比對系統目錄。空陣列代表 app_rw 沒有任何權限。 */
  appRwPrivileges: readonly ('SELECT' | 'INSERT' | 'UPDATE' | 'DELETE')[];
}

export const CONTROL_TABLE_EXCEPTIONS: Record<string, ControlTableException> = {
  'control.schema_migrations': {
    reason: 'migration runner 的紀錄表，只給 app_owner（0001）',
    appRwPrivileges: [],
  },
  'control.orgs': {
    reason: '組織目錄，所有組織的名稱與種類。MIL-79',
    appRwPrivileges: ['SELECT'],
  },
  'control.parties': {
    reason: '自然人，以 email 為唯一鍵，不屬於任何組織（承租人跨組織）。MIL-103',
    appRwPrivileges: ['SELECT', 'INSERT'],
  },
  'control.users': {
    reason: '登入帳號，一個 party 一個帳號，帳號可屬多個組織。MIL-103',
    appRwPrivileges: ['SELECT', 'INSERT'],
  },
  'control.org_memberships': {
    reason: '帳號與組織的成員關係，登入時要跨組織查，才能決定組織脈絡。MIL-103，成員管理由 MIL-106 接手',
    appRwPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
  'control.sessions': {
    reason: '伺服器端 session，登入前沒有組織脈絡可用。只存 token 的雜湊。MIL-103',
    appRwPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
  'control.login_otps': {
    reason: '一次性驗證碼，登入前沒有組織脈絡可用。只存 HMAC 雜湊。MIL-103',
    appRwPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
};
