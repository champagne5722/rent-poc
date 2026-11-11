import { createHash, randomBytes } from 'node:crypto';

// 申請連結的隨機碼（MIL-206）。32 位元組（256 位元）隨機，base64url 編碼成 43 個字元。
// 資料庫只存 SHA-256 的 16 進位字串，明碼只在產生連結的那次回應出現一次，之後沒有任何地方能還原。
// 連結的網址格式：/request/<碼>。

export const REQUEST_CODE_BYTES = 32;
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateRequestCode(): string {
  return randomBytes(REQUEST_CODE_BYTES).toString('base64url');
}

/** 格式不符的碼不用查資料庫。連結頁對格式錯誤與查無此碼回應相同。 */
export function isWellFormedRequestCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_PATTERN.test(value);
}

export function hashRequestCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** 連結的站內路徑。畫面用它組完整網址與 QR code。 */
export function requestLinkPath(code: string): string {
  return `/request/${code}`;
}
