// 驗證狀態機（ADR-0017 決議 3、4、5）。純函式，沒有 I/O。
// 業別、證書、任職三層共用同一張轉移表。不接受時回傳 null，寫法沿用 src/lib/transitions.ts 的 decideTransition。
// 寫入、核對紀錄與稽核事件由呼叫端負責，見同目錄 README.md。

import { isIsoDate } from './dates';

/** 驗證三態（ADR-0017 決議 3）。 */
export const CREDENTIAL_STATES = ['pending', 'verified', 'lapsed'] as const;
export type CredentialState = (typeof CREDENTIAL_STATES)[number];

/** 驗證狀態放在三層（ADR-0017 決議 5）。執業主體本身不存狀態。 */
export const CREDENTIAL_LAYERS = ['license', 'practitioner', 'employment'] as const;
export type CredentialLayer = (typeof CREDENTIAL_LAYERS)[number];

export type CredentialEvent =
  /** 新送件。必填欄位齊全才接受。 */
  | { type: 'submitted'; requiredFieldsComplete: boolean }
  /** 核對相符。違反專任排除約束時不接受（ADR-0017 決議 7 第 2 點）。 */
  | { type: 'check_matched'; violatesExclusivity: boolean }
  /** 核對不符或查無資料。維持待驗證，等補件。 */
  | { type: 'check_mismatched' }
  /** 補件，或失效後換證、恢復登記。 */
  | { type: 'resubmitted' }
  /** 新效期核對相符。 */
  | { type: 'renewed'; newValidUntil: string }
  /** 查詢日晚於 valid_until。日期是 YYYY-MM-DD。 */
  | { type: 'expired'; queryDate: string; validUntil: string | null }
  /** 重驗發現廢止或與登錄不符。 */
  | { type: 'revoked' }
  /** 業別層：登記狀態不是核准設立。 */
  | { type: 'registration_lost' }
  /** 任職層：任職結束。 */
  | { type: 'employment_ended' }
  /** 任職層：同意書撤回或到期。 */
  | { type: 'consent_ended' };

export type CredentialEventType = CredentialEvent['type'];

export interface CredentialInput {
  layer: CredentialLayer;
  event: CredentialEvent;
}

export interface CredentialTransition {
  from: CredentialState | null;
  to: CredentialState;
  event: CredentialEventType;
  /** 只有 renewed 帶，呼叫端用它更新 valid_until。 */
  validUntil?: string;
}

/** 轉移表：目前狀態（無 = null）乘事件，得到下一狀態。 */
const NEXT: Record<'none' | CredentialState, Partial<Record<CredentialEventType, CredentialState>>> = {
  none: { submitted: 'pending' },
  pending: { check_matched: 'verified', check_mismatched: 'pending', resubmitted: 'pending' },
  verified: {
    renewed: 'verified',
    expired: 'lapsed',
    revoked: 'lapsed',
    registration_lost: 'lapsed',
    employment_ended: 'lapsed',
    consent_ended: 'lapsed',
  },
  lapsed: { resubmitted: 'pending' },
};

/**
 * 事件只適用在這些層。沒列的事件三層都適用。
 * 效期（renewed、expired）只有業別與證書有。任職走 employment_ended 與 consent_ended。
 */
const LAYER_ONLY: Partial<Record<CredentialEventType, readonly CredentialLayer[]>> = {
  renewed: ['license', 'practitioner'],
  expired: ['license', 'practitioner'],
  registration_lost: ['license'],
  employment_ended: ['employment'],
  consent_ended: ['employment'],
};

/**
 * 決定一次驗證狀態轉移。不接受時回傳 null。
 * 新任職建新列，所以失效的任職不得 resubmitted（ADR-0017 決議 4）。
 */
export function decideCredentialTransition(
  state: CredentialState | null,
  input: CredentialInput,
): CredentialTransition | null {
  const { layer, event } = input;
  const allowedLayers = LAYER_ONLY[event.type];
  if (allowedLayers && !allowedLayers.includes(layer)) return null;
  if (layer === 'employment' && state === 'lapsed' && event.type === 'resubmitted') return null;

  const to = NEXT[state ?? 'none'][event.type];
  if (!to) return null;

  switch (event.type) {
    case 'submitted':
      if (!event.requiredFieldsComplete) return null;
      break;
    case 'check_matched':
      if (event.violatesExclusivity) return null;
      break;
    case 'renewed':
      if (!isIsoDate(event.newValidUntil)) return null;
      return { from: state, to, event: event.type, validUntil: event.newValidUntil };
    case 'expired':
      if (event.validUntil === null || !isIsoDate(event.validUntil) || !isIsoDate(event.queryDate)) return null;
      // YYYY-MM-DD 字串可直接比大小。valid_until 當天仍有效。
      if (event.queryDate <= event.validUntil) return null;
      break;
  }
  return { from: state, to, event: event.type };
}
