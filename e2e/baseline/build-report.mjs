// 現況基準（MIL-170）的報告產生器：把量測結果、靜態統計、人工評分合成 docs/ui/baseline/README.md。
// 輸入（都在 docs/ui/baseline/data/）：results.json、static-stats.json、acceptance.json、scores.json（人工評分與人工發現）。
// 用法（在 worktree 根目錄）：node e2e/baseline/build-report.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PAGES } from './pages.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DIR = path.join(ROOT, 'docs', 'ui', 'baseline');
const read = (name) => JSON.parse(readFileSync(path.join(DIR, 'data', name), 'utf8'));
const results = read('results.json');
const stats = read('static-stats.json');
const scores = read('scores.json');
const acceptance = (() => {
  try {
    return read('acceptance.json');
  } catch {
    return [];
  }
})();
const issues = (() => {
  try {
    return read('issues.json');
  } catch {
    return [];
  }
})();

const CRITERIA = ['速度', '一致', '狀態', '導覽', '視覺', '回饋'];

// impeccable detect 的規則分級。detect 沒有 P0 到 P3，這裡依 audit.md 的定義對應。
// 無障礙與響應式類規則不列入（產品經理排除）。
const EXCLUDED = new Set(['low-contrast', 'tiny-text', 'undersized-ui-text', 'skipped-heading', 'body-text-viewport-edge', 'line-length']);

function classify(finding) {
  const rule = finding.antipattern ?? finding.id ?? finding.rule ?? '';
  if (EXCLUDED.has(rule)) return 'excluded';
  if (finding.severity === 'error') return 'P0';
  if (finding.category === 'quality' && finding.severity === 'warning') return 'P1';
  return 'other';
}

const byId = new Map(results.pages.map((p) => [p.id, p]));

function auditOf(id) {
  const page = byId.get(id);
  const findings = page?.audit?.findings ?? [];
  const groups = { P0: [], P1: [], other: [], excluded: [] };
  for (const f of findings) groups[classify(f)].push(f);
  const manual = scores[id]?.manual ?? [];
  const manualP0 = manual.filter((m) => m.p === 'P0');
  const manualP1 = manual.filter((m) => m.p === 'P1');
  return { groups, manualP0, manualP1, p0: groups.P0.length + manualP0.length, p1: groups.P1.length + manualP1.length };
}

