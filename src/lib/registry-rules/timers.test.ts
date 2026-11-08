import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMER_CONFIG,
  decideCertificateExpiry,
  decideEmploymentRecheck,
  decideEntityRecheck,
  decideEvidencePurge,
  decideMandateExpiry,
  decideRenewalReminders,
  scanTimers,
  timerIdempotencyKey,
  type TimerConfig,
} from './timers';

describe('設定值與冪等鍵', () => {
  it('預設：窗口 6 個月、期滿前 30 日、任職重驗 6 個月、證據檔 30 日', () => {
    expect(DEFAULT_TIMER_CONFIG).toEqual({
      renewalWindowMonths: 6,
      renewalReminderDays: 30,
      employmentRecheckMonths: 6,
      evidencePurgeDays: 30,
    });
  });

  it('冪等鍵是主體、事件與日期', () => {
    expect(timerIdempotencyKey('cert-1', 'cert_expired', '2026-11-09')).toBe('cert-1:cert_expired:2026-11-09');
  });
});

describe('委託到期 decideMandateExpiry', () => {
  const m = (state: 'active' | 'draft' | 'signing' | 'expired' | 'terminated' | 'aborted', validUntil: string | null) => ({
    caseId: 'mcase-1',
    state,
    validUntil,
  });

  it.each([
    ['查詢日晚於迄日', 'active', '2026-11-07', '2026-11-08', true],
    ['迄日當天仍有效', 'active', '2026-11-08', '2026-11-08', false],
    ['迄日在未來', 'active', '2026-12-31', '2026-11-08', false],
    ['未定迄日不會到期', 'active', null, '2026-11-08', false],
    ['已經 expired', 'expired', '2026-11-07', '2026-11-08', false],
    ['已終止', 'terminated', '2026-11-07', '2026-11-08', false],
    ['草稿', 'draft', '2026-11-07', '2026-11-08', false],
  ] as const)('%s', (_name, state, validUntil, today, due) => {
    expect(decideMandateExpiry(m(state, validUntil), today) !== null).toBe(due);
  });

  it('轉 expired、關閉受託人成員、通知屋主 1 次，鍵的日期是迄日隔天', () => {
    expect(decideMandateExpiry(m('active', '2026-11-07'), '2026-11-20')).toEqual({
      event: 'mandate_expired',
      subjectType: 'management_case',
      subjectId: 'mcase-1',
      action: 'expire_mandate',
      date: '2026-11-08',
      idempotencyKey: 'mcase-1:mandate_expired:2026-11-08',
      notifications: [{ recipient: 'mandator', idempotencyKey: 'mcase-1:mandate_expired:2026-11-08:mandator' }],
    });
  });

  it('重跑同一天、隔天，冪等鍵不變', () => {
    const a = decideMandateExpiry(m('active', '2026-11-07'), '2026-11-08');
    const b = decideMandateExpiry(m('active', '2026-11-07'), '2026-11-09');
    expect(a?.idempotencyKey).toBe(b?.idempotencyKey);
  });
});

