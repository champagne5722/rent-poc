import { describe, expect, it } from 'vitest';
import type { SignatureField } from './types';
import { toDsCoord } from './dottedsign';

// 期望值以 A4（595.28 × 841.89 points）手算：
// 相對比例（原點左上、y 向下）→ 點點簽 [left-x, bottom-y, right-x, top-y]（原點左下）
describe('toDsCoord（簽署區域座標轉換）', () => {
  const field = (f: Partial<SignatureField>): SignatureField => ({
    id: 'f1',
    signer: 'tenant',
    page: 0,
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    ...f,
  });

  it('整頁區域對應整頁 points', () => {
    expect(toDsCoord(field({}))).toEqual([0, 0, 595.28, 841.89]);
  });

  it('左上四分之一頁：y 軸翻轉為左下原點', () => {
    // left = 0.25×595.28 = 148.82, right = 0.75×595.28 = 446.46
    // top = (1−0.25)×841.89 = 631.42, bottom = (1−0.75)×841.89 = 210.47（四捨五入到小數 2 位）
    expect(toDsCoord(field({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }))).toEqual([148.82, 210.47, 446.46, 631.42]);
  });
});
