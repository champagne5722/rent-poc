import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, CREATE_CONTRACT_HREF, resolveNavKey } from './nav';

describe('resolveNavKey（側邊選單高亮）', () => {
  it('根路徑對應工作台', () => {
    expect(resolveNavKey('/')).toBe('workbench');
  });

  it('一級頁面對應各自的選單項', () => {
    expect(resolveNavKey('/properties')).toBe('properties');
    expect(resolveNavKey('/contracts')).toBe('contracts');
  });

  it('子頁面沿用一級頁面的高亮', () => {
    expect(resolveNavKey('/contracts/42')).toBe('contracts');
    expect(resolveNavKey('/properties/7/edit')).toBe('properties');
  });

  it('尾端斜線不影響判斷', () => {
    expect(resolveNavKey('/contracts/')).toBe('contracts');
  });

  it('只是前綴相同的路徑不算命中', () => {
    expect(resolveNavKey('/contracts-archive')).toBeNull();
  });

  it('未知路徑不高亮任何選單項', () => {
    expect(resolveNavKey('/whatever')).toBeNull();
  });
});

describe('殼層導覽定義', () => {
  it('選單就是工作台、物件、合約三項', () => {
    expect(NAV_ITEMS.map((i) => i.key)).toEqual(['workbench', 'properties', 'contracts']);
    expect(NAV_ITEMS.map((i) => i.href)).toEqual(['/', '/properties', '/contracts']);
  });

  it('每個選單項的 href 都會高亮自己', () => {
    for (const item of NAV_ITEMS) {
      expect(resolveNavKey(item.href)).toBe(item.key);
    }
  });

  it('常駐建約 CTA 指向現行建約入口', () => {
    expect(CREATE_CONTRACT_HREF).toBe('/properties');
  });
});
