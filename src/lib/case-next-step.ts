// 案件詳情頁「下一步」區塊的內容（MIL-184，ADR-0090）。純函式，client 與 server 都能引用。
// 每個案件狀態都要寫出下一步與負責人。業務規則（誰能做什麼）不在這裡，這裡只把既有的狀態翻成文字。
// 負責人寫組織，不寫個人姓名：案件的狀態不記錄目前輪到誰。簽署輪到誰看合約詳情。

import type { CaseState } from './cases';
import { statusPresentation, type StatusTone } from './status-presentation';

export interface CaseNextStepInput {
  state: CaseState;
  /** 目前的組織是案件的主辦組織。別組織的成員只看得到進度，沒有待辦。 */
  isHost: boolean;
  /** 案件有目前合約。後繼案件與草稿被刪的案件沒有。 */
  hasCurrentContract: boolean;
}

export interface CaseNextStep {
  /** 下一步要做的事，一句話。 */
  headline: string;
  /** 負責人。 */
  owner: string;
  /** 補充說明。 */
  detail: string;
  /** 色調沿用狀態呈現表。 */
  tone: StatusTone;
  /** 下一步在合約頁處理時為 true，畫面放前往目前合約的連結。 */
  linkToContract: boolean;
}

const HOST = '主辦組織';

export function caseNextStep({ state, isHost, hasCurrentContract }: CaseNextStepInput): CaseNextStep {
  const tone = statusPresentation('case', state).tone;
  const step = (headline: string, detail: string, toContract = false): CaseNextStep => ({
    headline,
    owner: HOST,
    detail,
    tone,
    linkToContract: toContract && isHost && hasCurrentContract,
  });
  // 別組織的成員沒有待辦，只看進度
  if (!isHost) {
    switch (state) {
      case 'draft':
        return step('等待主辦組織完成合約', '主辦組織送簽後，簽署人會收到通知。');
      case 'signing':
        return step('等待合約全員簽署', '簽署完成後，案件進入生效中。');
      case 'active':
        return step('租期進行中', '帳務與合約變動會記在案件事件。');
      case 'move_out':
      case 'settling':
        return step('退租處理中', '主辦組織完成點交與結算後，案件結案。');
      default:
        return step('案件已結束', '沒有待辦事項。');
    }
  }
  switch (state) {
    case 'draft':
      return step('完成合約欄位與簽署區後送簽', '草稿在合約頁編輯與送簽。', true);
    case 'signing':
      return step('等待合約全員簽署', '輪到哪一位簽署人，看目前合約的簽署進度。', true);
    case 'active':
      return step('依期別登錄入帳', '租金與押金入帳在下方的帳務設定登錄。', true);
    case 'move_out':
      return step('完成退租點交', '點交完成後，案件進入結算中。', true);
    case 'settling':
      return step('完成押金結算與未結事項後結案', '押金餘額與結算單未完成時，案件不能結案。', true);
    case 'terminated':
      return step('委託已終止', '沒有待辦事項。');
    case 'expired':
      return step('委託已到期', '需要續約時，建立新的委託管理案件。');
    case 'closed':
      return step('案件已結案', '沒有待辦事項。');
    case 'aborted':
      return step('案件已放棄', '沒有待辦事項。');
  }
}
