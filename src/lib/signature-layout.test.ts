import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIELD_STACK_STEP,
  clampRect,
  crossSignerOverlaps,
  defaultFieldRect,
  overlapWarning,
  rectsOverlap,
  snapPosition,
  snapThresholdRatio,
} from './signature-layout';
import { MARGIN, PAGE_H, PAGE_W, SIGN_STAMP_BLANK, signatureStampBaselines } from './pdf-layout';
import type { SignatureField } from './types';

function field(over: Partial<SignatureField> & { id: string }): SignatureField {
  return { signer: 'landlord', page: 0, x: 0.2, y: 0.2, w: 0.3, h: 0.06, ...over };
}

describe('defaultFieldRect', () => {
  it('簽名頁的甲方框落在甲方「簽章：」右側同一水平帶', () => {
    const rect = defaultFieldRect({ signer: 'landlord', page: 1, signaturePage: 1, existing: [] });
    const baseline = signatureStampBaselines().landlord;
    // 換回 PDF 座標比對：框頂略高於 baseline，框底不低於 baseline 往下預留的空白
    const top = PAGE_H - rect.y * PAGE_H;
    const bottom = top - rect.h * PAGE_H;
    expect(top).toBeGreaterThan(baseline);
    expect(top - baseline).toBeLessThan(20);
    expect(bottom).toBeCloseTo(top - SIGN_STAMP_BLANK, 5);
    // 落在「簽章：」文字右側、且不超出右邊界
    expect(rect.x * PAGE_W).toBeGreaterThan(MARGIN);
    expect((rect.x + rect.w) * PAGE_W).toBeLessThanOrEqual(PAGE_W - MARGIN);
  });

  it('乙方框在甲方框下方，兩者不重疊', () => {
    const landlord = defaultFieldRect({ signer: 'landlord', page: 1, signaturePage: 1, existing: [] });
    const tenant = defaultFieldRect({ signer: 'tenant', page: 1, signaturePage: 1, existing: [] });
    expect(tenant.y).toBeGreaterThan(landlord.y);
    expect(rectsOverlap(landlord, tenant)).toBe(false);
  });

  it('非簽名頁用備援落點，一樣在頁面範圍內且甲上乙下', () => {
    const landlord = defaultFieldRect({ signer: 'landlord', page: 0, signaturePage: 2, existing: [] });
    const tenant = defaultFieldRect({ signer: 'tenant', page: 0, signaturePage: 2, existing: [] });
    for (const rect of [landlord, tenant]) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(1);
      expect(rect.y + rect.h).toBeLessThanOrEqual(1);
    }
    expect(tenant.y).toBeGreaterThan(landlord.y);
    expect(rectsOverlap(landlord, tenant)).toBe(false);
  });

  it('同一落點已有框時往右下錯開，不疊在原框上', () => {
    const first = defaultFieldRect({ signer: 'landlord', page: 1, signaturePage: 1, existing: [] });
    const existing = [field({ id: 'a', page: 1, ...first })];
    const second = defaultFieldRect({ signer: 'landlord', page: 1, signaturePage: 1, existing });
    expect(second.x).toBeCloseTo(first.x + DEFAULT_FIELD_STACK_STEP.x, 10);
    expect(second.y).toBeCloseTo(first.y + DEFAULT_FIELD_STACK_STEP.y, 10);
  });

  it('只避開同一頁的框，別頁的框不影響落點', () => {
    const first = defaultFieldRect({ signer: 'landlord', page: 1, signaturePage: 1, existing: [] });
    const existing = [field({ id: 'a', page: 0, ...first })];
    const again = defaultFieldRect({ signer: 'landlord', page: 1, signaturePage: 1, existing });
    expect(again).toEqual(first);
  });

  it('連續錯開到頁緣時夾回頁內', () => {
    const base = defaultFieldRect({ signer: 'tenant', page: 1, signaturePage: 1, existing: [] });
    const existing = Array.from({ length: 30 }, (_, i) =>
      field({
        id: `f${i}`,
        page: 1,
        x: base.x + i * DEFAULT_FIELD_STACK_STEP.x,
        y: base.y + i * DEFAULT_FIELD_STACK_STEP.y,
        w: base.w,
        h: base.h,
      })
    );
    const rect = defaultFieldRect({ signer: 'tenant', page: 1, signaturePage: 1, existing });
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(1);
    expect(rect.y + rect.h).toBeLessThanOrEqual(1);
  });
});

