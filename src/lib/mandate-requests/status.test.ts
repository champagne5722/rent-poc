import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_VALID_DAYS,
  LINK_VALID_DAYS,
  STORED_STATUSES,
  SUBMITTED_VALID_DAYS,
  TRANSITIONS,
  TRANSITION_EVENTS,
  applyTransition,
  deadlineOf,
  effectiveStatus,
  linkExpiryFrom,
  occupiesUnits,
  type MandateRequestStatus,
  type RequestFacts,
  type StoredStatus,
} from './status';

// 純函式：時間由參數傳入。每個狀態在期限前、期限當下、期限後各測一次。

const T0 = new Date('2026-11-10T02:00:00Z');
const day = (n: number, from: Date = T0) => new Date(from.getTime() + n * 24 * 60 * 60 * 1000);
const msBefore = (d: Date) => new Date(d.getTime() - 1);

function facts(status: StoredStatus, patch: Partial<RequestFacts> = {}): RequestFacts {
  return {
    status,
    linkExpiresAt: linkExpiryFrom(T0),
    submittedAt: null,
    acceptedAt: null,
    contractSentAt: null,
    ...patch,
  };
}

describe('期限常數', () => {
  it('連結 7 天、送出後 7 天、接受後 30 天', () => {
    expect([LINK_VALID_DAYS, SUBMITTED_VALID_DAYS, ACCEPTED_VALID_DAYS]).toEqual([7, 7, 30]);
  });
});

describe('effectiveStatus：每個狀態在期限前、當下、後', () => {
  const submitted = day(1);
  const accepted = day(2);
  const cases: Array<{ name: string; facts: RequestFacts; deadline: Date | null }> = [
    { name: '待屋主確認', facts: facts('pending_owner'), deadline: day(7) },
    { name: '待業者接受', facts: facts('pending_practice', { submittedAt: submitted }), deadline: day(7, submitted) },
    { name: '已接受（還沒送合約）', facts: facts('accepted', { submittedAt: submitted, acceptedAt: accepted }), deadline: day(30, accepted) },
  ];

  it.each(cases)('$name：期限前有效，期限當下起失效', ({ facts: f, deadline }) => {
    expect(deadlineOf(f)).toEqual(deadline);
    expect(effectiveStatus(f, T0)).toBe(f.status);
    expect(effectiveStatus(f, msBefore(deadline!))).toBe(f.status);
    expect(effectiveStatus(f, deadline!)).toBe('expired');
    expect(effectiveStatus(f, day(365))).toBe('expired');
  });

  it('已接受而且業者已送出合約：30 天期限不再適用', () => {
    const f = facts('accepted', { submittedAt: day(1), acceptedAt: day(2), contractSentAt: day(3) });
    expect(deadlineOf(f)).toBeNull();
    expect(effectiveStatus(f, day(365))).toBe('accepted');
  });

  it.each(['declined', 'withdrawn', 'ended', 'completed'] as const)('%s 沒有期限，永遠是原狀態', (status) => {
    const f = facts(status, { submittedAt: day(1), acceptedAt: day(2) });
    expect(deadlineOf(f)).toBeNull();
    expect(effectiveStatus(f, day(365))).toBe(status);
  });

  it('待屋主確認的 7 天從連結建立起算，與有沒有代填資料無關（事實裡沒有代填欄位）', () => {
    expect(linkExpiryFrom(T0).getTime() - T0.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('資料不全時不判成失效（資料庫的約束不讓它發生）', () => {
    expect(deadlineOf(facts('pending_practice'))).toBeNull();
    expect(deadlineOf(facts('accepted'))).toBeNull();
  });
});

describe('occupiesUnits', () => {
  it('只有待業者接受與已接受佔用租賃單位，失效與其他狀態不佔用', () => {
    const all: MandateRequestStatus[] = [...STORED_STATUSES, 'expired'];
    expect(all.filter(occupiesUnits)).toEqual(['pending_practice', 'accepted']);
  });
});

describe('轉移表：每個事件 x 每個狀態', () => {
  const sample = (status: StoredStatus): RequestFacts =>
    facts(status, { submittedAt: day(1), acceptedAt: day(2) });
  const NOW = day(2.5, T0); // 三種期限都還沒到

  it('轉移表涵蓋六個事件，接線的票各自標明', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...TRANSITION_EVENTS].sort());
    expect(Object.fromEntries(TRANSITION_EVENTS.map((e) => [e, TRANSITIONS[e].wiredBy]))).toEqual({
      submit: 'MIL-206',
      withdraw: 'MIL-206',
      accept: 'MIL-210',
      decline: 'MIL-210',
      end: 'MIL-210',
      complete: 'MIL-211',
    });
  });

  it('誰能觸發：接受與未接受只有業者，結束兩方都能做，收回只有屋主', () => {
    expect(Object.fromEntries(TRANSITION_EVENTS.map((e) => [e, TRANSITIONS[e].by]))).toEqual({
      submit: ['owner'],
      withdraw: ['owner'],
      accept: ['practice'],
      decline: ['practice'],
      end: ['owner', 'practice'],
      complete: ['system'],
    });
  });

  for (const event of TRANSITION_EVENTS) {
    for (const status of STORED_STATUSES) {
      const rule = TRANSITIONS[event];
      const allowed = status === rule.from;
      it(`${event} 從 ${status}：${allowed ? `轉成 ${rule.to}` : '不允許'}`, () => {
        const result = applyTransition(sample(status), event, NOW);
        expect(result).toEqual(allowed ? { ok: true, next: rule.to } : { ok: false, reason: 'wrong_status' });
      });
    }
  }

  it('失效的申請不能再轉移，不論事件', () => {
    for (const event of TRANSITION_EVENTS) {
      expect(applyTransition(facts('pending_owner'), event, day(7))).toEqual({ ok: false, reason: 'expired' });
    }
    expect(applyTransition(facts('pending_practice', { submittedAt: day(1) }), 'withdraw', day(8))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('期限前一毫秒仍可送出，期限當下不行', () => {
    expect(applyTransition(facts('pending_owner'), 'submit', msBefore(day(7)))).toEqual({ ok: true, next: 'pending_practice' });
    expect(applyTransition(facts('pending_owner'), 'submit', day(7))).toEqual({ ok: false, reason: 'expired' });
  });

  it('終態沒有任何出口', () => {
    for (const status of ['declined', 'withdrawn', 'ended', 'completed'] as const) {
      for (const event of TRANSITION_EVENTS) {
        expect(applyTransition(sample(status), event, NOW).ok).toBe(false);
      }
    }
  });
});
