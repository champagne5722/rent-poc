// 狀態呈現表（MIL-172、MIL-167、ADR-0090）：同一個狀態在每一頁同名、同色。
// 純資料與純函式，client 與 server 都能用。只管狀態的名稱與色調，狀態轉移不在這裡。
// 甲乙方與法定稱謂走 src/lib/labels 的標籤對照表（MIL-122）。合約狀態名稱含「甲方」「乙方」，
// 所以名稱沿用 types.ts 的 CONTRACT_STATUS_LABELS，這裡只決定色調。
// 新增狀態值時：型別（Record）會要求補進這張表，src/lib/status-presentation.test.ts 也會失敗。

import type { StatutoryCaseKind } from './cases/case-kind';
import type { CaseState } from './cases/transitions';
import type { HandoverState } from './handover/transitions';
import type { QueueStatus } from './practice-entities/queue-status';
import type { PeriodStatus } from './receivables';
import { CONTRACT_STATUS_LABELS, type ContractStatus } from './types';

/** 色調只有 5 種，對應 DESIGN.md 的語意色：中性（灰階）、進行中（primary）、成功、警告、錯誤。 */
export const STATUS_TONES = ['neutral', 'progress', 'success', 'warning', 'error'] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

/** 狀態種類與各自的狀態值。新增種類在這裡加一列，並在下方 PRESENTATION 補表。 */
export interface StatusValues {
  /** 合約狀態。 */
  contract: ContractStatus;
  /** 案件狀態（租賃案件與委託管理案件）。 */
  case: CaseState;
  /**
   * 案件種類（ADR-0030）：租賃、委託管理、包租、轉租。不是狀態，但名稱與色調同樣只能有一份。
   * 包租案件指屋主租給包租業者那一份。舊的業務類型值 `master_lease` 指轉租，見 cases/case-kind.ts。
   */
  caseKind: StatutoryCaseKind;
  /** 移交狀態。 */
  handover: HandoverState;
  /** 審核台項目的狀態。 */
  reviewItem: QueueStatus;
  /** 應收期別的入帳狀態（MIL-125）。逾期是顯示狀態：每日排程已判定逾期，而且期別仍未足額。 */
  receivablePeriod: PeriodStatus | 'overdue';
}
export type StatusKind = keyof StatusValues;
export type StatusValueOf<K extends StatusKind> = StatusValues[K];

export interface StatusView {
  label: string;
  tone: StatusTone;
}

const contractView = (status: ContractStatus, tone: StatusTone): StatusView => ({
  label: CONTRACT_STATUS_LABELS[status],
  tone,
});

const PRESENTATION: { [K in StatusKind]: Record<StatusValues[K], StatusView> } = {
  contract: {
    draft: contractView('draft', 'neutral'),
    awaiting_tenant: contractView('awaiting_tenant', 'progress'),
    awaiting_landlord: contractView('awaiting_landlord', 'progress'),
    awaiting_practitioner: contractView('awaiting_practitioner', 'progress'),
    completed: contractView('completed', 'success'),
    declined: contractView('declined', 'error'),
    voided: contractView('voided', 'warning'),
  },
  case: {
    draft: { label: '草稿', tone: 'neutral' },
    signing: { label: '簽署中', tone: 'progress' },
    active: { label: '生效中', tone: 'success' },
    move_out: { label: '退租中', tone: 'warning' },
    settling: { label: '結算中', tone: 'warning' },
    closed: { label: '已結案', tone: 'neutral' },
    aborted: { label: '已放棄', tone: 'neutral' },
    terminated: { label: '已終止', tone: 'warning' },
    expired: { label: '已到期', tone: 'warning' },
  },
  caseKind: {
    lease: { label: '租賃案件', tone: 'neutral' },
    management: { label: '委託管理案件', tone: 'neutral' },
    master_lease: { label: '包租案件', tone: 'neutral' },
    sublease: { label: '轉租案件', tone: 'neutral' },
  },
  handover: {
    draft: { label: '草稿', tone: 'neutral' },
    owner_confirmed: { label: '等待接收方接手', tone: 'progress' },
    accepted: { label: '等待生效', tone: 'progress' },
    released: { label: '交出側已生效', tone: 'warning' },
    completed: { label: '已完成', tone: 'success' },
    cancelled: { label: '已取消', tone: 'neutral' },
  },
  reviewItem: {
    open: { label: '待核對', tone: 'progress' },
    resolved: { label: '已結案', tone: 'neutral' },
  },
  receivablePeriod: {
    unpaid: { label: '未入帳', tone: 'neutral' },
    partial: { label: '部分入帳', tone: 'warning' },
    paid: { label: '已入帳', tone: 'success' },
    overdue: { label: '逾期', tone: 'error' },
    cancelled: { label: '已取消', tone: 'neutral' },
  },
};

/** 查某個狀態的名稱與色調。 */
export function statusPresentation<K extends StatusKind>(kind: K, value: StatusValues[K]): StatusView {
  return (PRESENTATION[kind] as Record<StatusValues[K], StatusView>)[value];
}

/** 色調對應 antd Tag 的語意色（antd 依 DESIGN.md 的 semantic-* 與 primary 派生）。 */
export type TagColor = 'default' | 'processing' | 'success' | 'warning' | 'error';

const TONE_TAG_COLORS: Record<StatusTone, TagColor> = {
  neutral: 'default',
  progress: 'processing',
  success: 'success',
  warning: 'warning',
  error: 'error',
};

export const toneTagColor = (tone: StatusTone): TagColor => TONE_TAG_COLORS[tone];

/** 某一種狀態的「值 → 名稱」對照。給仍用舊 LABELS 常數的呼叫端，讓名稱只有一份定義。 */
export function statusLabelMap<K extends StatusKind>(kind: K): Record<StatusValues[K], string> {
  const table = PRESENTATION[kind] as Record<StatusValues[K], StatusView>;
  return Object.fromEntries(Object.entries(table).map(([value, view]) => [value, (view as StatusView).label])) as Record<
    StatusValues[K],
    string
  >;
}

/** 某一種狀態的「值 → antd Tag 顏色」對照。給仍用舊 COLORS 常數的呼叫端，讓顏色只有一份定義。 */
export function statusTagColorMap<K extends StatusKind>(kind: K): Record<StatusValues[K], TagColor> {
  const table = PRESENTATION[kind] as Record<StatusValues[K], StatusView>;
  return Object.fromEntries(
    Object.entries(table).map(([value, view]) => [value, toneTagColor((view as StatusView).tone)]),
  ) as Record<StatusValues[K], TagColor>;
}
