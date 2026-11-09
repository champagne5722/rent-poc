// webhook 收件匣與計時器冪等紀錄（control schema）。
import type { ControlTableException, RlsRegistration } from './types';

const controlTables: Record<string, ControlTableException> = {
  'control.inbox_messages': {
    reason:
      'webhook 沒有組織脈絡，先寫這張表再處理（ADR-0020 決議 5、9）。只存標準化事件與 body 雜湊，不存原始 body。' +
      '處理時在組織交易內更新狀態，所以 app_rw 要有 UPDATE。事件到達的紀錄不刪',
    appRw: ['SELECT', 'INSERT', 'UPDATE'],
  },
  'control.timer_fires': {
    reason:
      '計時器的冪等紀錄，鍵是主體、事件、日期（ADR-0020 決議 7）。與計時器的效果同交易寫入，寫入後不變。' +
      '全域計時器沒有組織，所以 org_id 可為空',
    appRw: ['SELECT', 'INSERT'],
  },
};

export const inboxTimersRls: RlsRegistration = { controlTables };
