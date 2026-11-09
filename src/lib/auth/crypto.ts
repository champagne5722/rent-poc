import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { AUTH_SECRET_ENV } from './config';

// 驗證碼與 session token 的產生與雜湊。

/** 產生 length 碼數字，前導 0 保留。random 供測試注入，預設用密碼學亂數。 */
export function generateOtpCode(length: number, random: (maxExclusive: number) => number = (n) => randomInt(n)): string {
  let code = '';
  for (let i = 0; i < length; i += 1) code += String(random(10));
  return code;
}

/**
 * 驗證碼只有 100 萬種，單純的 SHA-256 在資料庫外洩後可以暴力還原，所以用 HMAC 加伺服器金鑰，
 * 並綁定驗證碼 id，讓同一組數字在不同次寄送有不同的雜湊。
 */
export function hashOtp(secret: string, otpId: string, code: string): string {
  return createHmac('sha256', secret).update(`${otpId}:${code}`).digest('hex');
}

export function otpMatches(expectedHash: string, secret: string, otpId: string, code: string): boolean {
  const actual = Buffer.from(hashOtp(secret, otpId, code), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 256 位元亂度的 session token，放在 cookie。 */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 資料庫只存 token 的 SHA-256。token 本身有足夠亂度，不需要加鹽。 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// 開發與測試環境的預設金鑰。正式環境不得使用，resolveAuthSecret 會拒絕。
const DEV_SECRET = 'rent-poc-dev-only-auth-secret';

/** 正式環境（NODE_ENV=production）沒設定 AUTH_SECRET 就拒絕，不退回預設值。 */
export function resolveAuthSecret(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const secret = env[AUTH_SECRET_ENV]?.trim();
  if (secret) return secret;
  if (env.NODE_ENV === 'production') throw new Error(`正式環境必須設定 ${AUTH_SECRET_ENV}，登入功能已停用`);
  return DEV_SECRET;
}