describe('換證窗口與期滿前提醒 decideRenewalReminders', () => {
  const cert = (validUntil: string | null, state: 'verified' | 'pending' | 'lapsed' = 'verified') => ({
    practitionerId: 'prac-1',
    state,
    validUntil,
  });
  const events = (c: ReturnType<typeof cert>, today: string, config?: TimerConfig) =>
    decideRenewalReminders(c, today, config).map((d) => d.event);

  // valid_until = 2027-08-31：窗口起點 2027-02-28（8/31 減 6 個月），期滿前 30 日 = 2027-08-01
  it.each([
    ['窗口前一天', '2027-02-27', []],
    ['進入窗口當日', '2027-02-28', ['renewal_reminder_window']],
    ['窗口內其他日', '2027-03-01', []],
    ['期滿前 31 日', '2027-07-31', []],
    ['期滿前 30 日當日', '2027-08-01', ['renewal_reminder_30d']],
    ['期滿前 29 日', '2027-08-02', []],
    ['期滿當日', '2027-08-31', []],
    ['期滿後', '2027-09-01', []],
  ] as const)('%s', (_name, today, expected) => {
    expect(events(cert('2027-08-31'), today)).toEqual(expected);
  });

  it('不是已驗證或沒有 valid_until 時不提醒', () => {
    expect(events(cert('2027-08-31', 'pending'), '2027-08-01')).toEqual([]);
    expect(events(cert('2027-08-31', 'lapsed'), '2027-08-01')).toEqual([]);
    expect(events(cert(null), '2027-08-01')).toEqual([]);
  });

  it('收件者是執業人員與執業主體，各有自己的冪等鍵', () => {
    const [d] = decideRenewalReminders(cert('2027-08-31'), '2027-08-01');
    expect(d).toEqual({
      event: 'renewal_reminder_30d',
      subjectType: 'certificate',
      subjectId: 'prac-1',
      action: 'notify',
      date: '2027-08-01',
      idempotencyKey: 'prac-1:renewal_reminder_30d:2027-08-01',
      notifications: [
        { recipient: 'practitioner', idempotencyKey: 'prac-1:renewal_reminder_30d:2027-08-01:practitioner' },
        { recipient: 'practice_entity', idempotencyKey: 'prac-1:renewal_reminder_30d:2027-08-01:practice_entity' },
      ],
    });
  });

  it('30 日與窗口長度是設定值', () => {
    const config: TimerConfig = { ...DEFAULT_TIMER_CONFIG, renewalWindowMonths: 3, renewalReminderDays: 14 };
    expect(events(cert('2027-08-31'), '2027-05-31', config)).toEqual(['renewal_reminder_window']);
    expect(events(cert('2027-08-31'), '2027-08-17', config)).toEqual(['renewal_reminder_30d']);
    expect(events(cert('2027-08-31'), '2027-08-01', config)).toEqual([]);
  });

  it('窗口起點與提醒日同一天時，兩條各自產生', () => {
    const config: TimerConfig = { ...DEFAULT_TIMER_CONFIG, renewalWindowMonths: 1, renewalReminderDays: 31 };
    expect(events(cert('2027-08-31'), '2027-07-31', config)).toEqual([
      'renewal_reminder_window',
      'renewal_reminder_30d',
    ]);
  });
});

describe('證書期滿 decideCertificateExpiry', () => {
  const cert = (validUntil: string | null, state: 'verified' | 'pending' | 'lapsed' = 'verified') => ({
    practitionerId: 'prac-1',
    state,
    validUntil,
  });

  it.each([
    ['查詢日晚於 valid_until', cert('2026-11-07'), '2026-11-08', true],
    ['valid_until 當天仍有效', cert('2026-11-08'), '2026-11-08', false],
    ['未到期', cert('2027-01-01'), '2026-11-08', false],
    ['沒有 valid_until', cert(null), '2026-11-08', false],
    ['待驗證不轉', cert('2026-11-07', 'pending'), '2026-11-08', false],
    ['已失效不再轉', cert('2026-11-07', 'lapsed'), '2026-11-08', false],
  ])('%s', (_name, c, today, due) => {
    expect(decideCertificateExpiry(c, today) !== null).toBe(due);
  });

  it('轉 lapsed，通知執業人員與執業主體各 1 次', () => {
    expect(decideCertificateExpiry(cert('2026-11-07'), '2026-11-20')).toEqual({
      event: 'cert_expired',
      subjectType: 'certificate',
      subjectId: 'prac-1',
      action: 'lapse_certificate',
      date: '2026-11-08',
      idempotencyKey: 'prac-1:cert_expired:2026-11-08',
      transition: { from: 'verified', to: 'lapsed', event: 'expired' },
      notifications: [
        { recipient: 'practitioner', idempotencyKey: 'prac-1:cert_expired:2026-11-08:practitioner' },
        { recipient: 'practice_entity', idempotencyKey: 'prac-1:cert_expired:2026-11-08:practice_entity' },
      ],
    });
  });
});