describe('clampRect', () => {
  it('超出右下界時整個框推回頁內', () => {
    expect(clampRect({ x: 0.9, y: 0.98, w: 0.3, h: 0.06 })).toEqual({
      x: 0.7,
      y: 0.94,
      w: 0.3,
      h: 0.06,
    });
  });

  it('負座標夾回 0', () => {
    expect(clampRect({ x: -0.4, y: -0.1, w: 0.2, h: 0.05 })).toEqual({
      x: 0,
      y: 0,
      w: 0.2,
      h: 0.05,
    });
  });

  it('框比整頁還大時先把寬高夾成滿版', () => {
    expect(clampRect({ x: 0.3, y: 0.3, w: 1.4, h: 2 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('已經在範圍內就原樣回傳', () => {
    const rect = { x: 0.2, y: 0.3, w: 0.25, h: 0.05 };
    expect(clampRect(rect)).toEqual(rect);
  });
});

describe('snapThresholdRatio', () => {
  it('把 px 閾值換算成兩軸各自的比例', () => {
    const t = snapThresholdRatio({ width: 600, height: 800 }, 6);
    expect(t.x).toBeCloseTo(0.01, 10);
    expect(t.y).toBeCloseTo(0.0075, 10);
  });
});

describe('snapPosition', () => {
  const threshold = { x: 0.01, y: 0.01 };
  const moving = { x: 0.204, y: 0.5, w: 0.2, h: 0.06 };

  it('左緣接近同頁其他框的左緣時吸附並畫一條垂直線', () => {
    const others = [{ x: 0.2, y: 0.1, w: 0.3, h: 0.06 }];
    const result = snapPosition(moving, others, threshold);
    expect(result.x).toBeCloseTo(0.2, 10);
    expect(result.guides).toContainEqual({ orientation: 'vertical', position: 0.2 });
  });

  it('中線對中線也會吸附', () => {
    // 其他框中線 0.35；moving 寬 0.2，吸附後 x = 0.25
    const others = [{ x: 0.2, y: 0.1, w: 0.3, h: 0.06 }];
    const result = snapPosition({ ...moving, x: 0.253 }, others, threshold);
    expect(result.x).toBeCloseTo(0.25, 10);
    expect(result.guides).toContainEqual({ orientation: 'vertical', position: 0.35 });
  });

  it('右緣對其他框右緣', () => {
    const others = [{ x: 0.2, y: 0.1, w: 0.3, h: 0.06 }];
    const result = snapPosition({ ...moving, x: 0.304 }, others, threshold);
    expect(result.x).toBeCloseTo(0.3, 10);
    expect(result.guides).toContainEqual({ orientation: 'vertical', position: 0.5 });
  });

  it('上緣對其他框上緣時吸附並畫水平線', () => {
    const others = [{ x: 0.7, y: 0.5, w: 0.2, h: 0.06 }];
    const result = snapPosition({ ...moving, x: 0.05, y: 0.505 }, others, threshold);
    expect(result.y).toBeCloseTo(0.5, 10);
    expect(result.guides).toContainEqual({ orientation: 'horizontal', position: 0.5 });
  });

  it('沒有任何邊在閾值內就原樣回傳、不畫線', () => {
    const others = [{ x: 0.7, y: 0.8, w: 0.1, h: 0.05 }];
    const result = snapPosition({ x: 0.31, y: 0.42, w: 0.2, h: 0.06 }, others, {
      x: 0.001,
      y: 0.001,
    });
    expect(result).toEqual({ x: 0.31, y: 0.42, guides: [] });
  });

  it('兩個候選都在閾值內時取比較近的那個', () => {
    const others = [
      { x: 0.2, y: 0.1, w: 0.3, h: 0.06 },
      { x: 0.206, y: 0.1, w: 0.3, h: 0.06 },
    ];
    const result = snapPosition({ ...moving, x: 0.205 }, others, threshold);
    expect(result.x).toBeCloseTo(0.206, 10);
  });

  it('同一次吸附對到多個框的同一位置時，只畫一條線', () => {
    const others = [
      { x: 0.2, y: 0.1, w: 0.3, h: 0.06 },
      { x: 0.2, y: 0.3, w: 0.3, h: 0.06 },
    ];
    const result = snapPosition(moving, others, threshold);
    const vertical = result.guides.filter((g) => g.orientation === 'vertical');
    expect(vertical).toEqual([{ orientation: 'vertical', position: 0.2 }]);
  });

  it('沒有其他框時仍會吸附頁緣邊距', () => {
    const marginX = MARGIN / PAGE_W;
    const result = snapPosition({ x: marginX + 0.003, y: 0.5, w: 0.2, h: 0.06 }, [], threshold);
    expect(result.x).toBeCloseTo(marginX, 10);
    expect(result.guides).toContainEqual({ orientation: 'vertical', position: marginX });
  });

  it('吸附頁面中線', () => {
    // 寬 0.2 的框，中線對 0.5 時 x = 0.4
    const result = snapPosition({ x: 0.404, y: 0.2, w: 0.2, h: 0.06 }, [], threshold);
    expect(result.x).toBeCloseTo(0.4, 10);
    expect(result.guides).toContainEqual({ orientation: 'vertical', position: 0.5 });
  });

  it('吸附後超出頁面時夾回範圍內', () => {
    const result = snapPosition({ x: 0.995, y: 0.5, w: 0.2, h: 0.06 }, [], { x: 0.02, y: 0.02 });
    expect(result.x).toBeLessThanOrEqual(0.8);
    expect(result.x).toBeGreaterThanOrEqual(0);
  });
});

describe('重疊偵測', () => {
  it('rectsOverlap 只在真的相交時為真', () => {
    const a = { x: 0.25, y: 0.25, w: 0.25, h: 0.25 };
    expect(rectsOverlap(a, { x: 0.375, y: 0.375, w: 0.25, h: 0.25 })).toBe(true);
    expect(rectsOverlap(a, { x: 0.5, y: 0.25, w: 0.25, h: 0.25 })).toBe(false); // 邊貼邊不算
    expect(rectsOverlap(a, { x: 0.75, y: 0.75, w: 0.25, h: 0.25 })).toBe(false);
  });

  it('只回報同頁且甲乙互相重疊的組合', () => {
    const fields = [
      field({ id: 'l1', signer: 'landlord', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }),
      field({ id: 't1', signer: 'tenant', page: 0, x: 0.2, y: 0.15, w: 0.2, h: 0.1 }),
      field({ id: 'l2', signer: 'landlord', page: 1, x: 0.2, y: 0.15, w: 0.2, h: 0.1 }),
    ];
    expect(crossSignerOverlaps(fields)).toEqual([{ page: 0, ids: ['l1', 't1'] }]);
  });

  it('同一方的兩個框重疊不算警示', () => {
    const fields = [
      field({ id: 'l1', signer: 'landlord', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }),
      field({ id: 'l2', signer: 'landlord', page: 0, x: 0.15, y: 0.12, w: 0.2, h: 0.1 }),
    ];
    expect(crossSignerOverlaps(fields)).toEqual([]);
    expect(overlapWarning(fields)).toBeNull();
  });

  it('警示訊息列出重疊的頁碼（1-based、去重）', () => {
    const fields = [
      field({ id: 'l1', signer: 'landlord', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }),
      field({ id: 't1', signer: 'tenant', page: 0, x: 0.2, y: 0.15, w: 0.2, h: 0.1 }),
      field({ id: 't2', signer: 'tenant', page: 0, x: 0.12, y: 0.12, w: 0.2, h: 0.1 }),
      field({ id: 'l3', signer: 'landlord', page: 2, x: 0.5, y: 0.5, w: 0.2, h: 0.1 }),
      field({ id: 't3', signer: 'tenant', page: 2, x: 0.55, y: 0.52, w: 0.2, h: 0.1 }),
    ];
    expect(overlapWarning(fields)).toBe('第 1、3 頁有甲乙簽名框重疊，請分開擺放避免簽名蓋到彼此');
  });
});
