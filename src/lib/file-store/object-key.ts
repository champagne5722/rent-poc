// 物件 key 與用途（ADR-0012 的 FileStore，MIL-87）。
//
// key 的格式是 org/<org_id>/<area>/<part>/…。org_id 在最前面，兩個保證因此成立：
// - 不同組織的檔案不會撞名：前綴不同，後面怎麼取名都不會互相覆蓋。
// - 組織的檔案在 bucket 內集中在同一個前綴下，之後要依組織設保留期、匯出或清除都有明確的邊界。
//
// ObjectKey 是品牌型別，只能由 buildObjectKey 產生。FileStore 的 adapter 收到 key 時仍會再驗一次（parseObjectKey），
// 因為型別擋不住 `as` 強轉，而本機 adapter 會把 key 組成檔案路徑，路徑穿越要在這裡擋死。

/**
 * 檔案的用途。決定存進哪個 bucket（本機決定哪個子目錄）。
 * - signed-document：已簽 PDF 與 Audit Trail File。法律文件，bucket 之後可加保留期鎖。
 * - general：其他使用者上傳或系統產生的檔案，例如謄本上傳（B 線）、帳單匯入與對帳單（E 線）。
 */
export const FILE_PURPOSES = ['signed-document', 'general'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

declare const objectKeyBrand: unique symbol;
export type ObjectKey = string & { readonly [objectKeyBrand]: true };

// 每一段只允許英數、點、底線、連字號。ULID、組織 id、檔名都在這個範圍內
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_KEY_BYTES = 1024; // Cloud Storage 的物件名稱上限

export class InvalidObjectKey extends Error {
  constructor(reason: string) {
    super(`物件 key 不合法：${reason}`);
    this.name = 'InvalidObjectKey';
  }
}

function checkSegment(segment: string, what: string): void {
  if (!SEGMENT.test(segment) || segment === '.' || segment === '..') {
    throw new InvalidObjectKey(`${what}「${segment}」只能含英數、點、底線、連字號，且不得是 . 或 ..`);
  }
}

/**
 * 組出物件 key：org/<orgId>/<area>/<parts…>。
 * area 是這類檔案的名稱（例如 sign-tasks），parts 至少一段，最後一段是檔名。
 * 每一段只能是英數、點、底線、連字號，不能有斜線，所以呼叫端傳什麼都組不出別的組織的 key。
 */
export function buildObjectKey(orgId: string, area: string, ...parts: string[]): ObjectKey {
  if (parts.length === 0) throw new InvalidObjectKey('至少要有一段檔名');
  checkSegment(orgId, 'org_id');
  checkSegment(area, 'area');
  for (const part of parts) checkSegment(part, '路徑段');
  return parseObjectKey(['org', orgId, area, ...parts].join('/'));
}

/** adapter 收到 key 時的驗證。通過才回傳品牌型別。 */
export function parseObjectKey(key: string): ObjectKey {
  if (Buffer.byteLength(key) > MAX_KEY_BYTES) throw new InvalidObjectKey('超過 1024 位元組');
  const segments = key.split('/');
  // org / <orgId> / <area> / 至少一段檔名
  if (segments.length < 4 || segments[0] !== 'org') throw new InvalidObjectKey('必須是 org/<org_id>/<area>/<檔名>');
  for (const segment of segments) checkSegment(segment, '路徑段');
  return key as ObjectKey;
}

/** key 屬於哪個組織。資料庫的 CHECK 用同一個規則：key 必須以 org/<org_id>/ 開頭。 */
export function orgIdOfKey(key: ObjectKey): string {
  return key.split('/')[1];
}
