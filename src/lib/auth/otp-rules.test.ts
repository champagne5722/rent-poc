import { describe, expect, it } from 'vitest';
import { AUTH_CONFIG } from './config';
import { decideOtpIssue, decideOtpVerification, type OtpRecord } from './otp-rules';

const NOW = new Date('2026-11-09T10:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = (ms: number) => new Date(NOW.getTime() + ms);

const fresh: OtpRecord = { attempts: 0, createdAt: ago(1000), expiresAt: later(599_000), consumedAt: null };

describe('decideOtpIssue（同一 email 每分鐘 1 次）', () => {
  it('沒有紀錄時允許', () => {
    expect(decideOtpIssue(null, NOW)).toEqual({ allowed: true });
  });
  it('59 秒前寄過就擋下，並回傳還要等幾秒', () => {
    expect(decideOtpIssue(ago(59_000), NOW)).toEqual({ allowed: false, retryAfterSec: 1 });
    expect(decideOtpIssue(ago(1_000), NOW)).toEqual({ allowed: false, retryAfterSec: 59 });
  });
  it('剛好 60 秒後允許', () => {
    expect(decideOtpIssue(ago(60_000), NOW)).toEqual({ allowed: true });
  });
  it('間隔取自設定值', () => {
    const cfg = { ...AUTH_CONFIG, otpResendIntervalMs: 5_000 };
    expect(decideOtpIssue(ago(4_000), NOW, cfg)).toEqual({ allowed: false, retryAfterSec: 1 });
    expect(decideOtpIssue(ago(5_000), NOW, cfg)).toEqual({ allowed: true });
  });
});

describe('decideOtpVerification', () => {
  it('沒有可用的驗證碼', () => {
    expect(decideOtpVerification(null, true, NOW)).toEqual({ outcome: 'rejected', reason: 'none' });
  });
  it('正確的驗證碼：接受', () => {
    expect(decideOtpVerification(fresh, true, NOW)).toEqual({ outcome: 'accepted' });
  });
  it('錯誤的驗證碼：次數加 1，還沒到上限不作廢', () => {
    expect(decideOtpVerification(fresh, false, NOW)).toEqual({
      outcome: 'rejected',
      reason: 'mismatch',
      attempts: 1,
      invalidate: false,
    });
  });
  it('第 5 次錯誤時作廢', () => {
    expect(decideOtpVerification({ ...fresh, attempts: 4 }, false, NOW)).toEqual({
      outcome: 'rejected',
      reason: 'mismatch',
      attempts: 5,
      invalidate: true,
    });
  });
  it('已錯滿 5 次時，即使輸入正確也拒絕', () => {
    expect(decideOtpVerification({ ...fresh, attempts: 5 }, true, NOW)).toEqual({
      outcome: 'rejected',
      reason: 'too_many_attempts',
    });
  });
  it('剛好到期的瞬間就失效；到期前一毫秒仍有效', () => {
    expect(decideOtpVerification({ ...fresh, expiresAt: NOW }, true, NOW)).toEqual({ outcome: 'rejected', reason: 'expired' });
    expect(decideOtpVerification({ ...fresh, expiresAt: later(1) }, true, NOW)).toEqual({ outcome: 'accepted' });
  });
  it('用過的驗證碼不能再用', () => {
    expect(decideOtpVerification({ ...fresh, consumedAt: ago(10) }, true, NOW)).toEqual({ outcome: 'rejected', reason: 'used' });
  });
  it('錯誤次數上限取自設定值', () => {
    const cfg = { ...AUTH_CONFIG, otpMaxAttempts: 2 };
    expect(decideOtpVerification({ ...fresh, attempts: 1 }, false, NOW, cfg)).toMatchObject({ attempts: 2, invalidate: true });
  });
});
