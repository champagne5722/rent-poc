// 執業人員證書與任職的 registry 表與函式（MIL-111）。
import type { DefinerOnlyTable, RegistryFunctionCase, RegistryTableCase, RlsRegistration } from './types';

const registryTables: Record<string, RegistryTableCase> = {
  // C 線（MIL-111）：執業人員證書與任職
  'registry.practitioners': { purpose: '執業人員證書層，驗證狀態全域一份，證號未遮罩' },
  'registry.practitioner_employments': { purpose: '執業人員任職層與專任排除約束' },
};

const registryFunctions: Record<string, RegistryFunctionCase> = {
  // C 線（MIL-111）：執業人員證書與任職。隔離靠脈絡（app.org_id、app.party_id 加成員資格，或 assert_operator()），
  // 不靠「別人的 ID 與不存在的 ID 同一回應」。案例在 practitioner 相關測試。
  'registry.certificate_badges': {
    probe: null,
    reason: '只回 party_id、證書種類與核對日，不回證號與組織資料；任何組織脈絡都能呼叫（MIL-111）',
  },
  'registry.create_employment': {
    probe: null,
    reason: '呼叫者必須是目前執業主體的成員（assert_practice_member()），只為本人建立任職（MIL-111）',
  },
  'registry.employment_exclusivity_facts': {
    probe: null,
    reason: '呼叫者必須是證號本人的成員脈絡，只回自己這家與別家的標記，不回別家的 ID 與名稱（MIL-111）',
  },
  'registry.end_employment': {
    probe: null,
    reason: '呼叫者必須是目前執業主體的成員，且是任職本人或 admin（MIL-111）',
  },
  'registry.my_practitioner': {
    probe: null,
    reason: '沒有參數，只回呼叫者自己的證書與目前組織的任職（MIL-111）',
  },
  'registry.org_employments': {
    probe: null,
    reason: '沒有參數，只回目前組織的任職，證號序號由 TypeScript 遮罩（MIL-111）',
  },
  'registry.practitioner_party': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()（MIL-111）',
  },
  'registry.record_consent_check': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()（MIL-111）',
  },
  'registry.record_employment_check': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()（MIL-111）',
  },
  'registry.record_practitioner_check': {
    probe: null,
    reason: '營運者專用，先呼叫 assert_operator()（MIL-111）',
  },
  'registry.signing_facts': {
    probe: null,
    reason: '只允許該執業主體自己的組織與平台營運者呼叫，別的組織被拒（MIL-111）',
  },
  'registry.submit_consent': {
    probe: null,
    reason: '呼叫者必須是目前執業主體的成員，只為本人的任職送同意書（MIL-111）',
  },
  'registry.submit_practitioner': {
    probe: null,
    reason: '呼叫者必須是目前執業主體的成員，只登錄本人的證書（MIL-111）',
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
