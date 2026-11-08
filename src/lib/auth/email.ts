// email 的正規化。系統內 email 一律存小寫、去前後空白（control.parties 的 CHECK 同一條規則）。

const EMAIL_PATTERN = /^[^@\s,;]+@[^@\s,;]+$/;
const MAX_LENGTH = 254;

/** 不合格回傳 null。只做格式檢查，不驗證網域是否存在。 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_LENGTH) return null;
  return EMAIL_PATTERN.test(email) ? email : null;
}

/** 帳號第一次建立時的顯示名稱，之後由使用者自己改。 */
export function displayNameFromEmail(email: string): string {
  return email.slice(0, email.indexOf('@'));
}
