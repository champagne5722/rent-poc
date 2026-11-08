// ULID（ADR-0012 決議 9）：Crockford base32，26 碼，前 10 碼是毫秒時間戳，後 16 碼是隨機。
// 格式檢查與 db/migrations/0002_control_orgs.sql 的 CHECK 同一條規則。
// 這個檔案不依賴 node 內建模組，前端也能 import（顯示末 6 碼）。

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

/** 畫面上顯示的短編碼：ULID 末 6 碼。只供辨識，不保證唯一，系統內一律用完整 ULID。 */
export function shortUlid(value: unknown): string {
  return isUlid(value) ? value.slice(-6) : '';
}

export interface UlidFactoryOptions {
  /** 毫秒時間，測試用。 */
  now?: () => number;
  /** 回傳 0 到 31 的整數，測試用。 */
  random?: () => number;
}

function defaultRandom(): number {
  const bytes = new Uint8Array(1);
  // 32 剛好整除 256，取低 5 位元沒有偏差
  globalThis.crypto.getRandomValues(bytes);
  return bytes[0] & 31;
}

function encodeTime(ms: number): string {
  let rest = ms;
  let out = '';
  for (let i = 0; i < TIME_LENGTH; i++) {
    out = ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/**
 * 單調遞增的 ULID 產生器。同一個產生器產出的 ID，字典序一定遞增：
 * 同一毫秒內把隨機部分加 1，隨機部分溢位時時間戳進位，時鐘倒退時沿用上一個時間戳。
 * 設備詞彙庫靠這一點保證「平台預設在前、依原順序」（ORDER BY id）。
 */
export function createUlidFactory(options: UlidFactoryOptions = {}): () => string {
  const now = options.now ?? Date.now;
  const random = options.random ?? defaultRandom;
  let lastTime = -1;
  let lastRandom: number[] = [];

  return () => {
    let time = now();
    if (time <= lastTime) {
      time = lastTime;
      // 隨機部分加 1，從最後一位進位
      const next = [...lastRandom];
      let i = RANDOM_LENGTH - 1;
      while (i >= 0 && next[i] === 31) {
        next[i] = 0;
        i--;
      }
      if (i < 0) {
        // 整個隨機部分溢位：時間戳進位，隨機部分歸零
        time = lastTime + 1;
      } else {
        next[i] += 1;
      }
      lastRandom = i < 0 ? new Array<number>(RANDOM_LENGTH).fill(0) : next;
    } else {
      lastRandom = Array.from({ length: RANDOM_LENGTH }, random);
    }
    lastTime = time;
    return encodeTime(time) + lastRandom.map((n) => ALPHABET[n]).join('');
  };
}

const next = createUlidFactory();

/** 產生一個新的 ULID。同一程序內單調遞增。 */
export function newUlid(): string {
  return next();
}
