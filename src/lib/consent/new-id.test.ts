import { describe, expect, it } from 'vitest';
import { isUlid } from '../pg/ulid';
import { newUlid } from './new-id';

describe('newUlid', () => {
  it('產生合法的 ULID，且不重複', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newUlid()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(isUlid(id)).toBe(true);
  });

  it('時間部分照毫秒遞增排序（已知向量：0 與 1 毫秒）', () => {
    expect(newUlid(0).slice(0, 10)).toBe('0000000000');
    expect(newUlid(1).slice(0, 10)).toBe('0000000001');
    expect(newUlid(32).slice(0, 10)).toBe('0000000010');
    expect(newUlid(1000).slice(0, 10) < newUlid(2000).slice(0, 10)).toBe(true);
  });

  it('拒絕超出範圍的時間', () => {
    expect(() => newUlid(-1)).toThrow();
    expect(() => newUlid(2 ** 48)).toThrow();
  });
});
