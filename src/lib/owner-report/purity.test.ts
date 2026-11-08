import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as publicApi from './index';

describe('模組只含純函式', () => {
  const dir = __dirname;
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'fixtures.ts')
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const);

  // 只准讀同模組的檔案，與三個相鄰的純函式模組。
  const ALLOWED_IMPORT = /^(\.\/|\.\.\/(ledger|receivables|deposit-rules)$)/;

  it.each(sources)('%s 不讀系統時鐘、不碰資料庫、不 import 模組外的檔案', (_file, text) => {
    const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/Date\.now\s*\(/);
    expect(code).not.toMatch(/new Date\s*\(\s*\)/);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    const imports = [...code.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((m) => m[1]);
    const bad = imports.filter((p) => !ALLOWED_IMPORT.test(p));
    expect(bad).toEqual([]);
    expect(imports.some((p) => /\bdb\b|repository|statement-import|tenancy-records/.test(p))).toBe(false);
  });

  it('公開介面只有兩個函式，其餘是常數', () => {
    const functions = Object.entries(publicApi)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(['buildOwnerReport', 'reportToCsv', 'reportToCsvRows']);
  });
});