function ruleSummary(list) {
  const counts = new Map();
  for (const f of list) {
    const rule = f.antipattern ?? f.id ?? f.rule ?? '?';
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  return [...counts].map(([rule, n]) => `${rule}×${n}`).join('、');
}

const lines = [];
const out = (text = '') => lines.push(text);

const measuredPages = PAGES.filter((p) => scores[p.id]?.s);
const noScreenshot = PAGES.filter((p) => !byId.get(p.id)?.screenshot);

out('# 重構前現況基準（MIL-170）');
out();
out(`量測時間：${new Date(new Date(results.capturedAt).getTime() + 8 * 3600_000).toISOString().slice(0, 10)}（台北）。環境：dev server（webpack）、全新的記憶體 PGlite、簽署 mock 模式、視窗 1440x900、亮色、繁體中文、時間固定在 2026-11-10 10:00（台北）。`);
out('規格是 MIL-167（Linear 等級檢核表），決議是 ADR-0090。這份報告只記錄重構前的狀態，沒有改任何畫面。之後每個階段的成果都和這份基準比較。');
out();
// 重點：數字全由資料算出
{
  const avgOf = (i) => (measuredPages.reduce((sum, page) => sum + scores[page.id].s[i], 0) / Math.max(measuredPages.length, 1)).toFixed(1);
  const names = CRITERIA.map((name, i) => `${name} ${avgOf(i)}`).join('、');
  const manualP1 = measuredPages.flatMap((page) => (scores[page.id].manual ?? []).filter((m) => m.p === 'P1').map((m) => m.text));
  const detectP0 = measuredPages.flatMap((page) => auditOf(page.id).groups.P0.map(() => page.id));
  const detectP1 = measuredPages.reduce((sum, page) => sum + auditOf(page.id).groups.P1.length, 0);
  const totalP0 = measuredPages.reduce((sum, page) => sum + auditOf(page.id).p0, 0);
  const totalP1 = measuredPages.reduce((sum, page) => sum + auditOf(page.id).p1, 0);
  const pass = acceptance.filter((a) => a.result === '通過').length;
  const fail = acceptance.filter((a) => a.result === '不通過').length;
  const blind = acceptance.filter((a) => a.result === '畫面看不到').length;
  out('## 重點');
  out();
  out(`- 平均分數（滿分 4）：${names}。24 分滿分的平均合計是 ${(CRITERIA.reduce((sum, _n, i) => sum + Number(avgOf(i)), 0)).toFixed(1)}。視覺與一致最低，導覽最高。`);
  out(`- P0 共 ${totalP0} 個（${detectP0.join('、') || '無'}），是 impeccable 抓到的 hydration 錯誤。P1 共 ${totalP1} 個：detect ${detectP1} 個，人工複查 ${manualP1.length} 個。`);
  out(`- 人工複查的 P1 主要是：合約詳情沒有返回列表的路徑、表格在 1440 寬被截掉操作欄、平台營運者的側欄出現屋主功能。`);
  out(`- 全站 inline style ${stats.allUiSources.inlineStyle} 處、寫死色碼 ${stats.allUiSources.colorCodes} 處、antd 已棄用 API ${stats.allUiSources.antdDeprecated} 處。後台殼層側欄全是深色。`);
  out(`- 五張積欠票的驗收：通過 ${pass} 項，不通過 ${fail} 項，畫面看不到 ${blind} 項。另開 ${issues.length} 張票，見「驗收發現的問題」。`);
  out();
}

out('## 總表');
out();
out(`範圍內 ${PAGES.length} 個頁面（含內部工具頁 1 個）。其中 ${noScreenshot.length} 個沒有截圖：${noScreenshot.map((p) => p.id).join('、') || '無'}（原因見「資料準備與限制」）。`);
out('分數 0 到 4，滿分 24。欄位依序是速度、一致、狀態一眼看懂、導覽、視覺、回饋。P0 與 P1 是 impeccable audit 加人工複查的數量，無障礙與響應式不列入。');
out();
out('| 頁面 | 階段 | 速度 | 一致 | 狀態 | 導覽 | 視覺 | 回饋 | 合計 | P0 | P1 | inline style |');
out('| -- | -- | -- | -- | -- | -- | -- | -- | -- | -- | -- | -- |');
const sums = [0, 0, 0, 0, 0, 0];
let sumP0 = 0;
let sumP1 = 0;
let sumInline = 0;
let counted = 0;
for (const page of PAGES) {
  const s = scores[page.id]?.s;
  const a = auditOf(page.id);
  const st = stats.pages[page.id];
  if (!s) {
    out(`| [${page.id}](#${page.id}) ${page.title} | ${page.phase} | - | - | - | - | - | - | - | - | - | ${st.inlineStyle} |`);
    continue;
  }
  counted += 1;
  s.forEach((v, i) => (sums[i] += v));
  sumP0 += a.p0;
  sumP1 += a.p1;
  sumInline += st.inlineStyle;
  out(`| [${page.id}](#${page.id}) ${page.title} | ${page.phase} | ${s.join(' | ')} | ${s.reduce((x, y) => x + y, 0)} | ${a.p0} | ${a.p1} | ${st.inlineStyle} |`);
}
const avg = sums.map((v) => (counted ? (v / counted).toFixed(1) : '-'));
out(`| **平均（${counted} 頁）** | | ${avg.join(' | ')} | ${(sums.reduce((x, y) => x + y, 0) / Math.max(counted, 1)).toFixed(1)} | 合計 ${sumP0} | 合計 ${sumP1} | 平均 ${(sumInline / Math.max(counted, 1)).toFixed(0)} |`);
out();
out('inline style 欄只算頁面專屬的原始碼，合約詳情的各狀態共用同一份程式碼，所以數字相同，不能加總。殼層與跨頁元件另算：');
out();
out(`| 範圍 | 檔案數 | 行數 | inline style | 寫死色碼 | 寫死 px | antd 已棄用 |`);
out('| -- | -- | -- | -- | -- | -- | -- |');
out(`| 共用殼層與跨頁元件 | ${stats.shared.files} | ${stats.shared.loc} | ${stats.shared.inlineStyle} | ${stats.shared.colorCodes} | ${stats.shared.pxLiterals} | ${stats.shared.antdDeprecated} |`);
out(`| src/app 與 src/components 全部 | ${stats.allUiSources.files} | ${stats.allUiSources.loc} | ${stats.allUiSources.inlineStyle} | ${stats.allUiSources.colorCodes} | ${stats.allUiSources.pxLiterals} | ${stats.allUiSources.antdDeprecated} |`);
out();

out('## 怎麼量的');
out();
out('### 截圖');
out();
out('- `e2e/baseline/baseline.baseline.ts` 用 Playwright 開頁面，整頁截圖（寬 1440）。資料全部經應用程式自己的 API 建立，每次都是全新的資料庫。');
out('- 平台營運者沒有自助註冊，外殼 `scripts/e2e/run-e2e.sh baseline` 替 dev server 設定 `PLATFORM_OPERATOR_EMAILS`。');
out('- 合約編號與時間戳在截圖前換成固定樣本，與 `e2e/visual/` 的做法相同。');
out();
out('### 評分（0 到 4）');
out();
out('評分依 MIL-167 的檢核表，每項一句理由。分數由截圖、頁面量測與原始碼三種證據決定：');
out();
out('| 項目 | 怎麼給分 |');
out('| -- | -- |');
out('| 速度 | 依第二次載入的量測。4：載入中有骨架畫面，且 2.5 秒內穩定。3：沒有轉圈，2.5 秒內穩定。2：局部轉圈且 5 秒內穩定，或沒有轉圈但超過 2.5 秒。1：整頁轉圈，或局部轉圈超過 5 秒。0：25 秒內沒有穩定 |');
out('| 一致 | 評分者比較同類頁面（列表、詳情、精靈、面板）。2：與同類頁面大致相同，細節不同。1：與同類頁面不同。現況沒有共用版型，所以沒有 3 以上 |');
out('| 狀態一眼看懂 | 評分者看截圖。4：同一狀態全站同色同名，詳情頂端寫出下一步與負責人。3：有狀態標籤與下一步，但顏色或名稱與別頁不共用。2：有標籤，沒寫下一步。1：沒有狀態呈現（含只有空狀態的頁面） |');
out('| 導覽 | 側欄（屋主端是頂部選單）標出目前位置給 2 分。詳情頁有返回列表的連結給 2 分，非詳情頁這 2 分直接給。單頁流程（登入、onboarding）給 3 分 |');
out('| 視覺 | 從 4 分扣：後台殼層側欄是深色扣 1；inline style 1 到 9 處扣 1，10 到 29 處扣 2，30 處以上扣 3；寫死色碼 10 處以上扣 1；截圖上看得到版面缺陷扣 1。最低 0 |');
out('| 回饋 | 評分者看原始碼的回饋呼叫（message、Modal.confirm、Alert）與驗收時看到的訊息。3：操作有成功與失敗回饋，錯誤沒寫下一步。1：唯讀頁沒有載入失敗畫面。沒有頁面達到 4 |');
out();
out('沒有操作的唯讀頁，「回饋」看載入失敗與空狀態有沒有處理。現況沒有任何共用版型，所以「一致」沒有頁面達到 4 分。');
out();
out('### impeccable audit');
out();
out('- 做法：渲染後掃描。測試自己啟動 Chromium 並開 CDP port，每頁截完圖後執行 `impeccable detect --cdp <port> --target <路徑> --json`（impeccable 0.1.18，`--no-config`）。不是掃原始碼。');
out('- detect 沒有 P0 到 P3 分級，對應方式依 `audit.md` 的定義：severity 為 error 的規則算 P0；quality 類的 warning 算 P1；slop 與 advisory 類只列在明細，不算 P0 與 P1。');
out('- 排除無障礙與響應式類規則：`low-contrast`、`tiny-text`、`undersized-ui-text`、`skipped-heading`、`body-text-viewport-edge`、`line-length`。這些規則的命中仍保留在原始 JSON。');
out('- 人工複查：detect 抓不到的問題（操作欄被截掉、頁面沒有返回路徑等），由評分者看截圖後補記，標明「人工」。');
out('- 原始 JSON 在 `data/results.json`，每頁的 `audit.findings`。');
out();
out('### 靜態統計');
out();
out('`node e2e/baseline/static-stats.mjs` 掃每頁專屬原始碼（頁面檔加專屬元件，清單在 `e2e/baseline/pages.ts`）。');
out('inline style 數 `style={` 的出現次數。寫死色碼數 `#rgb`、`#rrggbb` 與 `rgb()`、`rgba()`，已排除註解。寫死 px 數字串裡的 `NNpx`。antd 已棄用數 `antd lint --only deprecated`。');
out('全站 inline style 是 ' + stats.allUiSources.inlineStyle + ' 處，MIL-167 寫的是 293 處，差異來自 MIL-167 之後併入的頁面。');
out();

out('## 各頁明細');
out();
for (const page of PAGES) {
  const r = byId.get(page.id);
  const sc = scores[page.id];
  const st = stats.pages[page.id];
  const a = auditOf(page.id);
  out(`### ${page.id}`);
  out();
  out(`${page.title}。角色：${page.role}。路由：\`${page.route}\`。版型分類：${page.layout}。`);
  out();
  if (r?.screenshot) out(`![${page.title}](${r.screenshot})`);
  else out(`沒有截圖。${sc?.note ?? r?.error ?? ''}`);
  out();
  if (sc?.s) {
    out('| 項目 | 分數 | 理由 |');
    out('| -- | -- | -- |');
    CRITERIA.forEach((name, i) => out(`| ${name} | ${sc.s[i]} | ${sc.r[i]} |`));
    out();
  } else if (sc?.note) {
    out(sc.note);
    out();
  }
  const load = r?.load;
  if (load) {
    out(`載入量測（第二次載入，dev server）：穩定 ${load.msToStable ?? '未穩定'} ms；轉圈取樣 ${load.spinnerSamples}/${load.samples}；骨架畫面 ${load.skeletonSeen ? '有' : '無'}；整頁轉圈 ${load.fullPageSpinnerSeen ? '有' : '無'}。`);
    out();
  }
  out(`靜態統計：${st.files} 個檔案、${st.loc} 行；inline style ${st.inlineStyle}；寫死色碼 ${st.colorCodes}；寫死 px ${st.pxLiterals}；antd 已棄用 ${st.antdDeprecated}。`);
  out();
  const listFindings = (title, list) => {
    if (list.length === 0) return;
    out(`- ${title}：${ruleSummary(list)}`);
    const seen = new Set();
    for (const f of list) {
      const key = `${f.antipattern}|${f.selector}|${f.snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 4) break;
      out(`  - \`${f.selector ?? ''}\`：${String(f.snippet ?? '').slice(0, 140)}`);
    }
  };
  out(`audit：P0 ${a.p0}、P1 ${a.p1}；其他（slop 與 advisory）${a.groups.other.length}；已排除（無障礙與響應式）${a.groups.excluded.length}。`);
  out();
  if (r?.audit?.error) out(`- audit 失敗：${r.audit.error}`);
  listFindings('P0（detect）', a.groups.P0);
  listFindings('P1（detect）', a.groups.P1);
  for (const m of [...a.manualP0, ...a.manualP1]) out(`- ${m.p}（人工）：${m.text}`);
  listFindings('其他', a.groups.other);
  out();
}

