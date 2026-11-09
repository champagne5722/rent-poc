import { AUTH_CONFIG, type AuthConfig } from './config';

// 驗證碼的規則（純函式，時間由參數傳入，ADR-0022 決議 1）。
// 不碰資料庫與雜湊：呼叫端先比對好雜湊，把「是否相符」交進來。

export interface OtpRecord {
  attempts: number;
  createdAt: Date;
  expiresAt: Date;
  /** 已使用或已作廢的時間，沒有則為 null。 */
  consumedAt: Date | null;
}

export type OtpIssueDecision = { allowed: true } | { allowed: false; retryAfterSec: number };

/** 同一 email 每分鐘 1 次：lastIssuedAt 是這個 email 最近一次寄出的時間。 */
export function decideOtpIssue(lastIssuedAt: Date | null, now: Date, config: AuthConfig = AUTH_CONFIG): OtpIssueDecision {
  if (!lastIssuedAt) return { allowed: true };
  const elapsed = now.getTime() - lastIssuedAt.getTime();
  if (elapsed >= config.otpResendIntervalMs) return { allowed: true };
  return { allowed: false, retryAfterSec: Math.ceil((config.otpResendIntervalMs - elapsed) / 1000) };
}

export type OtpVerification =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; reason: 'none' | 'used' | 'expired' | 'too_many_attempts' }
  | { outcome: 'rejected'; reason: 'mismatch'; attempts: number; invalidate: boolean };

/**
 * 驗證一次輸入。record 是這個 email 最新的一組驗證碼，沒有則為 null。
 * matches 是呼叫端比對雜湊的結果。回傳 mismatch 時，呼叫端要把 attempts 存回去，invalidate 為真時一併作廢。
 */
export function decideOtpVerification(
  record: OtpRecord | null,
  matches: boolean,
  now: Date,
  config: AuthConfig = AUTH_CONFIG,
): OtpVerification {
  if (!record) return { outcome: 'rejected', reason: 'none' };
  if (record.consumedAt) return { outcome: 'rejected', reason: 'used' };
  if (now.getTime() >= record.expiresAt.getTime()) return { outcome: 'rejected', reason: 'expired' };
  if (record.attempts >= config.otpMaxAttempts) return { outcome: 'rejected', reason: 'too_many_attempts' };
  if (matches) return { outcome: 'accepted' };
  const attempts = record.attempts + 1;
  return { outcome: 'rejected', reason: 'mismatch', attempts, invalidate: attempts >= config.otpMaxAttempts };
}