describe('任職重驗 decideEmploymentRecheck', () => {
  const emp = (lastCheckedOn: string, state: 'verified' | 'pending' | 'lapsed' = 'verified') => ({
    employmentId: 'emp-1',
    state,
    lastCheckedOn,
  });

  it.each([
    ['滿 6 個月前一天', '2026-05-08', '2026-11-07', false],
    ['滿 6 個月當日', '2026-05-08', '2026-11-08', true],
    ['超過 6 個月（補跑）', '2026-05-08', '2026-12-01', true],
    ['月底：8/31 核對，隔年 2/28 滿 6 個月', '2026-08-31', '2027-02-28', true],
    ['月底：8/31 核對，2/27 未滿', '2026-08-31', '2027-02-27', false],
  ])('%s', (_name, lastCheckedOn, today, due) => {
    expect(decideEmploymentRecheck(emp(lastCheckedOn), today) !== null).toBe(due);
  });

  it('只處理已驗證的任職', () => {
    expect(decideEmploymentRecheck(emp('2026-01-01', 'pending'), '2026-11-08')).toBeNull();
    expect(decideEmploymentRecheck(emp('2026-01-01', 'lapsed'), '2026-11-08')).toBeNull();
  });

  it('只產生審核台項目，不通知，不改狀態；冪等鍵的日期是到期日', () => {
    const a = decideEmploymentRecheck(emp('2026-05-08'), '2026-11-08');
    const b = decideEmploymentRecheck(emp('2026-05-08'), '2026-11-20');
    expect(a).toEqual({
      event: 'employment_recheck',
      subjectType: 'employment',
      subjectId: 'emp-1',
      action: 'enqueue_review',
      date: '2026-11-08',
      idempotencyKey: 'emp-1:employment_recheck:2026-11-08',
      notifications: [],
    });
    expect(b?.idempotencyKey).toBe(a?.idempotencyKey);
  });

  it('重驗月數是設定值；重新核對後換新的鍵', () => {
    const config: TimerConfig = { ...DEFAULT_TIMER_CONFIG, employmentRecheckMonths: 3 };
    expect(decideEmploymentRecheck(emp('2026-08-08'), '2026-11-08', config)).not.toBeNull();
    const before = decideEmploymentRecheck(emp('2026-05-08'), '2026-11-08');
    const after = decideEmploymentRecheck(emp('2026-11-08'), '2027-05-08');
    expect(after?.idempotencyKey).not.toBe(before?.idempotencyKey);
  });
});

