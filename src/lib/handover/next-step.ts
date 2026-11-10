// 移交詳情頁「下一步」區塊的內容（MIL-182，ADR-0090）。純函式，client 與 server 都能引用。
// 每個移交狀態都要寫出下一步與負責人。業務規則（誰能確認、何時生效）不在這裡，這裡只把既有的狀態翻成文字。
// 文案不暗示平台歷程具法律效力（ADR-0007）。

import type { StatusTone } from '../status-presentation';
import type { HandoverState } from './transitions';

/** 看這一頁的人：屋主，或後台的接收方、交出方。 */
export type HandoverViewer = 'owner' | 'receiver' | 'releaser';

export interface HandoverNextStep {
  /** 下一步要做的事，一句話。 */
  headline: string;
  /** 負責人。 */
  owner: string;
  /** 補充說明。沒有時是 null。 */
  detail: string | null;
  tone: StatusTone;
}

const OWNER = '屋主';
const RECEIVER = '接收方';
const SYSTEM = '系統';

export function handoverNextStep(state: HandoverState, viewer: HandoverViewer, effectiveDate: string | null): HandoverNextStep {
  switch (state) {
    case 'draft':
      return {
        headline: '檢查移交包並確認移交',
        owner: OWNER,
        detail: '每個缺項都要勾選知悉，並選好接手的人，才能確認。',
        tone: 'neutral',
      };
    case 'owner_confirmed':
      return {
        headline: '確認接手並指定生效日',
        owner: RECEIVER,
        detail: viewer === 'owner' ? '接收方確認前，你仍能取消移交。' : null,
        tone: 'progress',
      };
    case 'accepted':
      return {
        headline: effectiveDate ? `等待生效日 ${effectiveDate}` : '等待生效日',
        owner: SYSTEM,
        detail: '生效日到達時，系統先完成交出側，再完成接收側。',
        tone: 'progress',
      };
    case 'released':
      return {
        headline: '完成接收側',
        owner: SYSTEM,
        detail: '交出側已完成，這個階段不能取消。接收側完成後才能匯出移交包。',
        tone: 'warning',
      };
    case 'completed':
      return {
        headline: '匯出移交包存檔',
        owner: viewer === 'owner' ? OWNER : viewer === 'receiver' ? RECEIVER : '交出方',
        detail: null,
        tone: 'success',
      };
    case 'cancelled':
      return {
        headline: '需要移交時重新發起',
        owner: OWNER,
        detail: '這個移交已取消，租賃單位沒有進行中的移交。',
        tone: 'neutral',
      };
  }
}
