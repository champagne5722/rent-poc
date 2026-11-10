// 狀態呈現表（MIL-172、MIL-167、ADR-0090）：同一個狀態在每一頁同名、同色。
// 純資料與純函式，client 與 server 都能用。只管狀態的名稱與色調，狀態轉移不在這裡。
// 甲乙方與法定稱謂走 src/lib/labels 的標籤對照表（MIL-122）。合約狀態名稱含「甲方」「乙方」，
// 所以名稱沿用 types.ts 的 CONTRACT_STATUS_LABELS，這裡只決定色調。
// 新增狀態值時：型別（Record）會要求補進這張表，src/lib/status-presentation.test.ts 也會失敗。

import type { StatutoryCaseKind } from './cases/case-kind';
import type { CaseState } from './cases/transitions';
import type { HandoverState } from './handover/transitions';
import type { DocumentCheckResult, OwnershipItemStatus } from './ownership/review-status';
import type { LicensePhase } from './practice-entities/applicant';
import type { QueueStatus } from './practice-entities/queue-status';
import type { CredentialState } from './registry-rules';
import type { PractitionerPhase } from './practice-entities/display';
import type { PeriodStatus } from './receivables';
import { CONTRACT_STATUS_LABELS, type ContractStatus, type PropertyVerificationStatus } from './types';

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
  /** 物件對外的文件核對狀態（MIL-196，ADR-0028 決議 2）。只由文件核對決定，不讀 registry.anchors.status。 */
  propertyVerification: PropertyVerificationStatus;
  /** 審核台出租權源項目的狀態（MIL-201）。只給平台營運者看，登錄的一方看不到 held。 */
  ownershipItem: OwnershipItemStatus;
  /** 文件核對的單項比對結果：建號是否與謄本相符、登記名義人是否與主張的所有權人相符（MIL-201）。 */
  documentCheck: DocumentCheckResult;
  /** 收款帳戶的使用狀態（MIL-181）。 */
  paymentAccount: 'active' | 'inactive';
  /** 執業主體各業別的送件進度（MIL-181）。「尚未送件」是這個種類唯一的名稱，證書端的進度共用同一個詞。 */
  licensePhase: LicensePhase;
  /** 執業人員證書、任職與同意書的進度（MIL-181）。 */
  practitionerPhase: PractitionerPhase;
  /** 業別或證書的驗證狀態（MIL-181）：待驗證、已驗證、已失效。 */
  credentialState: CredentialState;
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
  propertyVerification: {
    // 「已核對」的說明文字固定為「平台已比對出租權源文件」（VERIFIED_NOTE，src/lib/ownership/messages.ts），不寫成保證
    pending_verification: { label: '待平台核對文件', tone: 'progress' },
    verified: { label: '已核對', tone: 'success' },
    failed: { label: '文件不符', tone: 'error' },
  },
  ownershipItem: {
    pending: { label: '待核對', tone: 'progress' },
    overdue: { label: '超過 1 個工作日', tone: 'warning' },
    held: { label: '待處理', tone: 'warning' },
    verified: { label: '已通過', tone: 'success' },
    failed: { label: '不符', tone: 'error' },
    superseded: { label: '已被取代', tone: 'neutral' },
  },
  documentCheck: {
    pending: { label: '待判定', tone: 'neutral' },
    match: { label: '相符', tone: 'success' },
    mismatch: { label: '不符', tone: 'error' },
  },
  paymentAccount: {
    active: { label: '使用中', tone: 'success' },
    inactive: { label: '已停用', tone: 'neutral' },
  },
  licensePhase: {
    not_submitted: { label: '尚未送件', tone: 'neutral' },
    awaiting_review: { label: '待核對', tone: 'progress' },
    needs_resubmission: { label: '待補件', tone: 'warning' },
    verified: { label: '已驗證', tone: 'success' },
    lapsed: { label: '已失效', tone: 'error' },
  },
  practitionerPhase: {
    not_submitted: { label: '尚未送件', tone: 'neutral' },
    awaiting_review: { label: '待核對', tone: 'progress' },
    needs_resubmission: { label: '待補件', tone: 'warning' },
    verified: { label: '已驗證', tone: 'success' },
    lapsed: { label: '已失效', tone: 'error' },
    ended: { label: '已失效', tone: 'error' },
  },
  credentialState: {
    pending: { label: '待驗證', tone: 'neutral' },
    verified: { label: '已驗證', tone: 'success' },
    lapsed: { label: '已失效', tone: 'error' },
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
