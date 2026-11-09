// 執業主體與審核台畫面用的標籤與格式（MIL-109）。純函式。用詞以 GLOSSARY.md 為準。

import type { CredentialState } from '../registry-rules';
import type { LicensePhase } from './applicant';

export const STATE_LABELS: Record<CredentialState, string> = {
  pending: '待驗證',
  verified: '已驗證',
  lapsed: '已失效',
};

export const stateLabel = (state: CredentialState): string => STATE_LABELS[state];

export type Tone = 'default' | 'processing' | 'warning' | 'success' | 'error';

const PHASES: Record<LicensePhase, { label: string; tone: Tone }> = {
  not_submitted: { label: '尚未送件', tone: 'default' },
  awaiting_review: { label: '待核對', tone: 'processing' },
  needs_resubmission: { label: '待補件', tone: 'warning' },
  verified: { label: '已驗證', tone: 'success' },
  lapsed: { label: '已失效', tone: 'error' },
};

export const phaseView = (phase: LicensePhase): { label: string; tone: Tone } => PHASES[phase];

const QUEUE_TYPES: Record<string, string> = {
  license: '業別核對',
  certificate: '證書核對',
  employment: '任職核對',
  consent: '同意書核對',
  entity_recheck: '執業主體重查',
  employment_recheck: '任職重驗',
  entity_claim: '統編認領',
};

export const queueTypeLabel = (type: string): string => QUEUE_TYPES[type] ?? type;

const RESOLUTIONS: Record<string, string> = {
  match: '相符',
  mismatch: '不符',
  not_found: '查無資料',
  revoked: '廢止',
  claim_to_claimant: '改歸認領方',
  claim_keep_registrant: '維持原登錄者',
  superseded: '已被取代',
};

export const resolutionLabel = (resolution: string | null): string => (resolution ? (RESOLUTIONS[resolution] ?? resolution) : '');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 等待時間取最大的單位並捨去小數：不到 1 分鐘、N 分鐘、N 小時、N 天。 */
export function formatWaiting(ms: number): string {
  const value = Math.max(0, ms);
  if (value < MINUTE) return '不到 1 分鐘';
  if (value < HOUR) return `${Math.floor(value / MINUTE)} 分鐘`;
  if (value < DAY) return `${Math.floor(value / HOUR)} 小時`;
  return `${Math.floor(value / DAY)} 天`;
}

/** 待審超過 3 日。ADR-0017 決議 12 寫 3 個工作天，這裡用日曆天近似（假設）。 */
export const BACKLOG_MS = 3 * DAY;
export const isBacklogged = (waitingMs: number): boolean => waitingMs > BACKLOG_MS;
