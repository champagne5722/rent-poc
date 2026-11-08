import { describe, expect, it } from 'vitest';
import { createUlidFactory, isUlid, newUlid, shortUlid } from './ulid';

describe('newUlid', () => {
  it('產生 26 碼 Crockford base32，通過 isUlid', () => {
    expect(isUlid(newUlid())).toBe(true);
  });

  it('前 10 碼是毫秒時間戳，可以還原成產生時間', () => {
    const next = createUlidFactory({ now: () => 1_700_000_000_000, random: () => 0 });
    // 1_700_000_000_000 的 base32 編碼，獨立算出：01HF7YAT00
    expect(next().slice(0, 10)).toBe('01HF7YAT00');
  });

  it('時間越晚字典序越大', () => {
    let t = 1_700_000_000_000;
    const next = createUlidFactory({ now: () => t });
    const early = next();
    t += 1;
    const late = next();
    expect(late > early).toBe(true);
  });

  it('同一毫秒內連續產生，字典序嚴格遞增', () => {
    const next = createUlidFactory({ now: () => 1_700_000_000_000 });
    const ids = Array.from({ length: 200 }, () => next());
    expect(new Set(ids).size).toBe(200);
    expect([...ids].sort()).toEqual(ids);
  });

  it('同一毫秒內隨機部分溢位時，時間戳進位，仍然遞增', () => {
    const next = createUlidFactory({ now: () => 1_700_000_000_000, random: () => 31 });
    const a = next(); // 隨機部分全 Z
    const b = next();
    expect(b > a).toBe(true);
    expect(isUlid(b)).toBe(true);
  });

  it('時鐘倒退時仍然遞增', () => {
    let t = 1_700_000_000_000;
    const next = createUlidFactory({ now: () => t });
    const a = next();
    t -= 5;
    expect(next() > a).toBe(true);
  });
});

describe('shortUlid', () => {
  it('取末 6 碼', () => {
    expect(shortUlid('01HF7YAT00ABCDEFGHJKMNPQRS')).toBe('MNPQRS');
  });
  it('不是 ULID 時回傳空字串，不丟錯', () => {
    expect(shortUlid('12')).toBe('');
    expect(shortUlid(undefined)).toBe('');
  });
});
