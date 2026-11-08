import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffDays, parseDate, toTaipeiDate } from './dates';

describe('toTaipeiDate（時間點換成台灣日期）', () => {
  it.each([
    ['UTC 午夜前一刻仍是台灣當天', '2026-03-09T15:59:59Z', '2026-03-09'],
    ['UTC 16:00 已是台灣隔天', '2026-03-09T16:00:00Z', '2026-03-10'],
    ['帶 +08:00', '2026-03-10T00:00:00+08:00', '2026-03-10'],
    ['帶 +08:00 的前一刻', '2026-03-09T23:59:59+08:00', '2026-03-09'],
    ['跨年', '2026-12-31T16:00:00Z', '2027-01-01'],
  ])('%s', (_name, instant, expected) => {
    expect(toTaipeiDate(instant)).toBe(expected);
  });
  it('無法解析時丟 RangeError', () => {
    expect(() => toTaipeiDate('x')).toThrow(RangeError);
  });
});

describe('日期驗證', () => {
  it('diffDays 跨閏年', () => {
    expect(diffDays('2028-03-01', '2028-02-28')).toBe(2);
    expect(diffDays('2027-03-01', '2027-02-28')).toBe(1);
    expect(diffDays('2026-01-01', '2025-01-01')).toBe(365);
  });
  it.each(['2026-13-01', '2026-00-10', '2026-04-31', '2027-02-29', '2026-1-1', ''])('拒絕 %s', (v) => {
    expect(() => parseDate(v)).toThrow(RangeError);
  });
});

describe('模組只含純函式', () => {
  const dir = __dirname;
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const);

  it.each(sources)('%s 不讀系統時鐘、不碰資料庫、不 import 其他模組', (_file, text) => {
    const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/Date\.now\s*\(/);
    expect(code).not.toMatch(/new Date\s*\(\s*\)/);
    expect(code).not.toMatch(/Math\.random/);
    const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.every((p) => p.startsWith('./'))).toBe(true);
  });
});
