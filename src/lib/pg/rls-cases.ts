import type { CaseMemberRelation } from '../cases';
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
   * 表有 BEFORE UPDATE 的 trigger（寫入後不得修改），它比 RLS 的 WITH CHECK 先執行。
   * 探測 3「自己的列改 org_id」的錯誤因此是這個訊息，不是 row-level security。
   * 別的組織看不到列，UPDATE 不會觸發 trigger，探測 2 仍是 0 列。
   */
  blockedUpdateMessage?: RegExp;
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
  'org.signature_records': {
    // 寫入後不得修改：BEFORE UPDATE 的 trigger 比 RLS 的 WITH CHECK 先執行，
    // 所以自己的列改 org_id 時，錯誤是 trigger 的訊息，不是 RLS 的
    blockedUpdateMessage: /簽章紀錄寫入後不得修改/,
    async seed(tx, orgId) {
      // 父列：合約、簽署任務、簽署人。業務鍵 (org_id, contract_id, rule_id) 的 contract_id 是新的 ULID，
      // rule_id 固定。兩個組織各寫一列都要成功（陷阱 6）
      const contractId = newUlid();
      await tx.query('INSERT INTO org.contracts (id, org_id) VALUES ($1, $2)', [contractId, orgId]);
      const signTaskId = newUlid();
      await tx.query(
        `INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id)
         VALUES ($1, $2, 'mock', 'penetration-ref', 'contract', $3)`,
        [signTaskId, orgId, contractId],
      );
      const signerId = newUlid();
      await tx.query(
        `INSERT INTO org.signers (id, org_id, sign_task_id, position, role, name, email)
         VALUES ($1, $2, $3, 0, 'practitioner', '滲透測試執業人員', 'penetration@example.com')`,
        [signerId, orgId, signTaskId],
      );
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.signature_records
           (id, org_id, contract_id, signer_id, rule_id, statute_ref, rule_version, practitioner_id, employment_id,
            entity_id, license_kind, snapshot_at_send)
         VALUES ($1, $2, $3, $4, 'penetration.slot', 'x', 1, 'practitioner', 'employment', 'entity', 'master_lease', '{}'::jsonb)`,
        [id, orgId, contractId, signerId],
      );
      return id;
    },
  },
  'org.signing_lapses': {
    async seed(tx, orgId) {
      // 父列：合約、簽署任務、簽署人。業務鍵 (org_id, contract_id, rule_id) 的 contract_id 是新的 ULID，
      // rule_id 固定。兩個組織各寫一列都要成功（陷阱 6）
      const contractId = newUlid();
      await tx.query('INSERT INTO org.contracts (id, org_id) VALUES ($1, $2)', [contractId, orgId]);
      const signTaskId = newUlid();
      await tx.query(
        `INSERT INTO org.sign_tasks (id, org_id, provider, provider_task_ref, subject_type, subject_id)
         VALUES ($1, $2, 'mock', 'penetration-ref', 'contract', $3)`,
        [signTaskId, orgId, contractId],
      );
      const signerId = newUlid();
      await tx.query(
        `INSERT INTO org.signers (id, org_id, sign_task_id, position, role, name, email)
         VALUES ($1, $2, $3, 0, 'practitioner', '滲透測試執業人員', 'penetration@example.com')`,
        [signerId, orgId, signTaskId],
      );
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.signing_lapses (id, org_id, contract_id, signer_id, rule_id, state, event_at)
         VALUES ($1, $2, $3, $4, 'penetration.slot', 'void_pending', now())`,
        [id, orgId, contractId, signerId],
      );
      return id;
    },
  },
  'org.contract_mandate_items': {
    async seed(tx, orgId) {
      // 父列：合約。業務鍵 (org_id, contract_id, position) 的 contract_id 是新的 ULID，position 固定
      const contractId = newUlid();
      await tx.query('INSERT INTO org.contracts (id, org_id) VALUES ($1, $2)', [contractId, orgId]);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.contract_mandate_items (id, org_id, contract_id, position, property_id, property_name, property_address)
         VALUES ($1, $2, $3, 0, 'penetration-property', '滲透測試物件', '滲透測試地址')`,
        [id, orgId, contractId],
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
  'org.cases': {
    async seed(tx, orgId) {
      return seedCase(tx, orgId);
    },
  },
  'org.case_members': {
    async seed(tx, orgId) {
      const caseId = await seedCase(tx, orgId);
      // 全域的 party 固定一個：兩個組織各寫一列都要成功（陷阱 6），control.parties 不屬於任何組織
      await tx.query(
        `INSERT INTO control.parties (id, email, display_name)
         VALUES ('0000000000000000000000PEN1', 'penetration-member@example.com', '滲透測試成員')
         ON CONFLICT DO NOTHING`,
      );
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.case_members (id, org_id, case_id, party_id, relation)
         VALUES ($1, $2, $3, '0000000000000000000000PEN1', 'lessor')`,
        [id, orgId, caseId],
      );
      return id;
    },
  },
  'org.case_events': {
    // 寫入後不得修改也不得刪除：trigger 比 RLS 的 WITH CHECK 先執行（同 org.signature_records）
    blockedUpdateMessage: /案件事件寫入後不得修改或刪除/,
    async seed(tx, orgId) {
      const caseId = await seedCase(tx, orgId);
      const id = newUlid();
      await tx.query(
        `INSERT INTO org.case_events (id, org_id, case_id, type, occurred_at) VALUES ($1, $2, $3, 'created', now())`,
        [id, orgId, caseId],
      );
      return id;
    },
  },
};

