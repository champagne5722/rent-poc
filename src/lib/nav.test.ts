import { describe, expect, it } from 'vitest';
import {
  NAV_ITEMS,
  CREATE_CONTRACT_HREF,
  OWNER_NAV_ITEMS,
  resolveNavKey,
  resolveOwnerNavKey,
  shellFor,
} from './nav';

describe('resolveNavKey（側邊選單高亮）', () => {
  it('根路徑對應工作台', () => {
    expect(resolveNavKey('/')).toBe('workbench');
  });

  it('一級頁面對應各自的選單項', () => {
    expect(resolveNavKey('/properties')).toBe('properties');
    expect(resolveNavKey('/contracts')).toBe('contracts');
    expect(resolveNavKey('/design')).toBe('design');
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
  it('選單是工作台、物件、合約、收款帳戶、移交、設計六項', () => {
    expect(NAV_ITEMS.map((i) => i.key)).toEqual([
      'workbench',
      'properties',
      'contracts',
      'payment-accounts',
      'handovers',
      'design',
    ]);
    expect(NAV_ITEMS.map((i) => i.href)).toEqual([
      '/',
      '/properties',
      '/contracts',
      '/payment-accounts',
      '/handovers',
      '/design',
    ]);
  });

  it('移交清單與詳情都高亮移交', () => {
    expect(resolveNavKey('/handovers')).toBe('handovers');
    expect(resolveNavKey('/handovers/ho-0003')).toBe('handovers');
  });

  it('每個選單項的 href 都會高亮自己', () => {
    for (const item of NAV_ITEMS) {
      expect(resolveNavKey(item.href)).toBe(item.key);
    }
  });

  it('常駐建約 CTA 指向建約 wizard', () => {
    expect(CREATE_CONTRACT_HREF).toBe('/contracts/new');
  });

  it('建約 wizard 屬於合約一級頁面', () => {
    expect(resolveNavKey(CREATE_CONTRACT_HREF)).toBe('contracts');
    expect(resolveNavKey('/contracts/42/edit')).toBe('contracts');
  });
});

describe('shellFor（依路徑選殼層）', () => {
  it.each([
    ['/owner', 'owner'],
    ['/owner/', 'owner'],
    ['/owner/handovers', 'owner'],
    ['/owner/handovers/12', 'owner'],
    ['/', 'admin'],
    ['/contracts', 'admin'],
    ['/contracts/new', 'admin'],
    ['/properties/7/edit', 'admin'],
    ['/design', 'admin'],
    ['/owners', 'admin'],
    ['/ownerx/1', 'admin'],
    ['/contracts/owner', 'admin'],
  ] as const)('%s 用 %s 殼層', (pathname, shell) => {
    expect(shellFor(pathname)).toBe(shell);
  });
});

describe('resolveOwnerNavKey（屋主端選單高亮）', () => {
  it.each([
    ['/owner', 'overview'],
    ['/owner/', 'overview'],
    ['/owner/handovers', 'handovers'],
    ['/owner/handovers/12', 'handovers'],
    ['/owner/unknown', null],
  ] as const)('%s 高亮 %s', (pathname, key) => {
    expect(resolveOwnerNavKey(pathname)).toBe(key);
  });

  it('屋主端選單是資產總覽與移交兩項，沒有建立合約', () => {
    expect(OWNER_NAV_ITEMS.map((i) => i.label)).toEqual(['資產總覽', '移交']);
    expect(OWNER_NAV_ITEMS.map((i) => i.href)).toEqual(['/owner', '/owner/handovers']);
    expect(OWNER_NAV_ITEMS.some((i) => i.href.startsWith(CREATE_CONTRACT_HREF))).toBe(false);
  });

  it('屋主端每個選單項都在屋主端殼層內', () => {
    for (const item of OWNER_NAV_ITEMS) {
      expect(shellFor(item.href)).toBe('owner');
      expect(resolveOwnerNavKey(item.href)).toBe(item.key);
    }
  });
});
