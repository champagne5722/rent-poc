import type { CaseEventType, CaseInputType, CaseMemberRelation, CaseState } from '../cases';
import { TERMS } from './index';

// 案件的畫面標籤（MIL-115）。直接從這個檔案 import，不經 index.ts：index 不 re-export 它，避免循環載入。
// 用詞來源：GLOSSARY「案件與紀錄」「角色與合約地位」，稱謂取自 TERMS。
// 案件狀態與事件的識別字是程式內部的名稱，畫面一律從這裡取字，不直接顯示。

export const CASE_STATE_LABELS: Record<CaseState, string> = {
  draft: '草稿',
  signing: '簽署中',
  active: '生效中',
  move_out: '退租中',
  settling: '結算中',
  closed: '已結案',
  aborted: '已放棄',
  terminated: '已終止',
  expired: '已到期',
};

/** antd Tag 的顏色。只用語意色：進行中、成功、警告、預設（DESIGN.md「Colors」）。 */
export const CASE_STATE_COLORS: Record<CaseState, 'default' | 'processing' | 'success' | 'warning' | 'error'> = {
  draft: 'default',
  signing: 'processing',
  active: 'success',
  move_out: 'warning',
  settling: 'warning',
  closed: 'default',
  aborted: 'default',
  terminated: 'warning',
  expired: 'warning',
};

export const CASE_MEMBER_RELATION_LABELS: Record<CaseMemberRelation, string> = {
  lessor: TERMS.lessor,
  lessee: TERMS.lessee,
  co_lessee: '共同承租人',
  mandator: TERMS.mandator,
  mandatary: TERMS.mandatary,
  owner: '所有權人',
  practitioner: '簽章人員',
  broker: '經紀業者',
};

export const CASE_EVENT_LABELS: Record<CaseEventType, string> = {
  created: '建立案件',
  succeeded: '承接原租約，建立後繼案件',
  migrated: '由既有合約遷移建立',
  input_rejected: '案件未接受這次操作',
  contract_sent: '合約送簽',
  contract_completed: '合約全員簽署完成',
  contract_declined: '合約被拒簽',
  contract_voided: '合約撤回',
  aborted: '放棄案件',
  move_out_started: '發起退租',
  move_out_cancelled: '取消退租',
  move_out_inspection_completed: '退租點交完成',
  advanced_after_notice: '登錄催告後推進結算',
  closed: '結案',
  paper_contract_registered: '登錄紙本契約書',
  terminated: '終止委託',
  expired: '委託到期',
  handed_over: '移交生效',
  member_added: '加入案件成員',
  contract_attached: '掛上合約草稿',
  member_replaced: '更換成員的 email',
};

/** `input_rejected` 事件的 payload 帶被拒絕的輸入種類，畫面用這張表說明是哪一種操作。 */
export const CASE_INPUT_LABELS: Record<CaseInputType, string> = {
  contract_sent: '合約送簽',
  contract_completed: '合約簽署完成',
  contract_declined: '合約被拒簽',
  contract_voided: '合約撤回',
  abandon: '放棄案件',
  start_move_out: '發起退租',
  cancel_move_out: '取消退租',
  complete_move_out_inspection: '退租點交完成',
  advance_after_notice: '登錄催告後推進結算',
  close: '結案',
  register_paper_contract: '登錄紙本契約書',
  terminate_mandate: '終止委託',
  mandate_expired: '委託到期',
  handover_effective: '移交生效',
};