async function seedCase(tx: OrgTx, orgId: string): Promise<string> {
  const id = newUlid();
  await tx.query(
    `INSERT INTO org.cases (id, org_id, kind, state, business_type, title)
     VALUES ($1, $2, 'lease', 'draft', 'self_managed', '滲透測試案件')`,
    [id, orgId],
  );
  return id;
}

/**
 * 案件範圍表的成員讀取矩陣（ADR-0016 決議 15，MIL-115）。
 * 規則：凡是有 case_id 或經合約掛在案件下的 org 表，都要在這裡列出「哪些關係讀得到」。
 * 空陣列代表成員一律讀不到，只有主辦組織（org_isolation）讀得到。
 * case-rls.test.ts 逐表、逐關係驗證資料庫的政策與這份清單一致，並檢查每張有 case_id 欄位的表都在清單內。
 * E 線加案件範圍表（押金、點交、修繕、帳務）時，在這裡加一列並補 migration 的政策。
 */
export const CASE_SCOPED_READS: Record<string, { readableBy: readonly CaseMemberRelation[]; note: string }> = {
  'org.cases': {
    readableBy: ['lessor', 'lessee', 'co_lessee', 'mandator', 'mandatary', 'owner', 'practitioner', 'broker'],
    note: '含租期欄位，所以包租案件的 owner 只讀這一張（P0-09 AC5）',
  },
  'org.case_members': {
    readableBy: ['lessor', 'mandator', 'mandatary'],
    note: '其他關係只讀自己的列（self_read，ADR-0012 決議 7）',
  },
  'org.case_events': { readableBy: ['lessor', 'mandator', 'mandatary'], note: '' },
  'org.contracts': {
    readableBy: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker', 'mandator', 'mandatary'],
    note: '包租案件的 owner 讀不到合約（P0-09 AC5）',
  },
  'org.sign_tasks': { readableBy: ['lessor', 'mandator', 'mandatary'], note: '簽署任務，經合約對應到案件' },
  'org.signers': { readableBy: ['lessor', 'mandator', 'mandatary'], note: '經簽署任務對應到案件' },
  'org.contract_events': { readableBy: [], note: '合約歷程。成員讀取未開放，承租人端不需要（MIL-121）' },
  'org.contract_practitioner_assignments': { readableBy: [], note: '指派改成案件成員前仍只有主辦組織讀取（MIL-116）' },
  'org.sign_task_files': {
    readableBy: ['lessor', 'lessee', 'co_lessee', 'practitioner', 'broker', 'mandator', 'mandatary'],
    note: '只讀已簽 PDF（kind = signed_pdf），不含 Audit Trail File。經 簽署任務 → 合約 → 案件 對應，owner 讀不到（MIL-121，0049）',
  },
  'org.signature_records': { readableBy: [], note: '簽章紀錄只有主辦組織讀取' },
  'org.signing_lapses': { readableBy: [], note: '簽署中失效紀錄（MIL-75）。合約子表，沒有 case_id，只有主辦組織讀取' },
  'org.contract_mandate_items': { readableBy: [], note: '委託標的清單（MIL-74）。合約子表，沒有 case_id，只有主辦組織讀取' },
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
  // C 線（MIL-106、109）：執業主體登錄與審核台
  'registry.practice_entities': { purpose: '執業主體，統編全域唯一' },
  'registry.practice_licenses': { purpose: '業別與驗證三態的業別層' },
  'registry.review_items': { purpose: '審核台佇列' },
  'registry.credential_checks': { purpose: '核對紀錄，只增不改' },
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
  // C 線（MIL-106、109）：執業主體登錄與審核台。隔離不靠「別人的 ID 與不存在的 ID 同一回應」，
  // 而靠脈絡：組織端函式只看 app.org_id，營運者端函式先呼叫 assert_operator()。案例在 desk.route.test.ts 與 practice 相關測試。
  'registry.claim_practice_entity': {
    probe: null,
    reason: '呼叫端給新 ID，且 p_org_id 必須等於目前的 app.org_id，沒有可探測的別人 ID（MIL-106）',
  },
  'registry.my_registration': {
    probe: null,
    reason: '沒有參數，只回目前 app.org_id 的登錄進度（MIL-109）',
  },
  'registry.submit_license': {
    probe: null,
    reason: '寫入目前 app.org_id 自己的執業主體，不接收別組織的主體 ID（MIL-109）',
  },
  'registry.lookup_practice_entities': {
    probe: null,
    reason: '批次查詢設計上任何組織成員都能查，只回名稱、稱謂與驗證狀態（MIL-94、109）',
  },
  'registry.review_queue': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()，組織脈絡呼叫會被拒（MIL-109）',
  },
  'registry.review_item_detail': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()（MIL-109）',
  },
  'registry.record_license_check': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()（MIL-109）',
  },
  'registry.resolve_entity_claim': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()（MIL-106、109）',
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
// 取而代之的是這份例外清單：每張 control 表必須登記「為什麼不掛 RLS」，並寫明 app_rw 的直接 DML 權限。
// 不在清單內的 control 表讓 rls-penetration.test.ts 失敗，權限與清單不符也會失敗。
// 這些表的資料不屬於任何一個組織（帳號、成員關係、session、webhook 收件匣），權限逐表授予，不靠 RLS。
// 之後新增 control 表的人（F 線的 control.handovers 等）自己加進來。
// MIL-89 會擴充成完整的系統目錄檢查，沿用這份清單。

