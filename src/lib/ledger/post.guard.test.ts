import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MIL-117：只有 ledger 模組能呼叫 postJournal() 與 reverseJournal()（ADR-0015 決議 13）。
// 守門方式是 export 設計加原始碼掃描：index.ts 不匯出寫入入口，ledger 目錄以外的檔案不得出現這些名稱，
// 也不得匯入 post.ts 或 store.ts。其他模組要寫分錄，就在 ledger 目錄內加業務函式。

const SRC = join(__dirname, '..', '..'); // src/
const LEDGER_DIR = __dirname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

const bypasses = (source: string) => /\b(postJournal|reverseJournal)\b/.test(source) || /ledger\/(post|store)['"]/.test(source);

describe('寫入入口只有 ledger 模組能用', () => {
  it('index.ts 不匯出 post.ts 與 store.ts', () => {
    const index = readFileSync(join(LEDGER_DIR, 'index.ts'), 'utf8');
    expect(index).not.toMatch(/postJournal|reverseJournal/);
    expect(index).not.toMatch(/from\s+['"]\.\/(post|store)['"]/);
  });

  it('ledger 目錄以外的檔案沒有 postJournal、reverseJournal，也沒有匯入 ledger/post 或 ledger/store', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.startsWith(LEDGER_DIR + sep)) continue;
      const source = readFileSync(file, 'utf8');
      if (bypasses(source)) offenders.push(relative(SRC, file));
    }
    expect(offenders, '這些檔案繞過 ledger 的業務函式直接寫分錄').toEqual([]);
  });

  it('偵測規則本身有效：認得直接呼叫與匯入路徑，不誤判業務函式', () => {
    expect(bypasses(`await postJournal(tx, input)`)).toBe(true);
    expect(bypasses(`reverseJournal(tx, x)`)).toBe(true);
    expect(bypasses(`import { postJournal } from '@/lib/ledger/post';`)).toBe(true);
    expect(bypasses(`import { x } from "../ledger/store"`)).toBe(true);
    expect(bypasses(`import { confirmReceipt } from '@/lib/ledger';`)).toBe(false);
  });

  it('掃描本身有效：ledger 目錄內有這兩個函式的定義', () => {
    const source = readFileSync(join(LEDGER_DIR, 'post.ts'), 'utf8');
    expect(source).toMatch(/export async function postJournal/);
    expect(source).toMatch(/export async function reverseJournal/);
  });
});
