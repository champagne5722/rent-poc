import type { ControlTx } from '../pg/with-tx';
import { newUlid } from '../pg/ulid';
import { AUTH_CONFIG, type AuthConfig } from './config';
import { generateOtpCode, hashOtp, otpMatches } from './crypto';
import { decideOtpIssue, decideOtpVerification, type OtpRecord } from './otp-rules';

// 驗證碼的資料庫操作（control.login_otps）。規則在 otp-rules.ts，這裡只負責讀寫。
// 都在 control 脈絡的交易內呼叫。寄信是外部呼叫，不在這裡做（ADR-0012 決議 10）。

// 用過、作廢的列保留一天，供頻率判斷與事後追查，之後順手清除
const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

export type IssueOtpResult =
  | { status: 'rate_limited'; retryAfterSec: number }
  | { status: 'issued'; otpId: string; code: string };

/** 同一 email 每分鐘 1 次。新的一組寄出時，舊的一律作廢。 */
export async function issueOtp(
  tx: ControlTx,
  input: { email: string; now: Date; secret: string },
  config: AuthConfig = AUTH_CONFIG,
): Promise<IssueOtpResult> {
  const { email, now, secret } = input;
  // 同一 email 的並發請求排隊，頻率限制才不會被同時送出的兩個請求繞過
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`login_otp:${email}`]);

  const last = await tx.query<{ created_at: Date | string }>(
    'SELECT created_at FROM control.login_otps WHERE email = $1 ORDER BY created_at DESC LIMIT 1',
    [email],
  );
  const decision = decideOtpIssue(last.rows[0] ? new Date(last.rows[0].created_at) : null, now, config);
  if (!decision.allowed) return { status: 'rate_limited', retryAfterSec: decision.retryAfterSec };

  await tx.query('DELETE FROM control.login_otps WHERE created_at < $1', [
    new Date(now.getTime() - PURGE_AFTER_MS).toISOString(),
  ]);
  await tx.query('UPDATE control.login_otps SET consumed_at = $2 WHERE email = $1 AND consumed_at IS NULL', [
    email,
    now.toISOString(),
  ]);

  const otpId = newUlid();
  const code = generateOtpCode(config.otpLength);
  await tx.query(
    `INSERT INTO control.login_otps (id, email, code_hash, attempts, created_at, expires_at)
     VALUES ($1, $2, $3, 0, $4, $5)`,
    [
      otpId,
      email,
      hashOtp(secret, otpId, code),
      now.toISOString(),
      new Date(now.getTime() + config.otpTtlMs).toISOString(),
    ],
  );
  return { status: 'issued', otpId, code };
}

/** 寄信失敗時撤回剛產生的驗證碼，使用者不必白等一分鐘。 */
export async function discardOtp(tx: ControlTx, otpId: string): Promise<void> {
  await tx.query('DELETE FROM control.login_otps WHERE id = $1', [otpId]);
}

interface OtpRow {
  id: string;
  code_hash: string;
  attempts: number;
  created_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
}

export type CheckOtpResult = { ok: true } | { ok: false; reason: 'none' | 'used' | 'expired' | 'too_many_attempts' | 'mismatch' };

/**
 * 驗證一次輸入。只看這個 email 最新的一組。結果（錯誤次數、作廢、用過）都在這個交易內寫回，
 * 所以呼叫端即使回應失敗也必須提交交易，不得丟例外回滾。
 */
export async function checkOtp(
  tx: ControlTx,
  input: { email: string; code: string; now: Date; secret: string },
  config: AuthConfig = AUTH_CONFIG,
): Promise<CheckOtpResult> {
  const { email, code, now, secret } = input;
  const { rows } = await tx.query<OtpRow>(
    `SELECT id, code_hash, attempts, created_at, expires_at, consumed_at
       FROM control.login_otps WHERE email = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [email],
  );
  const row = rows[0];
  const record: OtpRecord | null = row
    ? {
        attempts: row.attempts,
        createdAt: new Date(row.created_at),
        expiresAt: new Date(row.expires_at),
        consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
      }
    : null;
  const matches = row ? otpMatches(row.code_hash, secret, row.id, code) : false;
  const decision = decideOtpVerification(record, matches, now, config);

  if (decision.outcome === 'accepted') {
    await tx.query('UPDATE control.login_otps SET consumed_at = $2 WHERE id = $1', [row!.id, now.toISOString()]);
    return { ok: true };
  }
  if (decision.reason === 'mismatch') {
    await tx.query(
      'UPDATE control.login_otps SET attempts = $2, consumed_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE consumed_at END WHERE id = $1',
      [row!.id, decision.attempts, decision.invalidate, now.toISOString()],
    );
  }
  return { ok: false, reason: decision.reason };
}
