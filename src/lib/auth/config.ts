// 登入的設定值（ADR-0022 決議 1、2、8，MIL-103）。
// 數字都是「假設」，法務或使用者調整時只改這裡，規則函式與測試都從設定取值。

export interface AuthConfig {
  /** 假設：驗證碼 6 碼數字。 */
  otpLength: number;
  /** 假設：驗證碼 10 分鐘有效。 */
  otpTtlMs: number;
  /** 假設：同一組驗證碼錯 5 次作廢。 */
  otpMaxAttempts: number;
  /** 假設：同一 email 每分鐘最多寄 1 次。 */
  otpResendIntervalMs: number;
  /** 假設：session 7 天到期。ADR 沒有指定，登出與成員移除會提早刪除。 */
  sessionTtlMs: number;
  /** Phase 1 全部帳號都是等級 1，不做升級驗證（ADR-0022 決議 8）。 */
  identityLevel: 1;
}

export const AUTH_CONFIG: AuthConfig = {
  otpLength: 6,
  otpTtlMs: 10 * 60 * 1000,
  otpMaxAttempts: 5,
  otpResendIntervalMs: 60 * 1000,
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  identityLevel: 1,
};

/** session cookie 的名稱。內容只有隨機 token。 */
export const SESSION_COOKIE = 'rp_session';

/** proxy 設在請求標頭上的目前路徑，根 layout 靠它判斷是否需要登入（server component 讀不到 pathname）。 */
export const PATH_HEADER = 'x-rp-path';

/** A 線種子（db/migrations/0002_control_orgs.sql）的固定組織 ID。 */
export const PLATFORM_ORG_ID = '00000000000000000000000001';
export const DEFAULT_OWNER_ORG_ID = '00000000000000000000000002';

/** 環境變數名稱。SEED_OWNER_EMAIL 與 PLATFORM_OPERATOR_EMAILS 是逗號分隔的 email 清單。 */
export const SEED_OWNER_EMAIL_ENV = 'SEED_OWNER_EMAIL';
export const PLATFORM_OPERATOR_EMAILS_ENV = 'PLATFORM_OPERATOR_EMAILS';
export const AUTH_SECRET_ENV = 'AUTH_SECRET';
