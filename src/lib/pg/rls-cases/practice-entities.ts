// 執業主體登錄、審核台與 practiceRegistry 真實 adapter 的 registry 表與函式（MIL-106、109、113）。
// 每個函式的個資揭露規則（disclosure，MIL-165）：規則全文見 src/lib/practice-registry/README.md 的「個資揭露矩陣」。
import type { DefinerOnlyTable, RegistryFunctionCase, RegistryTableCase, RlsRegistration } from './types';

const registryTables: Record<string, RegistryTableCase> = {
  // C 線（MIL-106、109）：執業主體登錄與審核台
  'registry.practice_entities': { purpose: '執業主體，統編全域唯一' },
  'registry.practice_licenses': { purpose: '業別與驗證三態的業別層' },
  'registry.review_items': { purpose: '審核台佇列' },
  'registry.credential_checks': { purpose: '核對紀錄，只增不改' },
};

const OPERATOR_WRITE = '營運者專用寫入函式，回傳值只有物件 ID、組織 ID 與結果代碼';

const registryFunctions: Record<string, RegistryFunctionCase> = {
  // C 線（MIL-106、109）：執業主體登錄與審核台。隔離不靠「別人的 ID 與不存在的 ID 同一回應」，
  // 而靠脈絡：組織端函式只看 app.org_id，營運者端函式先呼叫 assert_operator()。案例在 desk.route.test.ts 與 practice 相關測試。
  'registry.claim_practice_entity': {
    probe: null,
    reason: '呼叫端給新 ID，且 p_org_id 必須等於目前的 app.org_id，沒有可探測的別人 ID（MIL-106）',
    disclosure: {
      kind: 'none',
      reason: '寫入函式，只回結果代碼 registered 或 claim_queued。呼叫端給的統編只寫入，不讀出別人的資料；兩種代碼對外必須一致由呼叫端負責（MIL-106）',
    },
  },
  'registry.my_registration': {
    probe: null,
    reason: '沒有參數，只回目前 app.org_id 的登錄進度（MIL-109）',
    disclosure: {
      kind: 'matrix',
      reason: '只回目前組織自己的執業主體（統編、業別、許可字號）或自己送出的認領。其他關係的組織沒有自己的執業主體，得到空結果',
      variants: [
        {
          label: '目前組織的登錄進度',
          call: (tx) => tx.query('SELECT * FROM registry.my_registration()').then((r) => r.rows),
          expected: { default: [], by: { own: ['taxId'], noContext: 'denied' } },
        },
      ],
    },
  },
  'registry.submit_license': {
    probe: null,
    reason: '寫入目前 app.org_id 自己的執業主體，不接收別組織的主體 ID（MIL-109）',
    disclosure: { kind: 'none', reason: '寫入函式，回傳值只有物件 ID、審核項目 ID 與狀態' },
  },
  'registry.lookup_practice_entities': {
    probe: null,
    reason: '批次查詢設計上任何組織成員都能查，只回名稱、稱謂與驗證狀態（MIL-94、109）',
    disclosure: {
      kind: 'matrix',
      reason: '任何組織脈絡都能查。只回執業主體 ID、名稱、業別與驗證狀態，不回統編、組織 ID、人員（ADR-0012 決議 8）',
      variants: [
        {
          label: '用執業主體 ID 清單查',
          call: (tx, fx) => tx.query('SELECT * FROM registry.lookup_practice_entities($1::text[])', [fx.entityIds]).then((r) => r.rows),
          expected: { default: [], by: { noContext: 'denied' } },
        },
      ],
    },
  },
  'registry.review_queue': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()，組織脈絡呼叫會被拒（MIL-109）',
    disclosure: {
      kind: 'matrix',
      reason: '營運者專用。佇列摘要含統編、許可字號與審核對象 ID。其他關係一律被拒，包括該執業主體自己的組織',
      variants: [
        {
          label: '列出待處理項目',
          call: (tx) => tx.query(`SELECT * FROM registry.review_queue('open', 200)`).then((r) => r.rows),
          expected: { default: 'denied', by: { operator: ['taxId', 'inactiveEmployment'] } },
        },
      ],
    },
  },
  'registry.review_item_detail': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()（MIL-109）',
    disclosure: {
      kind: 'matrix',
      reason: '營運者專用。詳情含統編、證號原文、核對紀錄與同一證號的其他任職。其他關係一律被拒，包括該執業主體自己的組織',
      variants: [
        {
          label: '證書項目（專任管理人員）',
          call: (tx, fx) => tx.query('SELECT registry.review_item_detail($1) AS v', [fx.reviewItems.certificate]).then((r) => r.rows),
          expected: { default: 'denied', by: { operator: ['certificateNo', 'checkId'] } },
        },
        {
          label: '任職項目（已結束的人員）',
          call: (tx, fx) => tx.query('SELECT registry.review_item_detail($1) AS v', [fx.reviewItems.employment]).then((r) => r.rows),
          expected: { default: 'denied', by: { operator: ['taxId', 'certificateNo', 'inactiveEmployment'] } },
        },
      ],
    },
  },
  'registry.record_license_check': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()（MIL-109）',
    disclosure: { kind: 'none', reason: OPERATOR_WRITE },
  },
  'registry.resolve_entity_claim': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()（MIL-106、109）',
    disclosure: { kind: 'none', reason: OPERATOR_WRITE },
  },
  // C 線（MIL-113）：practiceRegistry 真實 adapter。關係（own、bound、selecting、none）由資料庫依交易的組織脈絡算出，
  // 呼叫者不能指定。沒有關係與執業主體不存在回同一個空結果。案例在 practice-registry/live-adapter.test.ts 與 live-adapter.pg.test.ts。
  'registry.list_practice_entities': {
    probe: null,
    reason: '名單設計上任何屋主或執業主體組織都能查，只列已驗證的執業主體，只回 ID、名稱與業別，不回統編、組織 ID、人員（MIL-113）',
    disclosure: {
      kind: 'matrix',
      reason: '任何屋主、執業主體或平台組織都能查，只回已驗證執業主體的 ID、名稱與業別。不回統編、組織 ID、人員',
      variants: [
        {
          label: '列出已驗證的執業主體',
          call: (tx) => tx.query('SELECT * FROM registry.list_practice_entities(NULL)').then((r) => r.rows),
          expected: { default: [], by: { noContext: 'denied' } },
        },
      ],
    },
  },
  'registry.party_signer_candidates': {
    probe: (tx, { anchorId }) =>
      tx.query('SELECT * FROM registry.party_signer_candidates($1, NULL)', [anchorId]).then((r) => r.rows),
    reason: '以執業主體 ID 列組織成員。呼叫者與該執業主體沒有關係時回空，與執業主體不存在不可區分（MIL-113）',
    disclosure: {
      kind: 'matrix',
      reason:
        '列執業主體組織的成員（姓名、email）。own 與營運者回真實 email。bound 也回真實 email（送簽要寄信），' +
        'selecting 回遮罩 email，沒有關係回空。不回證號與核對紀錄 ID',
      variants: [
        {
          label: '用執業主體 ID 列成員',
          subject: 'entity',
          call: (tx, _fx, entityId) => tx.query('SELECT * FROM registry.party_signer_candidates($1, NULL)', [entityId]).then((r) => r.rows),
          expected: {
            default: [],
            by: { own: ['fullEmail'], operator: ['fullEmail'], bound: ['fullEmail'], boundByCase: ['fullEmail'], noContext: 'denied' },
          },
        },
      ],
      knownGaps: {
        bound: 'MIL-116：bound 回該執業主體全部成員的真實 email，不限於被指派的人。MIL-116 改由案件成員決定可見的人',
        boundByCase: 'MIL-116：同 bound',
      },
    },
  },
  'registry.signing_view': {
    probe: (tx, { anchorId }) => tx.query('SELECT registry.signing_view($1, NULL) AS view', [anchorId]).then((r) => r.rows),
    reason: '以執業主體或任職 ID 讀簽章事實。證號原文與核對紀錄 ID 只給 own 與 bound，沒有關係回空（MIL-113）',
    disclosure: {
      kind: 'matrix',
      reason:
        '證號原文只給 own 與營運者，其他關係由資料庫遮罩。bound 回真實 email 與核對紀錄 ID。' +
        '列出任職時，bound 與 selecting 只回證書與任職都已驗證的人。bound 用任職 ID 查單筆時回完整狀態，' +
        '送簽前檢查才能說明被拒的原因。selecting 沒有 email 原文與核對紀錄 ID。沒有關係回空',
      variants: [
        {
          label: '用執業主體 ID 列出任職',
          subject: 'entity',
          call: (tx, _fx, entityId) => tx.query('SELECT registry.signing_view($1, NULL) AS v', [entityId]).then((r) => r.rows),
          expected: {
            default: [],
            by: {
              own: ['certificateNo', 'fullEmail', 'checkId', 'inactiveEmployment'],
              operator: ['certificateNo', 'fullEmail', 'checkId', 'inactiveEmployment'],
              bound: ['fullEmail', 'checkId'],
              boundByCase: ['fullEmail', 'checkId'],
              noContext: 'denied',
            },
          },
        },
        {
          label: '用已結束的任職 ID 查單筆',
          subject: 'employment',
          call: (tx, _fx, employmentId) => tx.query('SELECT registry.signing_view(NULL, $1) AS v', [employmentId]).then((r) => r.rows),
          // 單筆也帶業別層的最新核對紀錄 ID（licenses.last_check_id），所以 own 與 bound 都有 checkId
          expected: {
            default: [],
            by: {
              own: ['certificateNo', 'fullEmail', 'checkId', 'inactiveEmployment'],
              operator: ['certificateNo', 'fullEmail', 'checkId', 'inactiveEmployment'],
              bound: ['fullEmail', 'checkId', 'inactiveEmployment'],
              boundByCase: ['fullEmail', 'checkId', 'inactiveEmployment'],
              noContext: 'denied',
            },
          },
        },
      ],
      knownGaps: {
        bound: 'MIL-116：bound 回該執業主體全部已驗證人員的真實 email，不限於被指派的人',
        boundByCase: 'MIL-116：同 bound',
      },
    },
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
