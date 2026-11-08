// ULID 的格式檢查（Crockford base32，26 碼，不含 I L O U）。
// 與 db/migrations/0002_control_orgs.sql 的 CHECK 同一條規則。
// 產生 ULID 的函式由 MIL-81 加在這個檔案。

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}
