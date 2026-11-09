// 簽署中失效的型別（MIL-75）。純型別，client 與 server 都能引用。

/**
 * 失效紀錄的處理狀態。
 * - `void_pending`：簽署進度已推進，任務未結束，等交易提交後自動撤回。程序在撤回前中斷時會停在這裡。
 * - `void_failed`：自動撤回失敗，使用者必須手動撤回（ADR-0021 決議 7）。
 * - `voided`：合約已撤回，自動或手動。
 * - `completed_lapsed`：任務已全員完成，合約維持完成，只留下事實與警示。
 * - `task_ended`：撤回前任務因其他原因結束（例如有人拒簽），不需處理。
 */
export const SIGNING_LAPSE_STATES = ['void_pending', 'void_failed', 'voided', 'completed_lapsed', 'task_ended'] as const;
export type SigningLapseState = (typeof SIGNING_LAPSE_STATES)[number];

/** 詳情頁用的失效紀錄，含簽署人姓名。 */
export interface SigningLapseDetail {
  id: string;
  contractId: string;
  signerId: string;
  signerName: string;
  /** 席位的 rule_id。 */
  ruleId: string;
  state: SigningLapseState;
  /** 不可簽章的原因，一項一句。 */
  reasons: string[];
  /** 簽署事件時間，ISO 8601。 */
  eventAt: string;
  /** 自動撤回失敗的原因。沒有失敗時是 null。 */
  voidError: string | null;
  createdAt: string;
  updatedAt: string;
}
