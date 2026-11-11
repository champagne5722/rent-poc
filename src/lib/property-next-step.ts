// 物件詳情頁「下一步」區塊的內容（MIL-177，ADR-0090）。純函式，client 與 server 都能引用。
// 每種核對狀態都要寫出下一步與負責人。業務規則（誰能送件、誰能判定）不在這裡，這裡只把既有的狀態翻成文字。
// 核對狀態只來自 verification_status 與節點狀態，不讀內部狀態。別的組織有沒有登錄過同一個建號，文字看不出來（ADR-0028 決議 1）。
// 文案不得暗示平台核對具法律效力（ADR-0007、ADR-0026 決議 7）。

import type { StatusTone } from './status-presentation';
import type { OwnershipNodeStatus, PropertyVerificationStatus } from './types';

export interface PropertyNextStepInput {
  archived: boolean;
  /** 物件有沒有建號。沒填建號的舊資料是 false。 */
  hasKey: boolean;
  verificationStatus: PropertyVerificationStatus;
  /** 所有權節點的狀態。還沒送過文件是 null。 */
  nodeStatus: OwnershipNodeStatus | null;
  /** 給使用者看的固定訊息。文件不符時是不符項目對應的訊息。 */
  messages: readonly string[];
}

export interface PropertyNextStep {
  /** 下一步要做的事，一句話。 */
  headline: string;
  /** 負責人。 */
  owner: string;
  detail: string | null;
  tone: StatusTone;
}

const OWNER_ORG = '你的組織';

export function propertyNextStep(input: PropertyNextStepInput): PropertyNextStep {
  if (input.archived) {
    return {
      headline: '物件已封存，只能查看',
      owner: '無',
      detail: '封存的物件不能編輯、建立合約或新增分租單位。',
      tone: 'neutral',
    };
  }
  if (!input.hasKey) {
    return { headline: '補上建號，平台才能核對文件', owner: OWNER_ORG, detail: null, tone: 'warning' };
  }
  switch (input.verificationStatus) {
    case 'verified':
      return { headline: '物件已核對，可以建立合約', owner: OWNER_ORG, detail: null, tone: 'success' };
    case 'failed':
      return {
        headline: '修正文件後，重新送出謄本',
        owner: OWNER_ORG,
        detail: input.messages[0] ?? null,
        tone: 'error',
      };
    case 'pending_verification':
      if (input.nodeStatus === 'pending_verification') {
        return {
          headline: '平台核對文件中',
          owner: '平台營運者',
          detail: '核對完成後，會用站內通知告訴你結果。',
          tone: 'progress',
        };
      }
      return { headline: '上傳謄本，請平台核對文件', owner: OWNER_ORG, detail: null, tone: 'warning' };
  }
}
