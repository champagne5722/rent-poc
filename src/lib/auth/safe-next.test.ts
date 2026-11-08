import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-next';

describe('safeNextPath（登入後的返回路徑）', () => {
  it.each(['/', '/properties', '/contracts/new?step=2', '/owner/handovers#top'])('站內路徑原樣採用：%s', (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([
    ['沒有值', undefined],
    ['空字串', ''],
    ['外部網址', 'https://evil.example.com'],
    ['協定相對網址', '//evil.example.com'],
    ['tab 夾在中間，瀏覽器會去掉它變成 //', '/\t/evil.example.com'],
    ['換行夾在中間', '/\n/evil.example.com'],
    ['歸位字元夾在中間', '/\r/evil.example.com'],
    ['反斜線，部分瀏覽器當成斜線', '/\\evil.example.com'],
    ['不是斜線開頭', 'properties'],
    ['javascript 協定', 'javascript:alert(1)'],
    ['登入頁自己', '/login'],
    ['登入頁帶參數', '/login?next=/'],
  ])('一律退回預設：%s', (_name, raw) => {
    expect(safeNextPath(raw)).toBe('/');
  });

  it('陣列只取第一個，預設值可指定', () => {
    expect(safeNextPath(['/properties', '/x'])).toBe('/properties');
    expect(safeNextPath('//x', '/owner')).toBe('/owner');
  });
});
