import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanSource } from './legacy-scan';

// 舊用詞 lint（MIL-122 AC7、AC8）：src 的介面字串必須不含房東、租客、房客、出租方、承租方、業主。
// 合約 PDF、承租人端與標章的字串另禁「經理人」。範圍與例外見 legacy-scan.ts。
// 例外：程式註解、測試檔、程式識別字（掃描器只看字串節點）、LEGACY_TERMS 本身，
// 以及字串旁標 `legacy-term-ok: 理由` 的法條或法定文件名引用。
// 資料庫欄位與識別字改名由 MIL-124 處理，不在此檢查。

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SRC = join(ROOT, 'src');

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listSources(full);
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name) || name.endsWith('.d.ts')) return [];
    return [full];
  });
}

describe('src 的介面字串不含舊用詞', () => {
  const files = listSources(SRC);

  it('有掃到 src 底下的檔案', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('沒有任何舊用詞', () => {
    const hits = files.flatMap((f) =>
      scanSource(relative(ROOT, f).split(sep).join('/'), readFileSync(f, 'utf8')),
    );
    expect(hits.map((h) => `${h.file}:${h.line} 「${h.term}」 ${h.text}`)).toEqual([]);
  });
});
