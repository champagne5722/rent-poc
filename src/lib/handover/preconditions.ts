// 移交的擋下條件（MIL-94「擋下條件」、ADR-0024 決議 12、P0-22 規則 1、2）。
// 純函式，比照送簽檢查回傳全部原因。屋主確認、接手、生效處理三個時點都呼叫它。

/** 執業主體的驗證狀態（ADR-0017 決議 3）。 */
export type PracticeEntityStatus = 'pending' | 'verified' | 'lapsed';

/** 接收方涵蓋該租賃單位的委託：有效的委託管理案件、上傳的紙本契約書，或都沒有。 */
export type ReceiverMandate = 'valid' | 'paper' | 'none';

export type HandoverTargetFacts =
  | { kind: 'mandatary'; mandate: ReceiverMandate; practiceEntityStatus: PracticeEntityStatus }
  | { kind: 'self_managed' };

export interface HandoverPreconditionFacts {
  hasActiveSigningTask: boolean;
  /** 還沒選接收方時是 null，只查與接收方無關的條件。 */
  target: HandoverTargetFacts | null;
  /** YYYY-MM-DD。還沒指定時是 null。 */
  effectiveDate: string | null;
  /** YYYY-MM-DD，以台灣時間為準。 */
  today: string;
}

export type HandoverBlockCode =
  | 'active_signing_task'
  | 'no_valid_mandate'
  | 'receiver_not_verified'
  | 'effective_date_in_past';

export interface HandoverBlockReason {
  code: HandoverBlockCode;
  message: string;
}

const MESSAGES: Record<HandoverBlockCode, string> = {
  active_signing_task: '這個案件有進行中的簽署任務。簽署完成或撤回後才能移交。',
  no_valid_mandate: '新受託人沒有涵蓋這個租賃單位的有效委託。請先與新受託人簽訂委託管理合約，或上傳紙本契約書。',
  receiver_not_verified: '新受託人的執業主體不是已驗證，不能接手。',
  effective_date_in_past: '生效日早於今天。請選今天或之後的日期。',
};

export function checkHandoverPreconditions(facts: HandoverPreconditionFacts): HandoverBlockReason[] {
  const codes: HandoverBlockCode[] = [];
  if (facts.hasActiveSigningTask) codes.push('active_signing_task');

  // 改自管時接收方是屋主組織，沒有委託也沒有執業主體，兩項都免查
  if (facts.target?.kind === 'mandatary') {
    if (facts.target.mandate === 'none') codes.push('no_valid_mandate');
    if (facts.target.practiceEntityStatus !== 'verified') codes.push('receiver_not_verified');
  }

  // YYYY-MM-DD 字串可以直接比大小
  if (facts.effectiveDate !== null && facts.effectiveDate < facts.today) codes.push('effective_date_in_past');

  return codes.map((code) => ({ code, message: MESSAGES[code] }));
}
