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
   * 只增不改的表（同意紀錄）。app_rw 沒有 UPDATE 與 DELETE 權限，
   * 探測 2、3 改成預期「permission denied」，而不是 0 列。其餘探測不變。
   */
  appendOnly?: boolean;
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
  'org.consent_records': {
    appendOnly: true,
    // 直接 INSERT 而不用 recordConsent：探測 4 要在 A 的脈絡寫入 B 的 org_id，recordConsent 沒有這個參數。
    // 業務鍵（告知類型、對象 email）固定。稽核位置只是欄位值，探測不需要真的稽核事件。
    async seed(tx, orgId) {
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.consent_records
           (id, org_id, notice_type, notice_version, text_sha256, subject_email, decision, source, audit_chain_id, audit_seq)
         VALUES ($1, $2, 'esign', 1, repeat('a', 64), 'penetration@example.com', 'agree', 'in_app', $2, 1)`,
        [id, orgId],
      );
      return id;
    },
  },
};

/** 傳入系統目錄列出的 org 表名（schema.table），回傳沒有登記案例的表。 */
export function tablesWithoutCase(tables: readonly string[]): string[] {
  return tables.filter((t) => !(t in ORG_TABLE_CASES));
}

// ---------------------------------------------------------------------------
// registry 的表與函式（MIL-143 加）
//
// registry 不掛組織 RLS（ADR-0012 決議 8），隔離靠兩件事：
//   1. app_rw 對 registry 的表沒有任何直接權限，只能呼叫 SECURITY DEFINER 函式。
//   2. 函式只回呼叫者組織有物件指向的錨點與單位，別的組織的 ID 與不存在的 ID 得到完全相同的結果。
// rls-penetration.test.ts 從系統目錄列出 registry 所有表與 app_rw 能執行的函式，缺登記就失敗。

/** registry 的每張表都必須登記。測試對每張表驗證 app_rw 的 SELECT、INSERT、UPDATE、DELETE 都被拒。 */
export const REGISTRY_TABLE_CASES: Record<string, { purpose: string }> = {
  'registry.anchors': { purpose: '產權錨點' },
  'registry.rental_units': { purpose: '租賃單位' },
  'registry.areas': { purpose: '縣市與鄉鎮市區編碼表（參照）' },
  'registry.sections': { purpose: '段碼表（參照）' },
};

/** 一個 registry 函式的跨組織探測。被探測的 ID 由測試提供：A 組織建好的物件，與隨機產生的不存在 ID。 */
export interface RegistryFunctionCase {
  /**
   * 以 B 組織的脈絡呼叫函式，目標是 `target`（A 組織的物件，或不存在的隨機 ID）。
   * 回傳值或丟出的錯誤必須與目標的歸屬無關：兩種目標得到的結果必須逐位元相同。
   * 函式沒有接收別人能猜的 ID 時填 null，並在 reason 說明。
   */
  probe: ((tx: OrgTx, target: { anchorId: string; unitId: string }) => Promise<unknown>) | null;
  reason: string;
}

/** app_rw 能執行的每個 registry 函式都必須登記。 */
export const REGISTRY_FUNCTION_CASES: Record<string, RegistryFunctionCase> = {
  'registry.create_pending_anchor': {
    probe: null,
    reason: '呼叫端自己給新 ID，只建不讀，沒有可探測的目標',
  },
  'registry.assign_anchor_key': {
    probe: (tx, { anchorId }) =>
      tx.query('SELECT registry.assign_anchor_key($1, $2, $3, $4, $5, NULL)', [anchorId, 'A', '01', '0001', '1']),
    reason: '以錨點 ID 補建號',
  },
  'registry.get_anchors_for_units': {
    probe: async (tx, { unitId }) =>
      (await tx.query('SELECT * FROM registry.get_anchors_for_units($1::text[])', [[unitId]])).rows,
    reason: '以單位 ID 讀錨點',
  },
  // MIL-145
  'registry.create_sublet_unit': {
    probe: (tx, { unitId }) => tx.query('SELECT * FROM registry.create_sublet_unit($1, $2, $3, NULL)', [unitId, newUlid(), '301']),
    reason: '以來源單位 ID 在同一錨點下新增分租單位，來源不是呼叫者組織的就失敗',
  },
  'registry.get_unit_details': {
    probe: async (tx, { unitId }) => (await tx.query('SELECT * FROM registry.get_unit_details($1::text[])', [[unitId]])).rows,
    reason: '以單位 ID 讀單位資料與顯示編碼要用的編碼',
  },
  'registry.get_sibling_units': {
    probe: async (tx, { unitId }) => (await tx.query('SELECT * FROM registry.get_sibling_units($1)', [unitId])).rows,
    reason: '以單位 ID 讀同一錨點下呼叫者組織的單位',
  },
};

/** 傳入系統目錄列出的 registry 表名（schema.table），回傳沒有登記案例的表。 */
export function registryTablesWithoutCase(tables: readonly string[]): string[] {
  return tables.filter((t) => !(t in REGISTRY_TABLE_CASES));
}

/** 傳入系統目錄列出的 registry 函式名（schema.name），回傳沒有登記案例的函式。 */
export function registryFunctionsWithoutCase(functions: readonly string[]): string[] {
  return functions.filter((f) => !(f in REGISTRY_FUNCTION_CASES));
}
