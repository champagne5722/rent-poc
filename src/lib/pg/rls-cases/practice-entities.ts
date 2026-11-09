// 執業主體登錄、審核台與 practiceRegistry 真實 adapter 的 registry 表與函式（MIL-106、109、113）。
import type { DefinerOnlyTable, RegistryFunctionCase, RegistryTableCase, RlsRegistration } from './types';

const registryTables: Record<string, RegistryTableCase> = {
  // C 線（MIL-106、109）：執業主體登錄與審核台
  'registry.practice_entities': { purpose: '執業主體，統編全域唯一' },
  'registry.practice_licenses': { purpose: '業別與驗證三態的業別層' },
  'registry.review_items': { purpose: '審核台佇列' },
  'registry.credential_checks': { purpose: '核對紀錄，只增不改' },
};

const registryFunctions: Record<string, RegistryFunctionCase> = {
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
  // C 線（MIL-113）：practiceRegistry 真實 adapter。關係（own、bound、selecting、none）由資料庫依交易的組織脈絡算出，
  // 呼叫者不能指定。沒有關係與執業主體不存在回同一個空結果。案例在 practice-registry/live-adapter.test.ts 與 live-adapter.pg.test.ts。
  'registry.list_practice_entities': {
    probe: null,
    reason: '名單設計上任何屋主或執業主體組織都能查，只列已驗證的執業主體，只回 ID、名稱與業別，不回統編、組織 ID、人員（MIL-113）',
  },
  'registry.party_signer_candidates': {
    probe: (tx, { anchorId }) =>
      tx.query('SELECT * FROM registry.party_signer_candidates($1, NULL)', [anchorId]).then((r) => r.rows),
    reason: '以執業主體 ID 列組織成員。呼叫者與該執業主體沒有關係時回空，與執業主體不存在不可區分（MIL-113）',
  },
  'registry.signing_view': {
    probe: (tx, { anchorId }) => tx.query('SELECT registry.signing_view($1, NULL) AS view', [anchorId]).then((r) => r.rows),
    reason: '以執業主體或任職 ID 讀簽章事實。證號原文與核對紀錄 ID 只給 own 與 bound，沒有關係回空（MIL-113）',
  },
};

const definerOnlyTables: Record<string, DefinerOnlyTable> = {
  'registry.practice_entities': {
    reason: '執業主體，統編全域唯一。經 claim_practice_entity、my_registration、submit_license、review_item_detail、lookup_practice_entities 存取（MIL-106、109）',
  },
  'registry.practice_licenses': { reason: '業別與驗證三態的業別層。經 submit_license、record_license_check、my_registration 存取（MIL-106、109）' },
  'registry.review_items': { reason: '審核台佇列。經 review_queue、review_item_detail、record_license_check、resolve_entity_claim 存取（MIL-106、109）' },
  'registry.credential_checks': { reason: '核對紀錄，只增不改（觸發器擋 UPDATE、DELETE、TRUNCATE）。只經 record_license_check 寫入（MIL-109）' },
};

export const practiceEntitiesRls: RlsRegistration = { registryTables, registryFunctions, definerOnlyTables };
