import { describe, expect, it } from 'vitest';
import { bootstrapGrants } from './bootstrap';
import { DEFAULT_OWNER_ORG_ID, PLATFORM_ORG_ID } from './config';
import { generateOtpCode, hashOtp, hashSessionToken, newSessionToken, otpMatches, resolveAuthSecret } from './crypto';
import { displayNameFromEmail, normalizeEmail } from './email';

describe('normalizeEmail', () => {
  it('去掉前後空白並轉小寫', () => {
    expect(normalizeEmail('  Owner@Example.COM ')).toBe('owner@example.com');
  });
  it.each(['', 'abc', 'a@', '@b.com', 'a b@c.com', 'a@b@c.com', 'a@b.com,c@d.com', `${'x'.repeat(250)}@b.com`])(
    '拒絕不合格的 email：%s',
    (raw) => {
      expect(normalizeEmail(raw)).toBeNull();
    },
  );
  it('不是字串時回傳 null', () => {
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(123)).toBeNull();
  });
  it('顯示名稱預設取 @ 前面的部分', () => {
    expect(displayNameFromEmail('wang.mei@example.com')).toBe('wang.mei');
  });
});

describe('驗證碼與 token', () => {
  it('驗證碼是指定長度的數字，前導 0 保留', () => {
    const seq = [0, 0, 0, 0, 4, 2];
    expect(generateOtpCode(6, () => seq.shift() ?? 0)).toBe('000042');
    expect(generateOtpCode(6)).toMatch(/^\d{6}$/);
  });
  it('雜湊綁定驗證碼 id 與金鑰：換任何一個都對不上', () => {
    const hash = hashOtp('secret', 'otp-1', '123456');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(otpMatches(hash, 'secret', 'otp-1', '123456')).toBe(true);
    expect(otpMatches(hash, 'secret', 'otp-1', '123457')).toBe(false);
    expect(otpMatches(hash, 'secret', 'otp-2', '123456')).toBe(false);
    expect(otpMatches(hash, 'other', 'otp-1', '123456')).toBe(false);
  });
  it('session token 夠長、每次不同，資料庫只存它的雜湊', () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hashSessionToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(a)).not.toContain(a);
  });
});

describe('resolveAuthSecret', () => {
  it('有設定就用設定', () => {
    expect(resolveAuthSecret({ AUTH_SECRET: 'abc', NODE_ENV: 'production' })).toBe('abc');
  });
  it('正式環境沒設定就拒絕', () => {
    expect(() => resolveAuthSecret({ NODE_ENV: 'production' })).toThrow(/AUTH_SECRET/);
    expect(() => resolveAuthSecret({ NODE_ENV: 'production', AUTH_SECRET: '  ' })).toThrow(/AUTH_SECRET/);
  });
  it('開發與測試環境用固定的預設值', () => {
    expect(resolveAuthSecret({ NODE_ENV: 'development' })).toBeTruthy();
    expect(resolveAuthSecret({})).toBeTruthy();
  });
});

describe('bootstrapGrants（環境變數指定的第一批帳號）', () => {
  it('SEED_OWNER_EMAIL 的帳號是預設組織的 admin', () => {
    expect(bootstrapGrants('owner@example.com', { SEED_OWNER_EMAIL: 'Owner@Example.com' })).toEqual([
      { orgId: DEFAULT_OWNER_ORG_ID, role: 'admin' },
    ]);
  });
  it('PLATFORM_OPERATOR_EMAILS 是逗號分隔清單，成員加入平台組織', () => {
    const env = { PLATFORM_OPERATOR_EMAILS: ' ops@example.com, ops2@example.com ' };
    expect(bootstrapGrants('ops2@example.com', env)).toEqual([{ orgId: PLATFORM_ORG_ID, role: 'admin' }]);
    expect(bootstrapGrants('someone@example.com', env)).toEqual([]);
  });
  it('兩者都符合時兩個都給', () => {
    const env = { SEED_OWNER_EMAIL: 'a@example.com', PLATFORM_OPERATOR_EMAILS: 'a@example.com' };
    expect(bootstrapGrants('a@example.com', env)).toHaveLength(2);
  });
  it('沒有設定時不給任何成員資格', () => {
    expect(bootstrapGrants('a@example.com', {})).toEqual([]);
  });
});
