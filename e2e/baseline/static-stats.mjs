// 現況基準（MIL-170）的靜態統計：每頁專屬原始碼的 inline style、寫死色碼、寫死 px、antd 已棄用 API 的數量。
// 只讀 src/，不改任何檔案。用法（在 worktree 根目錄）：
//   node e2e/baseline/static-stats.mjs
// 輸出 docs/ui/baseline/data/static-stats.json。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PAGES, SHARED_SOURCES } from './pages.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
// BASELINE_UI_DIR 改輸出位置：最終驗收（MIL-185）設成 docs/ui/final
const OUT = path.join(ROOT, process.env.BASELINE_UI_DIR ?? path.join('docs', 'ui', 'baseline'), 'data');
mkdirSync(OUT, { recursive: true });

const SOURCE_EXT = /\.(tsx|ts|css)$/;
const TEST_FILE = /\.(test|pg\.test)\.(ts|tsx)$/;

function expand(entry) {
  const full = path.join(ROOT, entry);
  let stat;
  try {
    stat = statSync(full);
  } catch {
    return { files: [], missing: entry };
  }
  if (stat.isFile()) return { files: [entry], missing: null };
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const child = path.join(dir, name);
      if (statSync(child).isDirectory()) walk(child);
      else if (SOURCE_EXT.test(name) && !TEST_FILE.test(name)) files.push(path.relative(ROOT, child));
    }
  };
  walk(full);
  return { files, missing: null };
}

/** 拿掉註解，避免把註解裡的 # 當成色碼。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function count(text, pattern) {
  return (text.match(pattern) ?? []).length;
}

const lintCache = new Map();
function antdDeprecated(file) {
  if (!/\.(tsx|ts)$/.test(file)) return 0;
  if (lintCache.has(file)) return lintCache.get(file);
  let total = 0;
  try {
    const out = execFileSync('antd', ['lint', '--only', 'deprecated', '--format', 'json', file], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    total = JSON.parse(out).summary?.deprecated ?? 0;
  } catch (error) {
    const out = error.stdout?.toString() ?? '';
    try {
      total = JSON.parse(out).summary?.deprecated ?? 0;
    } catch {
      total = -1;
    }
  }
  lintCache.set(file, total);
  return total;
}

function statsFor(entries) {
  const files = [];
  const missing = [];
  for (const entry of entries) {
    const r = expand(entry);
    files.push(...r.files);
    if (r.missing) missing.push(r.missing);
  }
  const unique = [...new Set(files)];
  const total = { files: unique.length, loc: 0, inlineStyle: 0, colorCodes: 0, pxLiterals: 0, antdDeprecated: 0, feedbackCalls: 0, lintFailed: 0, missing };
  for (const file of unique) {
    const raw = readFileSync(path.join(ROOT, file), 'utf8');
    const text = stripComments(raw);
    total.loc += raw.split('\n').length;
    total.inlineStyle += count(text, /\bstyle=\{/g);
    total.colorCodes += count(text, /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])|\brgba?\(/g);
    total.pxLiterals += count(text, /\b\d+(?:\.\d+)?px\b/g);
    total.feedbackCalls += count(text, /\bmessage\.(?:success|error|warning|info)\(|\bnotification\.|Modal\.confirm|<Popconfirm|<Alert\b/g);
    const deprecated = antdDeprecated(file);
    if (deprecated < 0) total.lintFailed += 1;
    else total.antdDeprecated += deprecated;
  }
  return total;
}

const pages = {};
for (const page of PAGES) pages[page.id] = { title: page.title, sources: page.sources, ...statsFor(page.sources) };
const shared = { sources: SHARED_SOURCES, ...statsFor(SHARED_SOURCES) };

// 全站 src 的總數，當作基準線
const all = statsFor(['src/app', 'src/components']);

writeFileSync(path.join(OUT, 'static-stats.json'), JSON.stringify({ measuredAt: new Date().toISOString(), pages, shared, allUiSources: all }, null, 2));
console.log(`頁面 ${PAGES.length} 個，共用 ${shared.files} 檔，src/app 與 src/components 共 ${all.files} 檔`);
console.log(`全站 inline style ${all.inlineStyle}，色碼 ${all.colorCodes}，px ${all.pxLiterals}，antd 已棄用 ${all.antdDeprecated}`);
