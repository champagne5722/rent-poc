import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MIL-218：測試不得自己刪資料庫，也不得自己建 Pool。
// 刪庫與關 Pool 的順序錯了，CI 會偶發 57P01（說明見 pg-database-kit.ts 與 pool-shutdown.pg.test.ts）。
// 只有共用輔助檔 pg-database-kit.ts 能出現 DROP DATABASE 與 new Pool(。不需要資料庫，PGlite 環境也會跑。

const SRC = join(__dirname, '..', '..'); // src/
const KIT = 'lib/pg/pg-database-kit.ts';
const SELF = 'lib/pg/pg-test-teardown.guard.test.ts';
// 正式程式的連線池由 drivers.ts 建立，已掛 error 監聽器
const PRODUCTION_POOL = 'lib/pg/drivers.ts';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

const rel = (path: string) => relative(SRC, path).split(sep).join('/');
const dropDatabase = new RegExp(['DROP', 'DATABASE'].join('\\s+'), 'i');
const newPool = new RegExp(['new', 'Pool\\('].join('\\s+'));

describe('測試的刪庫與建 Pool 只能走共用輔助檔', () => {
  const files = sourceFiles(SRC).filter((f) => ![KIT, SELF].includes(rel(f)));

  it('有掃到 src 底下的檔案', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('DROP DATABASE 只出現在 pg-database-kit.ts', () => {
    const offenders = files.filter((f) => dropDatabase.test(readFileSync(f, 'utf8'))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('測試檔與測試輔助檔不自己 new Pool(', () => {
    const offenders = files
      .filter((f) => rel(f) !== PRODUCTION_POOL)
      .filter((f) => /\.test\.tsx?$/.test(f) || /test-(harness|support|cases)|-kit\.ts$/.test(f))
      .filter((f) => newPool.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
