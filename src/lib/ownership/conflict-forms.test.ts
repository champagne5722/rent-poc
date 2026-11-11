import { describe, expect, it } from 'vitest';
import { matchesOfBasis, validateConflictDecisionForm, validateContactForm } from './conflict-forms';
import { noticesFor } from './conflict';
import { FAILED_NOTIFICATION_KIND, LAPSED_NOTIFICATION, VERIFIED_NOTIFICATION, failedNotificationBody } from './messages';

const NOW = new Date('2026-11-11T10:00:00Z');

describe('validateContactForm', () => {
  const ok = { target: 'later', channel: 'phone', outcome: '已通話' };

  it('收下合格的輸入，空白時間視為沒填', () => {
    expect(validateContactForm(ok, NOW)).toEqual({ ok: true, value: { target: 'later', channel: 'phone', outcome: '已通話', contactedAt: null } });
    expect(validateContactForm({ ...ok, contactedAt: '' }, NOW)).toMatchObject({ ok: true });
    const r = validateContactForm({ ...ok, contactedAt: '2026-11-11T09:00:00Z' }, NOW);
    expect(r).toMatchObject({ ok: true, value: { contactedAt: new Date('2026-11-11T09:00:00Z') } });
  });

  it.each([
    [{ ...ok, target: 'both' }, 'target'],
    [{ ...ok, channel: 'sms' }, 'channel'],
    [{ ...ok, outcome: '  ' }, 'outcome'],
    [{ ...ok, outcome: 'x'.repeat(501) }, 'outcome'],
    [{ ...ok, outcome: '含控制字元\u0007' }, 'outcome'],
    [{ ...ok, contactedAt: 'yesterday' }, 'contactedAt'],
    [{ ...ok, contactedAt: 12345 }, 'contactedAt'],
    [{ ...ok, contactedAt: '2026-11-12T00:00:00Z' }, 'contactedAt'],
  ])('拒絕 %j', (input, field) => {
    expect(validateContactForm(input, NOW)).toMatchObject({ ok: false, field });
  });
});

describe('validateConflictDecisionForm', () => {
  it('三種決定；後來的不成立必須填不符的項目，其他決定不得填', () => {
    expect(validateConflictDecisionForm({ decision: 'coexist', reason: '共有' })).toEqual({ ok: true, value: { decision: 'coexist', reason: '共有', basis: null } });
    expect(validateConflictDecisionForm({ decision: 'later_prevails', reason: 'x', basis: '' })).toMatchObject({ ok: true });
    expect(validateConflictDecisionForm({ decision: 'later_rejected', reason: 'x', basis: 'key_mismatch' })).toMatchObject({ ok: true, value: { basis: 'key_mismatch' } });
    expect(validateConflictDecisionForm({ decision: 'later_rejected', reason: 'x' })).toMatchObject({ ok: false, field: 'basis' });
    expect(validateConflictDecisionForm({ decision: 'coexist', reason: 'x', basis: 'key_mismatch' })).toMatchObject({ ok: false, field: 'basis' });
    expect(validateConflictDecisionForm({ decision: 'merge', reason: 'x' })).toMatchObject({ ok: false, field: 'decision' });
    expect(validateConflictDecisionForm({ decision: 'coexist', reason: ' ' })).toMatchObject({ ok: false, field: 'reason' });
  });

  it('不符的項目對應兩項比對', () => {
    expect(matchesOfBasis('key_mismatch')).toEqual({ keyMatch: false, holderMatch: true });
    expect(matchesOfBasis('holder_mismatch')).toEqual({ keyMatch: true, holderMatch: false });
    expect(matchesOfBasis('both_mismatch')).toEqual({ keyMatch: false, holderMatch: false });
  });
});

describe('noticesFor：通知的內容', () => {
  it('後來的一方的通知與一般判定相同；只有後來的成立才通知先前的一方', () => {
    const prevails = noticesFor('later_prevails', null);
    expect(prevails.later).toMatchObject({ kind: VERIFIED_NOTIFICATION.kind, title: VERIFIED_NOTIFICATION.title, body: VERIFIED_NOTIFICATION.body });
    expect(prevails.earlier).toMatchObject({ kind: LAPSED_NOTIFICATION.kind, title: LAPSED_NOTIFICATION.title, body: LAPSED_NOTIFICATION.body });
    expect(noticesFor('coexist', null).earlier).toBeNull();
    const rejected = noticesFor('later_rejected', 'holder_mismatch');
    expect(rejected.earlier).toBeNull();
    expect(rejected.later).toMatchObject({ kind: FAILED_NOTIFICATION_KIND, body: failedNotificationBody({ keyMatch: true, holderMatch: false }) });
  });

  it('每則通知有不同的 ID', () => {
    const n = noticesFor('later_prevails', null);
    expect(n.later.id).not.toBe(n.earlier!.id);
  });
});
