import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 模組只含純函式：不讀系統時鐘、不產生亂數、不碰資料庫。
// 唯一允許的模組外匯入是 ../cases 的型別與常數（業務類型），其餘只能匯入同目錄。
describe('模組只含純函式', () => {
  const dir = __dirname;
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const);

  it('有原始檔可檢查', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources)('%s 不讀系統時鐘、不碰資料庫、不匯入不該匯入的模組', (_file, text) => {
    const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/Date\.now\s*\(/);
    expect(code).not.toMatch(/new Date\s*\(/);
    expect(code).not.toMatch(/Math\.random/);
    const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.every((p) => p.startsWith('./') || p === '../cases')).toBe(true);
  });
});