describe('執業主體每月重查 decideEntityRecheck', () => {
  const entity = (hasVerifiedLicense: boolean) => ({ entityId: 'entity-1', hasVerifiedLicense });

  it('有已驗證業別的執業主體每月產生一個審核台項目，鍵的日期是年月', () => {
    expect(decideEntityRecheck(entity(true), '2026-11-08')).toEqual({
      event: 'entity_recheck',
      subjectType: 'practice_entity',
      subjectId: 'entity-1',
      action: 'enqueue_review',
      date: '2026-11',
      idempotencyKey: 'entity-1:entity_recheck:2026-11',
      notifications: [],
    });
  });

  it('同月任何一天的鍵相同，下個月換鍵', () => {
    const first = decideEntityRecheck(entity(true), '2026-11-01');
    const later = decideEntityRecheck(entity(true), '2026-11-30');
    const next = decideEntityRecheck(entity(true), '2026-12-01');
    expect(later?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(next?.idempotencyKey).toBe('entity-1:entity_recheck:2026-12');
  });

  it('沒有已驗證業別時不重查', () => {
    expect(decideEntityRecheck(entity(false), '2026-11-08')).toBeNull();
  });
});

describe('證據檔刪除 decideEvidencePurge', () => {
  const copy = (latestCheck: { result: 'match' | 'mismatch' | 'not_found' | 'revoked'; checkedOn: string } | null) => ({
    evidenceId: 'ev-1',
    kind: 'credential_copy' as const,
    latestCheck,
  });
  const consent = (endedOn: string | null) => ({ evidenceId: 'ev-2', kind: 'consent_letter' as const, endedOn });

  it.each([
    ['不符後第 29 天', copy({ result: 'mismatch', checkedOn: '2026-10-10' }), '2026-11-08', false],
    ['不符後第 30 天', copy({ result: 'mismatch', checkedOn: '2026-10-09' }), '2026-11-08', true],
    ['查無資料後超過 30 天', copy({ result: 'not_found', checkedOn: '2026-09-01' }), '2026-11-08', true],
    ['廢止後超過 30 天', copy({ result: 'revoked', checkedOn: '2026-09-01' }), '2026-11-08', true],
    ['補件相符後由核對流程刪除，計時器不處理', copy({ result: 'match', checkedOn: '2026-09-01' }), '2026-11-08', false],
    ['還沒有核對紀錄', copy(null), '2026-11-08', false],
    ['同意書，任職仍有效', consent(null), '2026-11-08', false],
    ['同意書，失效後第 29 天', consent('2026-10-10'), '2026-11-08', false],
    ['同意書，失效後第 30 天', consent('2026-10-09'), '2026-11-08', true],
  ])('%s', (_name, evidence, today, due) => {
    expect(decideEvidencePurge(evidence, today) !== null).toBe(due);
  });

  it('刪除要寫稽核事件，冪等鍵的日期是刪除到期日', () => {
    const a = decideEvidencePurge(copy({ result: 'mismatch', checkedOn: '2026-10-09' }), '2026-11-08');
    const b = decideEvidencePurge(copy({ result: 'mismatch', checkedOn: '2026-10-09' }), '2026-11-20');
    expect(a).toEqual({
      event: 'evidence_purge',
      subjectType: 'evidence',
      subjectId: 'ev-1',
      action: 'purge_evidence',
      date: '2026-11-08',
      idempotencyKey: 'ev-1:evidence_purge:2026-11-08',
      notifications: [],
    });
    expect(b?.idempotencyKey).toBe(a?.idempotencyKey);
  });

  it('保留天數是設定值', () => {
    const config: TimerConfig = { ...DEFAULT_TIMER_CONFIG, evidencePurgeDays: 7 };
    expect(decideEvidencePurge(consent('2026-11-01'), '2026-11-08', config)).not.toBeNull();
    expect(decideEvidencePurge(consent('2026-11-02'), '2026-11-08', config)).toBeNull();
  });
});

describe('scanTimers', () => {
  const facts = {
    mandates: [{ caseId: 'mcase-1', state: 'active' as const, validUntil: '2026-11-07' }],
    certificates: [
      { practitionerId: 'prac-1', state: 'verified' as const, validUntil: '2026-11-07' }, // 期滿
      { practitionerId: 'prac-2', state: 'verified' as const, validUntil: '2026-12-08' }, // 期滿前 30 日
    ],
    employments: [{ employmentId: 'emp-1', state: 'verified' as const, lastCheckedOn: '2026-05-08' }],
    entities: [{ entityId: 'entity-1', hasVerifiedLicense: true }],
    evidences: [{ evidenceId: 'ev-2', kind: 'consent_letter' as const, endedOn: '2026-10-01' }],
  };

  it('一次掃完 6 條計時器，依計時器順序輸出', () => {
    const keys = scanTimers(facts, '2026-11-08').map((d) => d.idempotencyKey);
    expect(keys).toEqual([
      'mcase-1:mandate_expired:2026-11-08',
      'prac-2:renewal_reminder_30d:2026-11-08',
      'prac-1:cert_expired:2026-11-08',
      'emp-1:employment_recheck:2026-11-08',
      'entity-1:entity_recheck:2026-11',
      'ev-2:evidence_purge:2026-10-31',
    ]);
  });

  it('重跑同一天的結果完全相同', () => {
    expect(scanTimers(facts, '2026-11-08')).toEqual(scanTimers(facts, '2026-11-08'));
  });

  it('隔天重跑，狀態驅動的鍵不變，只有當日觸發的提醒消失', () => {
    const day1 = new Set(scanTimers(facts, '2026-11-08').map((d) => d.idempotencyKey));
    const day2 = scanTimers(facts, '2026-11-09').map((d) => d.idempotencyKey);
    expect(day2).toEqual([
      'mcase-1:mandate_expired:2026-11-08',
      'prac-1:cert_expired:2026-11-08',
      'emp-1:employment_recheck:2026-11-08',
      'entity-1:entity_recheck:2026-11',
      'ev-2:evidence_purge:2026-10-31',
    ]);
    for (const key of day2) expect(day1.has(key)).toBe(true);
  });

  it('沒有事實時回傳空陣列', () => {
    expect(scanTimers({ mandates: [], certificates: [], employments: [], entities: [], evidences: [] }, '2026-11-08')).toEqual([]);
  });
});