out('## 積欠的畫面驗收');
out();
out('每張票的驗收留言在 Linear，截圖在本目錄（`acc-*.png`）。結果分三種：通過、不通過、畫面看不到。「畫面看不到」指驗收條件不經過畫面（稽核事件、資料刪除、權限、純函式），這張票沒有驗收，靠單元測試與資料庫測試涵蓋。');
out();
const tickets = [...new Set(acceptance.map((a) => a.ticket))];
for (const ticket of tickets) {
  out(`### ${ticket}`);
  out();
  out('| 驗收項目 | 結果 | 說明 |');
  out('| -- | -- | -- |');
  for (const a of acceptance.filter((x) => x.ticket === ticket)) {
    out(`| ${a.item} | ${a.result} | ${a.note}${a.evidence ? `（[截圖](${a.evidence})）` : ''} |`);
  }
  out();
}

out('## 驗收發現的問題');
out();
if (issues.length === 0) out('尚未登記。');
for (const issue of issues) out(`- [${issue.id}](${issue.url})：${issue.title}`);
out();

out('## 資料準備與限制');
out();
out('資料準備的每一步獨立記錄。失敗的步驟：');
out();
const failed = results.steps.filter((s) => !s.ok);
if (failed.length === 0) out('- 無');
for (const s of failed) out(`- ${s.step}：${(s.detail ?? '').split('\n')[0]}`);
out();
for (const line of scores.limitations ?? []) out(`- ${line}`);
out();

out('## 重跑');
out();
out('```bash');
out('HEAVY_COST=6 scripts/heavy.sh e2e-baseline scripts/e2e/run-e2e.sh baseline');
out('node e2e/baseline/static-stats.mjs');
out('node e2e/baseline/build-report.mjs');
out('git checkout tsconfig.json');
out('```');
out();
out('第一行約 8 分鐘，成本 6 GB。結束時最後一行是 `LISTEN 3410: 0`。評分與人工複查寫在 `data/scores.json`，重跑後要對照新截圖更新。');
out();

writeFileSync(path.join(DIR, 'README.md'), lines.join('\n'));
console.log(`README.md：${lines.length} 行；有評分的頁面 ${measuredPages.length}`);
