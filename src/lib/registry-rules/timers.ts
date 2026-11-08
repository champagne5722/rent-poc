// C 線 6 條計時器的決策與冪等鍵（MIL-100 Further Notes 的計時器表，ADR-0016 決議 18，ADR-0017 決議 8，ADR-0020）。
// 純函式，沒有 I/O。今天的日期由參數傳入（台灣日期，YYYY-MM-DD）。
// 函式只決定「這個主體今天要做什麼」。寫入、通知、刪檔由 scan-timers 的呼叫端依 idempotencyKey 去重後執行。
//
// 冪等鍵 = 主體、事件、日期，日期的取法有兩種：
//   - 當日觸發的提醒（換證窗口、期滿前 30 日）：只在觸發當日產生，日期是當日。
//   - 狀態驅動的計時器：條件首次成立的那一天（到期日），補跑多日也是同一把鍵。每月重查用年月。

import type { ManagementCaseState } from '../cases';
import { addDays, addMonths, isIsoDate } from './dates';
import { decideCredentialTransition, type CredentialState, type CredentialTransition } from './credential-transition';

/** 計時器的設定值。30 日與 6 個月都是假設（待法務確認，MIL-62）。 */
export interface TimerConfig {
  /** 換證窗口：期滿前幾個月進入窗口（P0-04 規則 6）。 */
  renewalWindowMonths: number;
  /** 期滿前幾日再提醒一次。 */
  renewalReminderDays: number;
  /** 任職上次核對後幾個月重驗。 */
  employmentRecheckMonths: number;
  /** 不符的證據檔與失效任職的同意書，幾日後刪除。 */
  evidencePurgeDays: number;
}

export const DEFAULT_TIMER_CONFIG: TimerConfig = {
  renewalWindowMonths: 6,
  renewalReminderDays: 30,
  employmentRecheckMonths: 6,
  evidencePurgeDays: 30,
};

export const TIMER_EVENTS = [
  'mandate_expired',
  'renewal_reminder_window',
  'renewal_reminder_30d',
  'cert_expired',
  'employment_recheck',
  'entity_recheck',
  'evidence_purge',
] as const;
export type TimerEvent = (typeof TIMER_EVENTS)[number];

export type NotificationRecipient = 'mandator' | 'practitioner' | 'practice_entity';

export interface TimerNotification {
  recipient: NotificationRecipient;
  /** 主體鍵加收件者。同一鍵重跑不重複寄。 */
  idempotencyKey: string;
}

export type TimerAction =
  | 'expire_mandate' // 委託管理案件轉 expired，並關閉受託人成員
  | 'notify' // 只通知
  | 'lapse_certificate' // 證書轉 lapsed
  | 'enqueue_review' // 產生審核台項目，不改狀態
  | 'purge_evidence'; // 刪除證據檔，並寫稽核事件

export interface TimerDecision {
  event: TimerEvent;
  subjectType: 'management_case' | 'certificate' | 'employment' | 'practice_entity' | 'evidence';
  subjectId: string;
  action: TimerAction;
  /** 冪等鍵用的日期（YYYY-MM-DD），每月重查是年月（YYYY-MM）。 */
  date: string;
  idempotencyKey: string;
  notifications: TimerNotification[];
  /** 只有 lapse_certificate 帶，是 decideCredentialTransition 的結果。 */
  transition?: CredentialTransition;
}

export function timerIdempotencyKey(subjectId: string, event: TimerEvent, date: string): string {
  return `${subjectId}:${event}:${date}`;
}

/**
 * 日期壞掉的資料略過，不拋例外。scanTimers 的一筆壞資料不會中斷整輪（ADR-0020 決議 7：一個任務失敗不影響其他任務）。
 * 資料本身的修正屬寫入端的責任。
 */
function allValid(...dates: Array<string | null>): boolean {
  return dates.every((d) => d !== null && isIsoDate(d));
}

