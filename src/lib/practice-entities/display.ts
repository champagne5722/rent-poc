// 執業主體與審核台畫面用的標籤與格式（MIL-109）。純函式。用詞以 GLOSSARY.md 為準。

import type { CredentialState } from '../registry-rules';
import { statusLabelMap, statusPresentation, type StatusTone, type StatusView } from '../status-presentation';
import type { LicensePhase } from './applicant';

// 名稱與色調只有一份，在 src/lib/status-presentation.ts（MIL-181）。這裡把色調換成 antd Tag 的顏色名稱，給仍用舊介面的呼叫端。
const TONE_TO_TAG: Record<StatusTone, Tone> = {
  neutral: 'default',
  progress: 'processing',
  success: 'success',
  warning: 'warning',
  error: 'error',
};

const toView = (view: StatusView): { label: string; tone: Tone } => ({ label: view.label, tone: TONE_TO_TAG[view.tone] });

export const STATE_LABELS: Record<CredentialState, string> = statusLabelMap('credentialState');

export const stateLabel = (state: CredentialState): string => STATE_LABELS[state];

export type Tone = 'default' | 'processing' | 'warning' | 'success' | 'error';

export const phaseView = (phase: LicensePhase): { label: string; tone: Tone } => toView(statusPresentation('licensePhase', phase));

const QUEUE_TYPES: Record<string, string> = {
  license: '業別核對',
  certificate: '證書核對',
  employment: '任職核對',
  consent: '同意書核對',
  entity_recheck: '執業主體重查',
  employment_recheck: '任職重驗',
  entity_claim: '統編認領',
  // 產權的項目（MIL-144）
  anchor_collision: '撞號',
  anchor_collision_limit: '撞號超限',
  // 物件的文件核對（MIL-201）。名稱取自 GLOSSARY「審核台」
  leasing_authority: '出租權源',
  anchor_rekey: '修正建號',
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

// 證書、任職與同意書（MIL-111）。進度的標籤沿用業別的詞：待核對、待補件、已驗證、已失效。
export type PractitionerPhase = 'awaiting_review' | 'needs_resubmission' | 'verified' | 'lapsed' | 'not_submitted' | 'ended';

export const practitionerPhaseView = (phase: PractitionerPhase): { label: string; tone: Tone } =>
  toView(statusPresentation('practitionerPhase', phase));

/** 撞號項目宣稱的鍵，審核台顯示用，例如「臺北市 大安區 龍泉 一　建號 01234-000」。名稱缺少時退回編碼。 */
export function claimedKeyText(
  key: { cityCode: string; townCode: string; sectionCode: string; buildingNo: string; subNo: string },
  names: { cityName: string | null; townName: string | null; sectionName: string | null; sectionSubName: string | null } | null | undefined,
): string {
  const section = [names?.sectionName, names?.sectionSubName].filter(Boolean).join(' ');
  const place = [names?.cityName ?? key.cityCode, names?.townName ?? key.townCode, section || key.sectionCode].join(' ');
  return `${place}　建號 ${key.buildingNo}-${key.subNo}`;
}
