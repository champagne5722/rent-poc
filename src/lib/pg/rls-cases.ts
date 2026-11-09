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
   * 只增不改的表（同意紀錄、合約歷程）。app_rw 沒有 UPDATE 與 DELETE 權限，
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
  'org.contracts': {
    async seed(tx, orgId) {
      const id = newUlid();
      // legacy_id 固定：兩個組織寫同一組業務鍵 (org_id, legacy_id) 都要成功（陷阱 6）
      await tx.query('INSERT INTO org.contracts (id, org_id, legacy_id) VALUES ($1, $2, 1)', [id, orgId]);
      return id;
    },
  },
  'org.contract_events': {
    appendOnly: true,
    async seed(tx, orgId) {
      const contractId = newUlid();
      await tx.query('INSERT INTO org.contracts (id, org_id) VALUES ($1, $2)', [contractId, orgId]);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.contract_events (id, org_id, contract_id, type, actor, legacy_id) VALUES ($1, $2, $3, 'created', 'landlord', 1)`,
        [id, orgId, contractId],
      );
      return id;
    },
  },
  'org.contract_practitioner_assignments': {
    async seed(tx, orgId) {
      const contractId = newUlid();
      await tx.query('INSERT INTO org.contracts (id, org_id) VALUES ($1, $2)', [contractId, orgId]);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.contract_practitioner_assignments (id, org_id, contract_id, slot, entity_id, practitioner_id)
         VALUES ($1, $2, $3, 'penetration.slot', 'entity', 'practitioner')`,
        [id, orgId, contractId],
      );
      return id;
    },
  },
  'org.contract_credential_snapshots': {
    async seed(tx, orgId) {
      const contractId = newUlid();
      await tx.query('INSERT INTO org.contracts (id, org_id) VALUES ($1, $2)', [contractId, orgId]);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.contract_credential_snapshots (id, org_id, contract_id, slot, practitioner_id, decided_at, facts, result)
         VALUES ($1, $2, $3, 'penetration.slot', 'practitioner', now(), '{}'::jsonb, '{}'::jsonb)`,
        [id, orgId, contractId],
      );
      return id;
    },
  },
  'org.sign_tasks': {
    async seed(tx, orgId) {
      return seedSignTask(tx, orgId);
    },
  },
  'org.signers': {
    async seed(tx, orgId) {
      const signTaskId = await seedSignTask(tx, orgId);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.signers (id, org_id, sign_task_id, position, role, name, email)
         VALUES ($1, $2, $3, 0, 'party_b', '滲透測試簽署人', 'penetration@example.com')`,
        [id, orgId, signTaskId],
      );
      return id;
    },
  },
  'org.sign_task_files': {
    async seed(tx, orgId) {
      const signTaskId = await seedSignTask(tx, orgId);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.sign_task_files (id, org_id, sign_task_id, kind, status, file_name)
         VALUES ($1, $2, $3, 'signed_pdf', 'failed', 'penetration.pdf')`,
        [id, orgId, signTaskId],
      );
      return id;
    },
  },
  'org.outbox': {
    async seed(tx, orgId) {
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.outbox (id, org_id, action, subject_type, subject_id, status)
         VALUES ($1, $2, 'void_sign_task', 'contract', $3, 'pending')`,
        [id, orgId, newUlid()],
      );
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

// 簽署任務。服務商任務編號固定：兩個組織各寫一列都要成功（陷阱 6）；
// 跨組織的唯一性由 control.sign_task_routes 保證，那張表在下面的例外清單。
async function seedSignTask(tx: OrgTx, orgId: string): Promise<string> {
  const id = newUlid();
  await tx.query(
    `INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id)
     VALUES ($1, $2, 'mock', 'penetration-ref', 'contract', $3)`,
    [id, orgId, newUlid()],
  );
  return id;
}

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

// control schema 的表不掛組織 RLS，也不需要滲透案例（ADR-0012 決議 3）。
// 取而代之的是這份例外清單：每張 control 表必須登記，並寫明 app_rw 的直接 DML 權限。
// 不在清單內的 control 表讓 rls-penetration.test.ts 失敗，權限與清單不符也會失敗。
// 之後新增 control 表的人（inbox 屬 MIL-86、F 線的 control.handovers）自己加進來。
// MIL-89 會擴充成完整的系統目錄檢查，沿用這份清單。

export interface ControlTableException {
  /** 為什麼這張表不掛組織 RLS，讀寫該怎麼走。 */
  reason: string;
  /** app_rw 允許的直接 DML。沒有列出的動作一律不得有權限。 */
  appRw: ReadonlyArray<'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'>;
}

export const CONTROL_TABLE_EXCEPTIONS: Record<string, ControlTableException> = {
  'control.schema_migrations': {
    reason: 'migration runner 的版本紀錄，只有 app_owner 讀寫',
    appRw: [],
  },
  'control.orgs': {
    reason: '組織目錄，登入與 withTx 設定脈絡之前就要查。應用程式只讀，新增組織走維運',
    appRw: ['SELECT'],
  },
  'control.sign_task_routes': {
    reason: 'webhook 沒有組織脈絡，靠它由服務商任務編號查出 org_id（ADR-0012 決議 5）。與簽署任務同交易寫入，寫入後不變',
    appRw: ['SELECT', 'INSERT'],
  },
};

/** 傳入系統目錄列出的 control 表名（schema.table），回傳沒有登記的表。 */
export function controlTablesWithoutException(tables: readonly string[]): string[] {
  return tables.filter((t) => !(t in CONTROL_TABLE_EXCEPTIONS));
}
