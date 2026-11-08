import { describe, expect, it } from 'vitest';
import { unitFullText, unitShortText } from './unit-display';

describe('unit-display', () => {
  const whole = { unit_type: 'whole', suffix: '0000', label: null } as const;
  const sublet = { unit_type: 'sublet', suffix: '0001', label: '301' } as const;

  it('整戶顯示「整戶」，分租顯示房號', () => {
    expect(unitShortText(whole)).toBe('整戶');
    expect(unitShortText(sublet)).toBe('分租 301');
  });

  it('分租沒有房號時顯示後綴', () => {
    expect(unitShortText({ ...sublet, label: null })).toBe('分租 0001');
  });

  it('完整文字多帶單位後綴', () => {
    expect(unitFullText(whole)).toBe('整戶（後綴 0000）');
    expect(unitFullText(sublet)).toBe('分租 301（後綴 0001）');
  });
});
