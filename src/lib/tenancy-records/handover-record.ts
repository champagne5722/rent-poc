// 點交紀錄的狀態轉移（MIL-135、MIL-136、ADR-0051 決議 3、PRD P0-17）。
// 入住與退租兩次點交共用。純函式，沒有 I/O。
// 誰有權送出或確認（出租人、委託範圍含點交的代管業者、承租人）由呼叫端的 repository 檢查，這裡只管狀態。

export const HANDOVER_RECORD_STATES = ['draft', 'pending_lessee_confirmation', 'confirmed'] as const;
export type HandoverRecordState = (typeof HANDOVER_RECORD_STATES)[number];

// submit：出租方送出，視為出租方確認。lessee_confirm：承租人確認。
// edit_content：修改照片、度數或逐列狀態。add_supplement：新增補充紀錄（含承租人的不同意見）。
export const HANDOVER_RECORD_INPUT_TYPES = ['submit', 'lessee_confirm', 'edit_content', 'add_supplement'] as const;
export type HandoverRecordInputType = (typeof HANDOVER_RECORD_INPUT_TYPES)[number];

export interface HandoverRecordInput {
  type: HandoverRecordInputType;
}

/** 稽核事件型別，與輸入一對一。 */
export type HandoverRecordEventType = `handover_record_${HandoverRecordInputType}`;

export type HandoverRecordRejection =
  | 'invalid_transition'
  /** 已送出的紀錄不得改內容，只得新增補充紀錄。 */
  | 'immutable_use_supplement';

export type HandoverRecordTransitionResult =
  | { ok: true; state: HandoverRecordState; event: HandoverRecordEventType }
  | { ok: false; reason: HandoverRecordRejection };

type Rule = { to: HandoverRecordState } | { reject: HandoverRecordRejection };

// 草稿才能改內容。已送出（待承租人確認）改內容會讓出租方確認失效，所以也拒絕。
// 補充紀錄在待承租人確認與已確認都允許，草稿不允許。承租人不同意時不必先確認。
const RULES: Record<HandoverRecordState, Partial<Record<HandoverRecordInputType, Rule>>> = {
  draft: {
    submit: { to: 'pending_lessee_confirmation' },
    edit_content: { to: 'draft' },
  },
  pending_lessee_confirmation: {
    lessee_confirm: { to: 'confirmed' },
    edit_content: { reject: 'immutable_use_supplement' },
    add_supplement: { to: 'pending_lessee_confirmation' },
  },
  confirmed: {
    edit_content: { reject: 'immutable_use_supplement' },
    add_supplement: { to: 'confirmed' },
  },
};

/** 由目前狀態與輸入決定下一狀態與稽核事件。 */
export function decideHandoverRecordTransition(
  state: HandoverRecordState,
  input: HandoverRecordInput,
): HandoverRecordTransitionResult {
  const rule = RULES[state]?.[input.type];
  if (!rule) return { ok: false, reason: 'invalid_transition' };
  if ('reject' in rule) return { ok: false, reason: rule.reject };
  return { ok: true, state: rule.to, event: `handover_record_${input.type}` };
}

export interface HandoverConfirmations {
  lessor: boolean;
  lessee: boolean;
}

/** 誰已確認。送出視為出租方確認，所以離開草稿後出租方即已確認。 */
export function handoverConfirmations(state: HandoverRecordState): HandoverConfirmations {
  return {
    lessor: state !== 'draft',
    lessee: state === 'confirmed',
  };
}
