import { randomBytes } from 'node:crypto';

// 同意紀錄的主鍵產生器（MIL-84）。
// 私有的小實作，只為避免與 MIL-81 在 src/lib/pg/ulid.ts 加的共用產生器衝突。
// MIL-81 併入後換成共用版，換完刪除這個檔案。

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32，不含 I L O U

/** 26 碼 ULID：10 碼毫秒時間（48 位元）加 16 碼隨機（80 位元）。 */
export function newUlid(now: number = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) throw new Error('ULID 的時間必須是 48 位元內的非負整數');
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(10);
  // 80 位元分成 16 組，每組 5 位元。buffer 最多累積 12 位元，不會超過安全整數
  let rand = '';
  let buffer = 0;
  let count = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    count += 8;
    while (count >= 5) {
      count -= 5;
      rand += ALPHABET[(buffer >> count) & 31];
    }
    buffer &= (1 << count) - 1;
  }
  return time + rand;
}
