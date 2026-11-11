// 最終驗收報告（MIL-185）的產生器：把重構前的基準與這次重拍的量測、評分合成 docs/ui/final/README.md。
// 輸入：docs/ui/baseline/data/（重構前）與 docs/ui/final/data/（這次）的 results.json、scores.json、static-stats.json。
// 敘述段落（階段重點、限制、決定）寫在 e2e/baseline/final-narrative.mjs，數字與表格由這支腳本算。
// 用法（在 worktree 根目錄）：node e2e/baseline/build-final.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PAGES } from './pages.ts';
import { narrative } from './final-narrative.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BEFORE = path.join(ROOT, 'docs', 'ui', 'baseline', 'data');
const AFTER = path.join(ROOT, 'docs', 'ui', 'final', 'data');
const read = (dir, name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
const bScores = read(BEFORE, 'scores.json');
const bResults = read(BEFORE, 'results.json');
const bStats = read(BEFORE, 'static-stats.json');
const aScores = read(AFTER, 'scores.json');
const aResults = read(AFTER, 'results.json');
const aStats = read(AFTER, 'static-stats.json');

const CRITERIA = ['速度', '一致', '狀態', '導覽', '視覺', '回饋'];

// 重構票：每頁最後一次大改的那張票
const TICKET = {
  '01': 'MIL-178',
  '02': 'MIL-174',
  '03': 'MIL-175',
  '04': 'MIL-175',
  '05': 'MIL-175',
  '06': 'MIL-175',
  '07': 'MIL-176',
  '08': 'MIL-176',
  '09': 'MIL-176',
  '10': 'MIL-176',
  '11': 'MIL-177',
  '12': 'MIL-177',
  '13': 'MIL-184',
  '14': 'MIL-184',
  '15': 'MIL-184',
  '16': 'MIL-181',
  '17': 'MIL-179',
  '18': 'MIL-181',
  '19': 'MIL-182',
  '20': 'MIL-182',
  '21': 'MIL-182',
  '22': 'MIL-182',
  '23': 'MIL-184',
  '24': 'MIL-182',
  '25': 'MIL-182',
  '26': 'MIL-181',
  '27': 'MIL-181',
  '28': 'MIL-180',
  '29': 'MIL-180',
  '30': 'MIL-180',
  '31': 'MIL-183',
  '32': 'MIL-183',
  '33': 'MIL-175',
  '34': 'MIL-176',
  '35': 'MIL-171',
  '36': 'MIL-176',
  '37': 'MIL-176',
};
const ticketOf = (id) => TICKET[id.slice(0, 2)] ?? '-';

// impeccable detect 的規則分級，與 e2e/baseline/build-report.mjs 相同
const EXCLUDED = new Set(['low-contrast', 'tiny-text', 'undersized-ui-text', 'skipped-heading', 'body-text-viewport-edge', 'line-length']);
function classify(finding) {
  const rule = finding.antipattern ?? finding.id ?? finding.rule ?? '';
  if (EXCLUDED.has(rule)) return 'excluded';
  if (finding.severity === 'error') return 'P0';
  if (finding.category === 'quality' && finding.severity === 'warning') return 'P1';
  return 'other';
}
function auditOf(results, scores, id) {
  const page = results.pages.find((p) => p.id === id);
  const groups = { P0: [], P1: [], other: [], excluded: [] };
  for (const f of page?.audit?.findings ?? []) groups[classify(f)].push(f);
  const manual = scores[id]?.manual ?? [];
  return {
    groups,
    manual,
    p0: groups.P0.length + manual.filter((m) => m.p === 'P0').length,
    p1: groups.P1.length + manual.filter((m) => m.p === 'P1').length,
    mode: page?.audit ? '渲染' : '無',
  };
}

const sum = (list) => list.reduce((x, y) => x + y, 0);
const avgs = (rows) => CRITERIA.map((_c, i) => (sum(rows.map((r) => r[i])) / Math.max(rows.length, 1)));
const fmt = (n) => n.toFixed(1);

// 只比較前後都有分數的頁面，才是同一批頁面的前後
const rows = PAGES.map((page) => ({
  page,
  before: bScores[page.id]?.s ?? null,
  after: aScores[page.id]?.s ?? null,
  auditBefore: auditOf(bResults, bScores, page.id),
  auditAfter: auditOf(aResults, aScores, page.id),
  hasBeforeShot: Boolean(bResults.pages.find((p) => p.id === page.id)?.screenshot),
  hasAfterShot: Boolean(aResults.pages.find((p) => p.id === page.id)?.screenshot),
}));
const paired = rows.filter((r) => r.before && r.after);
const afterOnly = rows.filter((r) => r.after);
const beforeAvg = avgs(paired.map((r) => r.before));
const afterAvg = avgs(paired.map((r) => r.after));
const afterAllAvg = avgs(afterOnly.map((r) => r.after));
const total = (a) => sum(a);

const p0After = sum(afterOnly.map((r) => r.auditAfter.p0));
const p1After = sum(afterOnly.map((r) => r.auditAfter.p1));
const p0Before = sum(paired.map((r) => r.auditBefore.p0));
const p1Before = sum(paired.map((r) => r.auditBefore.p1));

const lines = [];
const out = (text = '') => lines.push(text);

const inScope = (stats, id) => stats.pages[id];
const beforeInline = bStats.allUiSources.inlineStyle;
const afterInline = aStats.allUiSources.inlineStyle;

out('# UI 重構最終驗收（MIL-185）');
out();
out(narrative.intro({
  pagesPaired: paired.length,
  pagesAfter: afterOnly.length,
  beforeTotal: total(beforeAvg),
  afterTotal: total(afterAvg),
  afterAllTotal: total(afterAllAvg),
  p0Before,
  p1Before,
  p0After,
  p1After,
  beforeInline,
  afterInline,
  beforeColor: bStats.allUiSources.colorCodes,
  afterColor: aStats.allUiSources.colorCodes,
  beforeDeprecated: bStats.allUiSources.antdDeprecated,
  afterDeprecated: aStats.allUiSources.antdDeprecated,
}));
out();

out('## 總表');
out();
out('分數 0 到 4，滿分 24，規則與 [重構前基準](../baseline/README.md) 相同。欄位依序是速度、一致、狀態一眼看懂、導覽、視覺、回饋。P0 與 P1 是 impeccable audit 加人工複查的數量，無障礙與響應式不列入。');
out('前後各一格：「前」是重構前基準，「後」是這次重拍。沒有前分數的頁面是基準之後才有畫面的頁。');
out();
out('| 頁面 | 重構票 | 前 6 項 | 前合計 | 後 6 項 | 後合計 | 後 P0 / P1 | 前圖 | 後圖 |');
out('| -- | -- | -- | -- | -- | -- | -- | -- | -- |');
for (const r of rows) {
  const id = r.page.id;
  const b = r.before ? r.before.join(' / ') : '-';
  const bt = r.before ? sum(r.before) : '-';
  const a = r.after ? r.after.join(' / ') : '-';
  const at = r.after ? sum(r.after) : '-';
  const audit = r.after ? `${r.auditAfter.p0} / ${r.auditAfter.p1}` : '-';
  const bl = r.hasBeforeShot ? `[前](../baseline/${id}.png)` : '-';
  const al = r.hasAfterShot ? `[後](${id}.png)` : '-';
  out(`| ${id} ${r.page.title} | ${ticketOf(id)} | ${b} | ${bt} | ${a} | ${at} | ${audit} | ${bl} | ${al} |`);
}
out(`| **平均（前後都有分數的 ${paired.length} 頁）** | | ${beforeAvg.map(fmt).join(' / ')} | ${fmt(total(beforeAvg))} | ${afterAvg.map(fmt).join(' / ')} | ${fmt(total(afterAvg))} | ${p0After} / ${p1After}（全 ${afterOnly.length} 頁） | | |`);
out();
out(`六項順序：${CRITERIA.join('、')}。前後的合計是各項平均相加。`);
out();

out('## impeccable audit');
out();
out(narrative.audit({ p0After, p1After, afterOnly: afterOnly.length }));
out();
out('| 頁面 | P0 | P1 | 其他（slop 與 advisory） | 已排除（無障礙與響應式） |');
out('| -- | -- | -- | -- | -- |');
for (const r of afterOnly) {
  const a = r.auditAfter;
  out(`| ${r.page.id} | ${a.p0} | ${a.p1} | ${a.groups.other.length} | ${a.groups.excluded.length} |`);
}
out();
const listed = afterOnly.flatMap((r) => [
  ...r.auditAfter.groups.P0.map((f) => `- ${r.page.id} P0：${f.antipattern ?? f.id}（${(f.snippet ?? '').slice(0, 80)}）`),
  ...r.auditAfter.groups.P1.map((f) => `- ${r.page.id} P1：${f.antipattern ?? f.id}（${(f.snippet ?? '').slice(0, 80)}）`),
  ...r.auditAfter.manual.map((m) => `- ${r.page.id} ${m.p}（人工）：${m.text}`),
]);
if (listed.length > 0) {
  out('P0 與 P1 的項目：');
  out();
  for (const l of listed) out(l);
  out();
}
const others = afterOnly.flatMap((r) => r.auditAfter.groups.other.map((f) => `${r.page.id}：${f.antipattern ?? f.id}`));
if (others.length > 0) {
  const counts = new Map();
  for (const o of others) counts.set(o.split('：')[1], (counts.get(o.split('：')[1]) ?? 0) + 1);
  out(`其他類（不算 P0 與 P1）：${[...counts].map(([rule, n]) => `${rule} ×${n}`).join('、')}。明細在 \`data/results.json\`。`);
  out();
}

out('## 靜態統計');
out();
out('| 項目 | 重構前 | 現在 |');
out('| -- | -- | -- |');
out(`| src/app 與 src/components 的 inline style | ${beforeInline} | ${afterInline}（都在承租人端與 demo 頁） |`);
out(`| 寫死色碼 | ${bStats.allUiSources.colorCodes} | ${aStats.allUiSources.colorCodes} |`);
out(`| 寫死 px | ${bStats.allUiSources.pxLiterals} | ${aStats.allUiSources.pxLiterals} |`);
out(`| antd 已棄用 API | ${bStats.allUiSources.antdDeprecated} | ${aStats.allUiSources.antdDeprecated} |`);
out(`| 殼層與跨頁元件的 inline style | ${bStats.shared.inlineStyle} | ${aStats.shared.inlineStyle} |`);
out();
out(narrative.statsNote());
out();

out(narrative.stages());
out();
out(narrative.leftovers());
out();
out(narrative.limits());
out();
out(narrative.decisions());
out();

writeFileSync(path.join(ROOT, 'docs', 'ui', 'final', 'README.md'), lines.join('\n') + '\n');
console.log(`README 已寫入：${rows.length} 頁，前後都有分數 ${paired.length} 頁，P0 ${p0After}、P1 ${p1After}`);