function decision(
  base: Pick<TimerDecision, 'event' | 'subjectType' | 'subjectId' | 'action' | 'date'>,
  recipients: readonly NotificationRecipient[] = [],
  transition?: CredentialTransition,
): TimerDecision {
  const idempotencyKey = timerIdempotencyKey(base.subjectId, base.event, base.date);
  return {
    ...base,
    idempotencyKey,
    notifications: recipients.map((recipient) => ({ recipient, idempotencyKey: `${idempotencyKey}:${recipient}` })),
    ...(transition ? { transition } : {}),
  };
}

// ---------------------------------------------------------------- 1. 委託到期

export interface MandateFacts {
  caseId: string;
  state: ManagementCaseState;
  /** 委託期間的最後一天（含）。未定時是 null。 */
  validUntil: string | null;
}

export function decideMandateExpiry(mandate: MandateFacts, today: string): TimerDecision | null {
  if (mandate.state !== 'active' || mandate.validUntil === null) return null;
  if (!allValid(today, mandate.validUntil)) return null;
  if (today <= mandate.validUntil) return null;
  return decision(
    {
      event: 'mandate_expired',
      subjectType: 'management_case',
      subjectId: mandate.caseId,
      action: 'expire_mandate',
      date: addDays(mandate.validUntil, 1),
    },
    ['mandator'],
  );
}

// ---------------------------------------------------------------- 2. 換證窗口與期滿前提醒

/** 證書層的事實。practitionerId 是證書所在的執業人員 ID。 */
export interface CertificateFacts {
  practitionerId: string;
  state: CredentialState;
  validUntil: string | null;
}

/** 進入窗口當日與期滿前 N 日各提醒一次，只在當日產生。已驗證且未期滿的證書才提醒。 */
export function decideRenewalReminders(
  cert: CertificateFacts,
  today: string,
  config: TimerConfig = DEFAULT_TIMER_CONFIG,
): TimerDecision[] {
  if (cert.state !== 'verified' || cert.validUntil === null) return [];
  if (!allValid(today, cert.validUntil) || today > cert.validUntil) return [];

  const triggers: Array<['renewal_reminder_window' | 'renewal_reminder_30d', string]> = [
    ['renewal_reminder_window', addMonths(cert.validUntil, -config.renewalWindowMonths)],
    ['renewal_reminder_30d', addDays(cert.validUntil, -config.renewalReminderDays)],
  ];
  return triggers
    .filter(([, triggerDate]) => triggerDate === today)
    .map(([event]) =>
      decision(
        {
          event,
          subjectType: 'certificate',
          subjectId: cert.practitionerId,
          action: 'notify',
          date: today,
        },
        ['practitioner', 'practice_entity'],
      ),
    );
}

// ---------------------------------------------------------------- 3. 證書期滿

export function decideCertificateExpiry(cert: CertificateFacts, today: string): TimerDecision | null {
  if (!allValid(today)) return null;
  const transition = decideCredentialTransition(cert.state, {
    layer: 'practitioner',
    event: { type: 'expired', queryDate: today, validUntil: cert.validUntil },
  });
  if (!transition || cert.validUntil === null) return null;
  return decision(
    {
      event: 'cert_expired',
      subjectType: 'certificate',
      subjectId: cert.practitionerId,
      action: 'lapse_certificate',
      date: addDays(cert.validUntil, 1),
    },
    ['practitioner', 'practice_entity'],
    transition,
  );
}

// ---------------------------------------------------------------- 4. 任職重驗

export interface EmploymentFacts {
  employmentId: string;
  state: CredentialState;
  /** 任職最近一次核對的日期。 */
  lastCheckedOn: string;
}

