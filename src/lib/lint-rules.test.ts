import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// eslint.config.mjs 的新規則（MIL-80）真的擋得住：用真實設定檢查幾段違規程式碼。
// filePath 必須是 tsconfig 涵蓋的既有檔案，型別感知的規則才跑得起來；內容用 lintText 傳入的文字取代。

const cwd = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd });

async function rulesFlagged(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${cwd}/${filePath}` });
  return result.messages.map((m) => m.ruleId ?? 'parse-error');
}

const ROUTE = 'src/app/api/health/route.ts';
const LIB = 'src/lib/nav.ts';

describe('ESLint 新規則', () => {
  it('route handler 直接用 Response.json 被擋', async () => {
    const code = `export async function GET() { return Response.json({ ok: true }); }`;
    expect(await rulesFlagged(code, ROUTE)).toContain('no-restricted-syntax');
  });

  it('NextResponse.json 同樣被擋', async () => {
    const code = `import { NextResponse } from 'next/server';\nexport async function GET() { return NextResponse.json({ ok: true }); }`;
    expect(await rulesFlagged(code, ROUTE)).toContain('no-restricted-syntax');
  });

  it('src/lib/http.ts 自己可以用 Response.json', async () => {
    const code = `export const r = () => Response.json({ ok: true });`;
    expect(await rulesFlagged(code, 'src/lib/http.ts')).not.toContain('no-restricted-syntax');
  });

  it('jsonOk 與 jsonError 不被擋', async () => {
    const code = `import { jsonOk } from '@/lib/http';\nexport async function GET() { return jsonOk({ ok: true }); }`;
    expect(await rulesFlagged(code, ROUTE)).toEqual([]);
  });

  it('漏 await 的 Promise 被擋（no-floating-promises）', async () => {
    const code = `async function load() { return 1; }\nexport async function GET() { load(); return new Response('x'); }`;
    expect(await rulesFlagged(code, ROUTE)).toContain('@typescript-eslint/no-floating-promises');
  });

  it('async 函式傳進預期回傳 void 的位置被擋（no-misused-promises）', async () => {
    const code = `export const run = () => { [1, 2].forEach(async (n) => { await Promise.resolve(n); }); };`;
    expect(await rulesFlagged(code, LIB)).toContain('@typescript-eslint/no-misused-promises');
  });

  it('withTx 的 callback 內直接 fetch 或開計時器被擋', async () => {
    const fetchCode = `import { withTx } from '@/lib/pg/database';\nexport const f = () => withTx({ kind: 'control' }, async () => { await fetch('https://example.com'); });`;
    const timerCode = `import { withTx } from '@/lib/pg/database';\nexport const f = () => withTx({ kind: 'control' }, async () => { setTimeout(() => undefined, 1); });`;
    expect(await rulesFlagged(fetchCode, LIB)).toContain('no-restricted-syntax');
    expect(await rulesFlagged(timerCode, LIB)).toContain('no-restricted-syntax');
  });

  it('withTx 的 callback 內直接做 fs 操作被擋', async () => {
    const code = `import fs from 'fs';\nimport { withTx } from '@/lib/pg/database';\nexport const f = () => withTx({ kind: 'control' }, async () => { await fs.promises.readFile('x'); });`;
    expect(await rulesFlagged(code, LIB)).toContain('no-restricted-syntax');
  });

  it('withTx 之外的 fetch 不被擋', async () => {
    const code = `export const f = async () => { await fetch('https://example.com'); };`;
    expect(await rulesFlagged(code, LIB)).not.toContain('no-restricted-syntax');
  });
}, 120_000);
