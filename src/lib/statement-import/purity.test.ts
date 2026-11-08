import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('模組只含純函式', () => {
  const dir = __dirname;
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const);

  it.each(sources)('%s 不讀系統時鐘、不產生亂數、不碰資料庫與檔案系統', (_file, text) => {
    const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/Date\.now\s*\(/);
    expect(code).not.toMatch(/new Date\s*\(\s*\)/);
    expect(code).not.toMatch(/Math\.random/);
    const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    // 只允許同目錄的檔案、receivables 的日期工具，以及 node:crypto（SHA-256，確定性的雜湊）。
    expect(imports.every((p) => p.startsWith('./') || p === '../receivables/dates' || p === 'node:crypto')).toBe(true);
  });
});
