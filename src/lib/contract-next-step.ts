// 合約詳情頁「下一步」區塊的內容（MIL-175，ADR-0090）。純函式，client 與 server 都能引用。
// 每個合約狀態都要寫出下一步與負責人。業務規則（誰能送簽、誰輪到簽署）不在這裡，這裡只把既有的狀態翻成文字。
// 稱謂來自標籤對照表與 SIGNER_ROLE_LABELS，不另寫字串（MIL-122）。

import { partyLabels, type ContractType } from './labels';
import type { StatusTone } from './status-presentation';
import type { ContractStatus, SignerRole } from './types';
import { SIGNER_ROLE_LABELS } from './types';
import { signerRoleOfStatus } from './signing-steps';

/** 放在「下一步」區塊的動作。撤回處理簽署中的合約，複製為新草稿處理拒簽與撤回後的合約。 */
export const NEXT_STEP_ACTION_KEYS = ['void', 'copy'] as const;
export type NextStepActionKey = (typeof NEXT_STEP_ACTION_KEYS)[number];

/** 放在頁首的動作：進入編輯與下載文件。 */
export type HeaderActionKey = 'edit' | 'signed_pdf' | 'audit_trail';

export interface NextStepInput {
  status: ContractStatus;
  contractType: ContractType;
  /** 簽署進度的當前簽署人。沒有簽署任務的舊合約是 null。 */
  currentSigner: { role: SignerRole; name: string; email: string } | null;
  /** 拒簽的簽署人角色。沒有簽署進度時是 null，退回乙方（舊合約只有乙方會拒簽）。 */
  declinedRole: SignerRole | null;
  declinedReason: string | null;
  mock: boolean;
}

export interface ContractNextStep {
  /** 下一步要做的事，一句話。 */
  headline: string;
  /** 負責人。簽署中寫角色加姓名，其他狀態寫角色。 */
  owner: string;
  /** 補充說明，例如拒簽原因與聯絡信箱。沒有時是 null。 */
  detail: string | null;
  /** 色調沿用狀態呈現表的 5 種。 */
  tone: StatusTone;
  /** 放在這個區塊的動作。 */
  actionKeys: NextStepActionKey[];
}

export function contractNextStep(input: NextStepInput): ContractNextStep {
  const owner = partyLabels(input.contractType).partyAFull;
  switch (input.status) {
    case 'draft':
      return {
        headline: '完成欄位與簽署區後送簽',
        owner,
        detail: '草稿的欄位與簽署區都在建約流程內編輯，按右上「繼續編輯」進入。',
        tone: 'neutral',
        actionKeys: [],
      };
    case 'awaiting_tenant':
    case 'awaiting_practitioner':
    case 'awaiting_landlord': {
      const signer = input.currentSigner;
      const role = signer?.role ?? signerRoleOfStatus(input.status);
      const roleLabel = role ? SIGNER_ROLE_LABELS[role] : '簽署人';
      return {
        headline: `等待${roleLabel}簽署`,
        owner: signer ? `${roleLabel} ${signer.name}` : roleLabel,
        detail: signer ? `簽署通知寄到 ${signer.email}。需要更換簽署人時，先撤回再複製為新草稿。` : null,
        tone: 'progress',
        actionKeys: ['void'],
      };
    }
    case 'completed':
      return {
        headline: '下載已簽 PDF 與 Audit Trail File 留存',
        owner,
        detail: null,
        tone: 'success',
        actionKeys: [],
      };
    case 'declined': {
      const role = SIGNER_ROLE_LABELS[input.declinedRole ?? 'party_b'];
      return {
        headline: `${role}已拒簽，複製為新草稿調整後重新送簽`,
        owner,
        detail: input.declinedReason ? `拒簽原因：${input.declinedReason}` : null,
        tone: 'error',
        actionKeys: ['copy'],
      };
    }
    case 'voided':
      return {
        headline: '合約已撤回，複製為新草稿後重新送簽',
        owner,
        detail: null,
        tone: 'warning',
        actionKeys: ['copy'],
      };
  }
}

/**
 * 頁首的動作鍵：草稿是繼續編輯，已完成是下載文件。其他狀態頁首沒有動作，處理動作在「下一步」區塊。
 * mock 模式沒有真實簽署任務，點點簽端沒有 Audit Trail File 可下載。
 */
export function headerActionKeys(status: ContractStatus, opts: { mock: boolean }): HeaderActionKey[] {
  switch (status) {
    case 'draft':
      return ['edit'];
    case 'completed':
      return opts.mock ? ['signed_pdf'] : ['signed_pdf', 'audit_trail'];
    default:
      return [];
  }
}
