// 執業人員證書與任職的 registry 表與函式（MIL-111）。
// 每個函式的個資揭露規則（disclosure，MIL-165）：規則全文見 src/lib/practice-registry/README.md 的「個資揭露矩陣」。
import type { DefinerOnlyTable, RegistryFunctionCase, RegistryTableCase, RlsRegistration } from './types';

const registryTables: Record<string, RegistryTableCase> = {
  // C 線（MIL-111）：執業人員證書與任職
  'registry.practitioners': { purpose: '執業人員證書層，驗證狀態全域一份，證號未遮罩' },
  'registry.practitioner_employments': { purpose: '執業人員任職層與專任排除約束' },
};

/** 寫入函式的共同理由：回傳值只有呼叫者剛送出的物件 ID 與審核項目 ID。 */
const WRITES_IDS_ONLY = '回傳值只有物件 ID、審核項目 ID 或結果代碼';

const registryFunctions: Record<string, RegistryFunctionCase> = {
  // C 線（MIL-111）：執業人員證書與任職。隔離靠脈絡（app.org_id、app.party_id 加成員資格，或 assert_operator()），
  // 不靠「別人的 ID 與不存在的 ID 同一回應」。案例在 practitioner 相關測試。
  'registry.certificate_badges': {
    probe: null,
    reason: '只回 party_id、證書種類與核對日，不回證號與組織資料；任何組織脈絡都能呼叫（MIL-111）',
    disclosure: {
      kind: 'none',
      reason: '只回 party_id、證書種類與核對日。不回證號、email、統編、核對紀錄 ID 與任職',
      call: (tx, fx) => tx.query('SELECT * FROM registry.certificate_badges($1::text[])', [fx.partyIds]).then((r) => r.rows),
    },
  },
  'registry.create_employment': {
    probe: null,
    reason: '呼叫者必須是目前執業主體的成員（assert_practice_member()），只為本人建立任職（MIL-111）',
    disclosure: { kind: 'none', reason: `寫入函式。${WRITES_IDS_ONLY}` },
  },
  'registry.employment_exclusivity_facts': {
    probe: null,
    reason: '呼叫者必須是證號本人的成員脈絡，只回自己這家與別家的標記，不回別家的 ID 與名稱（MIL-111）',
    disclosure: {
      kind: 'matrix',
      reason:
        '回傳同一證書鍵在各執業主體的任職狀態與期間，只標 self 或 other。只有目前執業主體自己的任職（self）屬於 own 的範圍，' +
        '其他組織的成員不得藉此探測別人證書鍵的任職',
      variants: [
        {
          label: '用已結束任職的證書鍵查',
          subject: 'certificateKey',
          call: (tx, _fx, key) => tx.query('SELECT * FROM registry.employment_exclusivity_facts($1)', [key]).then((r) => r.rows),
          // unrelated 的正確期望是 []（與查不存在的證書鍵相同）。目前函式只檢查「呼叫者是某個執業主體組織的成員」，
          // 沒有檢查證書鍵屬於呼叫者，所以任何執業主體組織的成員都能探測任意證書鍵。見 knownGaps。
          expected: { default: 'denied', by: { own: ['inactiveEmployment'], unrelated: ['inactiveEmployment'] } },
        },
      ],
      knownGaps: {
        unrelated:
          'MIL-165：任何執業主體組織的成員，用任意證書鍵都能查到別家任職的狀態與起訖日，與查不存在的證書鍵可區分。' +
          '待主控決定修法與 migration 編號，修好後把 unrelated 的期望值改回 []，並刪掉這則缺口',
      },
    },
  },
  'registry.end_employment': {
    probe: null,
    reason: '呼叫者必須是目前執業主體的成員，且是任職本人或 admin（MIL-111）',
    disclosure: { kind: 'none', reason: `寫入函式。${WRITES_IDS_ONLY}` },
  },
  'registry.my_practitioner': {
    probe: null,
    reason: '沒有參數，只回呼叫者自己的證書與目前組織的任職（MIL-111）',
    disclosure: {
      kind: 'matrix',
      reason: '只回呼叫者本人的證書（證號原文是本人的）與本人在目前執業主體的任職。沒有執業主體的組織與營運者沒有本人的證書',
      variants: [
        {
          label: '本人的證書與任職',
          call: (tx) => tx.query('SELECT registry.my_practitioner() AS v').then((r) => r.rows),
          expected: { default: [], by: { own: ['certificateNo'], operator: 'denied', noContext: 'denied' } },
        },
      ],
    },
  },
  'registry.org_employments': {
    probe: null,
    reason: '沒有參數，只回目前組織的任職，證號序號由 TypeScript 遮罩（MIL-111）',
    disclosure: {
      kind: 'matrix',
      reason: '只回目前組織（呼叫者自己的執業主體）的全部任職，含待驗證與已結束的人，證號回原文。其他組織的呼叫者得到空結果',
      variants: [
        {
          label: '目前組織的任職清單',
          call: (tx) => tx.query('SELECT registry.org_employments() AS v').then((r) => r.rows),
          expected: { default: [], by: { own: ['certificateNo', 'inactiveEmployment'], operator: 'denied', noContext: 'denied' } },
        },
      ],
    },
  },
  'registry.practitioner_party': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()（MIL-111）',
    disclosure: {
      kind: 'matrix',
      reason: '營運者專用，只回證書持有人的 party ID，不含本表檢查的欄位',
      variants: [
        {
          label: '用證書 ID 查持有人',
          call: (tx, fx) => tx.query('SELECT registry.practitioner_party($1) AS v', [fx.practitionerId]).then((r) => r.rows),
          expected: { default: 'denied', by: { operator: [] } },
        },
      ],
    },
  },
  'registry.record_consent_check': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()（MIL-111）',
    disclosure: { kind: 'none', reason: `營運者專用寫入函式。${WRITES_IDS_ONLY}` },
  },
  'registry.record_employment_check': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()（MIL-111）',
    disclosure: { kind: 'none', reason: `營運者專用寫入函式。${WRITES_IDS_ONLY}` },
  },
  'registry.record_practitioner_check': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()（MIL-111）',
    disclosure: { kind: 'none', reason: `營運者專用寫入函式。${WRITES_IDS_ONLY}` },
  },
  'registry.signing_facts': {
    probe: null,
    reason: '只允許該執業主體自己的組織與平台營運者呼叫，別的組織被拒（MIL-111）',
    disclosure: {
      kind: 'matrix',
      reason:
        '回傳未遮罩的證號、核對紀錄 ID 與每位人員最新的任職（含待驗證與已結束）。只給該執業主體自己的組織與營運者，' +
        '其他關係得到空結果。跨組織改走 registry.signing_view',
      variants: [
        {
          label: '用執業主體 ID 與全部成員的 party 查',
          subject: 'entity',
          call: (tx, fx, entityId) =>
            tx.query('SELECT registry.signing_facts($1, $2::text[]) AS v', [entityId, fx.partyIds]).then((r) => r.rows),
          expected: {
            default: [],
            by: {
              own: ['certificateNo', 'checkId', 'inactiveEmployment'],
              operator: ['certificateNo', 'checkId', 'inactiveEmployment'],
              noContext: 'denied',
            },
          },
        },
      ],
    },
  },
  'registry.submit_consent': {
    probe: null,
    reason: '呼叫者必須是目前執業主體的成員，只為本人的任職送同意書（MIL-111）',
    disclosure: { kind: 'none', reason: `寫入函式。${WRITES_IDS_ONLY}` },
  },
  'registry.submit_practitioner': {
    probe: null,
    reason: '呼叫者必須是目前執業主體的成員，只登錄本人的證書（MIL-111）',
    disclosure: { kind: 'none', reason: `寫入函式。${WRITES_IDS_ONLY}` },
  },
};

const definerOnlyTables: Record<string, DefinerOnlyTable> = {
  'registry.practitioners': {
    reason: '執業人員證書層，驗證狀態全域一份，證號未遮罩。經 my_practitioner、submit_practitioner、record_practitioner_check、signing_facts、certificate_badges 等函式存取（MIL-111）',
  },
  'registry.practitioner_employments': {
    reason: '執業人員任職層與專任排除約束（部分唯一索引）。經 create_employment、end_employment、record_employment_check、org_employments、employment_exclusivity_facts 存取，回應不透露別的組織（MIL-111）',
  },
};

export const practitionersRls: RlsRegistration = { registryTables, registryFunctions, definerOnlyTables };