/** 上次核對後滿 N 個月，產生審核台項目。不通知，不自動改狀態（ADR-0017 決議 8）。 */
export function decideEmploymentRecheck(
  employment: EmploymentFacts,
  today: string,
  config: TimerConfig = DEFAULT_TIMER_CONFIG,
): TimerDecision | null {
  if (employment.state !== 'verified' || !allValid(today, employment.lastCheckedOn)) return null;
  const dueOn = addMonths(employment.lastCheckedOn, config.employmentRecheckMonths);
  if (today < dueOn) return null;
  return decision({
    event: 'employment_recheck',
    subjectType: 'employment',
    subjectId: employment.employmentId,
    action: 'enqueue_review',
    date: dueOn,
  });
}

// ---------------------------------------------------------------- 5. 執業主體每月重查

export interface EntityFacts {
  entityId: string;
  /** 至少一個業別是已驗證。沒有的不用重查。 */
  hasVerifiedLicense: boolean;
}

/** 每月一個審核台項目。同月重跑得到同一把鍵。 */
export function decideEntityRecheck(entity: EntityFacts, today: string): TimerDecision | null {
  if (!entity.hasVerifiedLicense || !allValid(today)) return null;
  return decision({
    event: 'entity_recheck',
    subjectType: 'practice_entity',
    subjectId: entity.entityId,
    action: 'enqueue_review',
    date: today.slice(0, 7),
  });
}

// ---------------------------------------------------------------- 6. 證據檔刪除

export type EvidenceFacts =
  | {
      evidenceId: string;
      /** 證書影本、許可函、登記證（ADR-0017 補充）。 */
      kind: 'credential_copy';
      /** 最新一筆核對。相符的影本由核對流程當場刪除，計時器不處理。 */
      latestCheck: { result: 'match' | 'mismatch' | 'not_found' | 'revoked'; checkedOn: string } | null;
    }
  | {
      evidenceId: string;
      /** 經紀人員所屬業者的同意書。 */
      kind: 'consent_letter';
      /** 任職結束或同意書到期的日期。仍有效時是 null。 */
      endedOn: string | null;
    };

/** 不符的影本核對後滿 N 日刪除，同意書在任職結束或到期後滿 N 日刪除。 */
export function decideEvidencePurge(
  evidence: EvidenceFacts,
  today: string,
  config: TimerConfig = DEFAULT_TIMER_CONFIG,
): TimerDecision | null {
  let anchor: string | null;
  if (evidence.kind === 'credential_copy') {
    anchor = evidence.latestCheck && evidence.latestCheck.result !== 'match' ? evidence.latestCheck.checkedOn : null;
  } else {
    anchor = evidence.endedOn;
  }
  if (anchor === null || !allValid(today, anchor)) return null;

  const dueOn = addDays(anchor, config.evidencePurgeDays);
  if (today < dueOn) return null;
  return decision({
    event: 'evidence_purge',
    subjectType: 'evidence',
    subjectId: evidence.evidenceId,
    action: 'purge_evidence',
    date: dueOn,
  });
}

// ---------------------------------------------------------------- 彙整

export interface TimerFacts {
  mandates: readonly MandateFacts[];
  certificates: readonly CertificateFacts[];
  employments: readonly EmploymentFacts[];
  entities: readonly EntityFacts[];
  evidences: readonly EvidenceFacts[];
}

/** 掃一輪：依計時器順序輸出所有決策。同一輸入與同一天，輸出完全相同。 */
export function scanTimers(
  facts: TimerFacts,
  today: string,
  config: TimerConfig = DEFAULT_TIMER_CONFIG,
): TimerDecision[] {
  return [
    ...facts.mandates.flatMap((m) => decideMandateExpiry(m, today) ?? []),
    ...facts.certificates.flatMap((c) => decideRenewalReminders(c, today, config)),
    ...facts.certificates.flatMap((c) => decideCertificateExpiry(c, today) ?? []),
    ...facts.employments.flatMap((e) => decideEmploymentRecheck(e, today, config) ?? []),
    ...facts.entities.flatMap((e) => decideEntityRecheck(e, today) ?? []),
    ...facts.evidences.flatMap((e) => decideEvidencePurge(e, today, config) ?? []),
  ];
}