export interface ControlTableException {
  /** 為什麼這張表不掛組織 RLS，讀寫該怎麼走。 */
  reason: string;
  /** app_rw 允許的直接 DML。沒有列出的動作一律不得有權限，空陣列代表 app_rw 沒有任何權限。 */
  appRw: ReadonlyArray<'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'>;
}

export const CONTROL_TABLE_EXCEPTIONS: Record<string, ControlTableException> = {
  'control.schema_migrations': {
    reason: 'migration runner 的版本紀錄，只有 app_owner 讀寫',
    appRw: [],
  },
  'control.orgs': {
    reason: '組織目錄，登入與 withTx 設定脈絡之前就要查。MIL-106 起可新增（第一次登入建組織），不能改或刪',
    appRw: ['SELECT', 'INSERT'],
  },
  'control.parties': {
    reason: '自然人，以 email 為唯一鍵，不屬於任何組織（承租人跨組織）。MIL-103',
    appRw: ['SELECT', 'INSERT'],
  },
  'control.users': {
    reason: '登入帳號，一個 party 一個帳號，帳號可屬多個組織。MIL-103',
    appRw: ['SELECT', 'INSERT'],
  },
  'control.org_memberships': {
    reason: '帳號與組織的成員關係，登入時要跨組織查，才能決定組織脈絡。MIL-103，成員管理由 MIL-106 接手',
    appRw: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
  'control.org_invitations': {
    reason: '以 email 邀請成員，被邀請者登入前沒有帳號也沒有組織脈絡，登入流程要依 email 跨組織查。查詢與寫入一律明確帶 org_id。MIL-106',
    appRw: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
  'control.sessions': {
    reason: '伺服器端 session，登入前沒有組織脈絡可用。只存 token 的雜湊。MIL-103',
    appRw: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
  'control.login_otps': {
    reason: '一次性驗證碼，登入前沒有組織脈絡可用。只存 HMAC 雜湊。MIL-103',
    appRw: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
  'control.sign_task_routes': {
    reason: 'webhook 沒有組織脈絡，靠它由服務商任務編號查出 org_id（ADR-0012 決議 5）。與簽署任務同交易寫入，寫入後不變',
    appRw: ['SELECT', 'INSERT'],
  },
  'control.inbox_messages': {
    reason:
      'webhook 沒有組織脈絡，先寫這張表再處理（ADR-0020 決議 5、9）。只存標準化事件與 body 雜湊，不存原始 body。' +
      '處理時在組織交易內更新狀態，所以 app_rw 要有 UPDATE。事件到達的紀錄不刪',
    appRw: ['SELECT', 'INSERT', 'UPDATE'],
  },
  'control.timer_fires': {
    reason:
      '計時器的冪等紀錄，鍵是主體、事件、日期（ADR-0020 決議 7）。與計時器的效果同交易寫入，寫入後不變。' +
      '全域計時器沒有組織，所以 org_id 可為空',
    appRw: ['SELECT', 'INSERT'],
  },
};

/** 傳入系統目錄列出的 control 表名（schema.table），回傳沒有登記的表。 */
export function controlTablesWithoutException(tables: readonly string[]): string[] {
  return tables.filter((t) => !(t in CONTROL_TABLE_EXCEPTIONS));
}

// registry 與 vault 的表不掛組織 RLS，也不給 app_rw 任何直接權限，只經 SECURITY DEFINER 函式存取（ADR-0012 決議 3、8，MIL-109）。
// 取而代之的是這份清單：每張 registry、vault 表必須登記「存放什麼、誰能經函式讀寫」。
// 不在清單內的表讓 rls-penetration.test.ts 失敗；app_rw 或 PUBLIC 有任何表權限也會失敗。
// 之後新增 registry 或 vault 表的人（B 線的段碼參照表、C 線的證書與任職表等）自己加進來。

export interface DefinerOnlyTable {
  /** 這張表放什麼，經哪些函式存取。 */
  reason: string;
}

export const DEFINER_ONLY_TABLES: Record<string, DefinerOnlyTable> = {
  'registry.anchors': { reason: '產權錨點，全域一份。經 registry.create_pending_anchor 等函式存取（MIL-81）' },
  'registry.rental_units': { reason: '租賃單位，全域一份。經 registry.create_pending_anchor 等函式存取（MIL-81）' },
  'registry.areas': { reason: '縣市與鄉鎮市區編碼表（參照）。執行期不讀，seed 檔由 migration 載入（MIL-143）' },
  'registry.sections': { reason: '段碼表（參照）。執行期不讀，seed 檔由 migration 載入（MIL-143）' },
  'registry.practice_entities': {
    reason: '執業主體，統編全域唯一。經 claim_practice_entity、my_registration、submit_license、review_item_detail、lookup_practice_entities 存取（MIL-106、109）',
  },
  'registry.practice_licenses': { reason: '業別與驗證三態的業別層。經 submit_license、record_license_check、my_registration 存取（MIL-106、109）' },
  'registry.review_items': { reason: '審核台佇列。經 review_queue、review_item_detail、record_license_check、resolve_entity_claim 存取（MIL-106、109）' },
  'registry.credential_checks': { reason: '核對紀錄，只增不改（觸發器擋 UPDATE、DELETE、TRUNCATE）。只經 record_license_check 寫入（MIL-109）' },
  'registry.practitioners': {
    reason: '執業人員證書層，驗證狀態全域一份，證號未遮罩。經 my_practitioner、submit_practitioner、record_practitioner_check、signing_facts、certificate_badges 等函式存取（MIL-111）',
  },
  'registry.practitioner_employments': {
    reason: '執業人員任職層與專任排除約束（部分唯一索引）。經 create_employment、end_employment、record_employment_check、org_employments、employment_exclusivity_facts 存取，回應不透露別的組織（MIL-111）',
  },
  'vault.credential_evidence': { reason: '證據檔的中繼資料，檔案本體在 FileStore。經 vault.*_credential_evidence 函式存取，開啟與刪除寫稽核事件（MIL-109）' },
};

/** 傳入系統目錄列出的 registry 與 vault 表名（schema.table），回傳沒有登記的表。 */
export function definerOnlyTablesWithoutEntry(tables: readonly string[]): string[] {
  return tables.filter((t) => !(t in DEFINER_ONLY_TABLES));
}
