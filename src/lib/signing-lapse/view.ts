// 合約詳情頁「簽署中失效」警示的資料整理（MIL-75，ADR-0018 決議 11、ADR-0021 決議 6、7）。
// 純函式，client 與 server 都能引用。畫面只呈現，不判斷哪個狀態出哪則警示。

import { formatTaiwanTime } from '../signature-records/view';
import type { ContractStatus } from '../types';
import { isSigningStatus } from '../types';
import type { SigningLapseDetail } from './types';

export interface LapseAlert {
  key: string;
  type: 'error' | 'warning' | 'info';
  title: string;
  description: string;
  /** 顯示撤回按鈕。按鈕走既有的撤回 route。 */
  canVoid: boolean;
}

function reasonText(lapse: SigningLapseDetail): string {
  const reasons = lapse.reasons.length > 0 ? lapse.reasons.join('、') : '登錄資料不符可簽章條件';
  return `簽署事件時間 ${formatTaiwanTime(lapse.eventAt)}，${reasons}。`;
}

function alertOf(lapse: SigningLapseDetail, status: ContractStatus): LapseAlert | null {
  const key = String(lapse.id);
  const who = lapse.signerName;
  switch (lapse.state) {
    case 'void_failed':
      if (!isSigningStatus(status)) return null;
      return {
        key,
        type: 'error',
        title: `${who}簽署時不可簽章，自動撤回失敗`,
        description:
          `${reasonText(lapse)}失敗原因：${lapse.voidError ?? '未知原因'}。` +
          '請按「撤回」手動撤回，再複製為新草稿，改派執業人員後重新送簽。',
        canVoid: true,
      };
    case 'void_pending':
      if (!isSigningStatus(status)) return null;
      return {
        key,
        type: 'warning',
        title: `${who}簽署時不可簽章，系統正在自動撤回`,
        description: `${reasonText(lapse)}如果合約持續停在簽署中，請按「撤回」手動撤回。`,
        canVoid: true,
      };
    case 'completed_lapsed':
      if (status !== 'completed') return null;
      return {
        key,
        type: 'warning',
        title: `${who}簽署時不可簽章，合約維持已完成`,
        description:
          `${reasonText(lapse)}簽署已經發生，系統不會撤回已完成的合約。` +
          '請通知執業主體與平台營運者處理。',
        canVoid: false,
      };
    case 'voided':
      if (status !== 'voided') return null;
      return {
        key,
        type: 'info',
        title: `${who}簽署時不可簽章，合約已撤回`,
        description: `${reasonText(lapse)}請複製為新草稿，改派執業人員後重新送簽。新草稿必須全員重簽。`,
        canVoid: false,
      };
    case 'task_ended':
      return null;
  }
}

export function lapseAlerts(lapses: readonly SigningLapseDetail[], status: ContractStatus): LapseAlert[] {
  return lapses.flatMap((lapse) => alertOf(lapse, status) ?? []);
}
