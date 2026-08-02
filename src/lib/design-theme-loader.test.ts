import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadDesignTheme } from './design-theme-loader';

describe('loadDesignTheme（讀檔與 fallback）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-theme-'));

  it('讀取檔案並解析出 theme 資料', () => {
    const file = join(dir, 'ok.md');
    writeFileSync(file, '---\ncolors:\n  primary: "#5e6ad2"\n---\n');
    expect(loadDesignTheme(file)?.token.colorPrimary).toBe('#5e6ad2');
  });

  it('檔案不存在時 fallback 回 undefined 並記 error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadDesignTheme(join(dir, 'missing.md'))).toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('front matter 是壞 YAML 時 fallback 回 undefined 並記 error', () => {
    const file = join(dir, 'broken.md');
    writeFileSync(file, '---\ncolors: [not: valid: yaml\n---\n');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadDesignTheme(file)).toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('檔案沒有 front matter 時也 fallback 並記 error，不靜默', () => {
    const file = join(dir, 'no-front-matter.md');
    writeFileSync(file, '# 只有內文\n');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadDesignTheme(file)).toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
