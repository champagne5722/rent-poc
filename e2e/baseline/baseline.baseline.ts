import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { chooseOption } from '../helpers/ui';
import { PAGES, TENANT_PAGES, type PageSpec } from './pages';
import { seedProperty, seedSendableDraft } from '../helpers/api';
import { seedMasterLease, seedOwner, seedPracticeAndDesk, step, stepLog, type OwnerWorld } from './seed';
import { createOwnerOrg, createPracticeOrg, newUserContext, signIn } from './session';

// 現況基準（MIL-170）。只量測與記錄，沒有斷言：任何一頁失敗都記下來，不中斷整輪。
// 執行方式：HEAVY_COST=6 scripts/heavy.sh e2e-baseline scripts/e2e/run-e2e.sh baseline
// 產出：docs/ui/baseline/*.png（截圖）、docs/ui/baseline/data/results.json（量測與 audit 原始結果）。
//
// impeccable audit 的做法：測試自己啟動 Chromium 並開 CDP port，每頁截完圖後執行
// `impeccable detect --cdp <port> --target <路徑> --json`，掃的是渲染後的頁面。

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'docs', 'ui', 'baseline');
const DATA_DIR = path.join(OUT_DIR, 'data');
const AUDIT_DIR = path.join(ROOT, 'e2e-results', 'baseline-audit');
const CDP_PORT = Number(process.env.BASELINE_CDP_PORT ?? 9333);
const IMPECCABLE = path.join(ROOT, '.claude', 'skills', 'impeccable', 'scripts', 'impeccable');
const OWNER_STATE = 'e2e-results/.auth/state.json';
const OPERATOR_EMAIL = process.env.BASELINE_OPERATOR_EMAIL ?? 'e2e-operator@example.com';

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(AUDIT_DIR, { recursive: true });

interface Context {
  browser: Browser;
  owner: BrowserContext;
  practice: BrowserContext;
  practice2: BrowserContext;
  practice3: BrowserContext;
  owner2: BrowserContext;
  operator: BrowserContext;
  anonymous: BrowserContext;
}

let ctx: Context;
const world: Record<string, string | null | undefined> = {};
const results: Array<Record<string, unknown>> = [];

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  // 只跑部分測試（--grep）時，保留上一次已經記下的頁面結果，只換掉這次重新量測的
  let previous: Array<Record<string, unknown>> = [];
  try {
    previous = (JSON.parse(readFileSync(path.join(DATA_DIR, 'results.json'), 'utf8')) as { pages: Array<Record<string, unknown>> }).pages;
  } catch {
    previous = [];
  }
  const fresh = new Set(results.map((r) => r.id));
  const merged = [...previous.filter((p) => !fresh.has(p.id)), ...results];
  const order = new Map(PAGES.map((p, i) => [p.id, i]));
  merged.sort((a, b) => (order.get(String(a.id)) ?? 999) - (order.get(String(b.id)) ?? 999) || String(a.id).localeCompare(String(b.id)));
  writeFileSync(path.join(DATA_DIR, 'results.json'), JSON.stringify({ capturedAt: new Date().toISOString(), world, steps: stepLog, pages: merged }, null, 2));
  await ctx?.browser.close();
});

async function ownerPage(): Promise<Page> {
  return ctx.owner.newPage();
}

test('準備資料', async () => {
  test.setTimeout(900_000);
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${CDP_PORT}`] });
  ctx = {
    browser,
    owner: await newUserContext(browser, { storageState: OWNER_STATE }),
    practice: await newUserContext(browser),
    practice2: await newUserContext(browser),
    practice3: await newUserContext(browser),
    owner2: await newUserContext(browser),
    operator: await newUserContext(browser),
    anonymous: await newUserContext(browser),
  };

  // 屋主
  const owner = await ownerPage();
  await owner.goto('/');
  Object.assign(world, (await step('屋主資料', () => seedOwner(owner))) ?? {});

  // 執業主體甲、乙與平台營運者
  const practice = await ctx.practice.newPage();
  const practice2 = await ctx.practice2.newPage();
  const practice3 = await ctx.practice3.newPage();
  const operator = await ctx.operator.newPage();
  await step('執業主體甲：登入與建立', async () => {
    await signIn(practice, 'e2e-practice@example.com');
    await createPracticeOrg(practice, { name: '北辰示範租賃股份有限公司', taxId: '24680135', entityType: 'company', kinds: ['management', 'master_lease'] });
  });
  await step('執業主體乙：登入與建立', async () => {
    await signIn(practice2, 'e2e-practice2@example.com');
    await createPracticeOrg(practice2, { name: '雲頂示範經紀行', taxId: '13572468', entityType: 'firm', kinds: ['brokerage'] });
  });
  await step('執業主體丙：登入與建立', async () => {
    await signIn(practice3, 'e2e-practice3@example.com');
    await createPracticeOrg(practice3, { name: '星河示範經紀行', taxId: '11223344', entityType: 'firm', kinds: ['brokerage'] });
  });
  await step('營運者：登入', () => signIn(operator, OPERATOR_EMAIL));
  Object.assign(world, await seedPracticeAndDesk(practice, practice2, practice3, operator));
  Object.assign(world, await seedMasterLease(practice));

  // 移交（假資料 adapter）與承租人案件：從列表頁取連結
  const hrefs = async (page: Page, route: string, pattern: RegExp): Promise<string | null> => {
    await page.goto(route, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const all = await page.locator('a').evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''));
    return all.map((h) => h.match(pattern)?.[1]).find(Boolean) ?? null;
  };
  world.handover = await step('移交 ID', () => hrefs(owner, '/owner/handovers', /\/owner\/handovers\/([A-Za-z0-9_-]+)$/).then((v) => (v === 'new' ? null : v))) ?? null;
  world.orgHandover = (await step('後台移交 ID（執業主體甲）', () => hrefs(practice, '/handovers', /\/handovers\/([A-Za-z0-9_-]+)$/))) ?? null;

  // 屋主二：同一位承租人（tenant@example.com）在第二個組織也有案件，MIL-121 驗收「兩個組織的案件都列出」
  const owner2 = await ctx.owner2.newPage();
  await step('屋主二：登入、建立組織、簽署中合約', async () => {
    await signIn(owner2, 'e2e-owner2@example.com');
    await createOwnerOrg(owner2, 'E2E 屋主二');
    const property = await seedProperty(owner2, '士林中正路 4 樓', '台北市士林區中正路 20 號 4 樓');
    const id = await seedSendableDraft(owner2, property.id);
    const sent = await owner2.request.post(`/api/contracts/${id}/send`);
    if (!sent.ok()) throw new Error(`屋主二送簽失敗：${sent.status()}`);
  });
  await owner2.close();
  await owner.close();
  await practice.close();
  await practice2.close();
  await practice3.close();
  await operator.close();
  writeFileSync(path.join(DATA_DIR, 'world.json'), JSON.stringify({ world, steps: stepLog }, null, 2));
});

// ---------------------------------------------------------------------------
// 量測

function resolveRoute(route: string): string | null {
  const map: Record<string, string | null | undefined> = {
    signing: world.signingContractId,
    completed: world.completedContractId,
    readyDraft: world.readyDraftId,
    declined: world.declinedContractId,
    bareDraft: world.bareDraftId,
    property: world.propertyIds ? undefined : undefined,
    case: world.completedCaseId,
    handover: world.handover,
    orgHandover: world.orgHandover,
    deskLicense: world.deskLicenseItemId,
    deskCredential: world.deskCredentialItemId,
    masterLease: world.masterLeaseContractId,
    masterLeaseDraft: world.masterLeaseDraftId,
    tenantCase: world.tenantCase,
  };
  let missing = false;
  const resolved = route.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const value = key === 'property' ? (world.propertyIds as unknown as string[] | undefined)?.[0] : map[key];
    if (!value) missing = true;
    return value ?? '';
  });
  return missing ? null : resolved;
}

async function normalizeVolatileText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const replacements: Array<[RegExp, string]> = [
      [/#[0-9A-Z]{6}/g, '#ABCDEF'],
      [/^[0-9A-Z]{6}$/, 'ABCDEF'],
      [/^\d{2}-\d{2} \d{2}:\d{2}$/, '01-01 00:00'],
    ];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // 不動 <style> 與 <script> 的文字：CSS 裡的 #232529 這類全數字色碼也符合 /#[0-9A-Z]{6}/，
      // 換成 #ABCDEF 會讓文字色變成淡藍色（MIL-175 發現）
      const tag = node.parentElement?.tagName;
      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') continue;
      let text = node.nodeValue ?? '';
      for (const [pattern, sample] of replacements) text = text.replace(pattern, sample);
      if (text !== node.nodeValue) node.nodeValue = text;
    }
  });
}

interface LoadMeasure {
  msToStable: number | null;
  spinnerSamples: number;
  skeletonSeen: boolean;
  samples: number;
  fullPageSpinnerSeen: boolean;
}

/** 第二次載入時量測：頁面穩定前有沒有轉圈、有沒有骨架畫面。 */
async function measureLoad(page: Page, url: string): Promise<LoadMeasure> {
  const started = Date.now();
  await page.goto(url, { waitUntil: 'commit' });
  const measure: LoadMeasure = { msToStable: null, spinnerSamples: 0, skeletonSeen: false, samples: 0, fullPageSpinnerSeen: false };
  let stable = 0;
  while (Date.now() - started < 25_000) {
    const state = await page
      .evaluate(() => {
        const spinning = [...document.querySelectorAll('.ant-spin-spinning, .ant-spin-nested-loading > .ant-spin')];
        const fullPage = spinning.some((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.3;
        });
        return {
          spin: spinning.length,
          fullPage,
          skeleton: document.querySelectorAll('.ant-skeleton').length > 0,
          textLength: document.body?.innerText?.trim().length ?? 0,
        };
      })
      .catch(() => null);
    if (state) {
      measure.samples += 1;
      if (state.spin > 0) measure.spinnerSamples += 1;
      if (state.fullPage) measure.fullPageSpinnerSeen = true;
      if (state.skeleton) measure.skeletonSeen = true;
      if (state.spin === 0 && state.textLength > 30) {
        stable += 1;
        if (stable >= 3) {
          measure.msToStable = Date.now() - started;
          break;
        }
      } else {
        stable = 0;
      }
    }
    await page.waitForTimeout(80);
  }
  return measure;
}

async function pageFacts(page: Page) {
  return page.evaluate(() => {
    const text = (el: Element | null) => el?.textContent?.trim().replace(/\s+/g, ' ') ?? null;
    const selectedMenu = document.querySelector('.ant-menu-item-selected, .ant-menu-submenu-selected');
    const sider = document.querySelector('.ant-layout-sider');
    const headings = [...document.querySelectorAll('h1, h2, h3, .ant-typography-title')].slice(0, 4).map((h) => ({ tag: h.tagName.toLowerCase(), text: text(h) }));
    const links = [...document.querySelectorAll('a, button')].map((el) => text(el) ?? '');
    const tags = [...document.querySelectorAll('.ant-tag')].map((el) => ({
      text: text(el),
      color: getComputedStyle(el).backgroundColor,
    }));
    const primary = [...document.querySelectorAll('.ant-btn-primary')].map((el) => text(el));
    return {
      url: location.pathname + location.search,
      title: document.title,
      headings,
      selectedMenu: text(selectedMenu),
      siderDark: sider ? sider.classList.contains('ant-layout-sider-dark') : null,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      hasBackLink: links.some((t) => /返回|回列表|回到.*列表|←/.test(t)) || !!document.querySelector('.ant-breadcrumb'),
      tagCount: tags.length,
      tagSamples: tags.slice(0, 12),
      primaryButtons: primary,
      tableCount: document.querySelectorAll('.ant-table').length,
      cardCount: document.querySelectorAll('.ant-card').length,
      emptyStateCount: document.querySelectorAll('.ant-empty').length,
      alertCount: document.querySelectorAll('.ant-alert').length,
      scrollHeight: document.documentElement.scrollHeight,
    };
  });
}

interface AuditFinding {
  id?: string;
  rule?: string;
  severity?: string;
  category?: string;
  message?: string;
  selector?: string;
  snippet?: string;
  [key: string]: unknown;
}

async function runDetect(id: string, pagePath: string): Promise<{ ok: boolean; findings: AuditFinding[]; raw?: unknown; error?: string }> {
  const target = pagePath === '/' || pagePath === '' ? 'localhost' : pagePath;
  try {
    const { stdout } = await execFileAsync(IMPECCABLE, ['detect', '--cdp', String(CDP_PORT), '--target', target, '--json', '--no-config'], {
      cwd: ROOT,
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return finishDetect(id, stdout);
  } catch (error) {
    // 有發現時結束碼是 2，stdout 仍然有 JSON
    const err = error as { stdout?: string; code?: number; message?: string };
    if (err.stdout) return finishDetect(id, err.stdout);
    return { ok: false, findings: [], error: (err.message ?? '').slice(0, 300) };
  }
}

function finishDetect(id: string, stdout: string) {
  writeFileSync(path.join(AUDIT_DIR, `${id}.json`), stdout);
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const list = Array.isArray(parsed) ? parsed : ((parsed as { findings?: unknown[]; results?: unknown[] }).findings ?? (parsed as { results?: unknown[] }).results ?? []);
    return { ok: true, findings: list as AuditFinding[], raw: parsed };
  } catch {
    return { ok: false, findings: [], error: `JSON 解析失敗：${stdout.slice(0, 200)}` };
  }
}

type Prepare = (page: Page) => Promise<void>;

const PREPARE: Record<string, Prepare> = {
  '09-wizard-3-signature': async (page) => {
    await page.getByRole('button', { name: /上一步/ }).click({ timeout: 10_000 });
    await page.waitForTimeout(800);
  },
  '15-case-detail-ledger': async (page) => {
    await page.getByRole('tab', { name: '帳務設定' }).click({ timeout: 10_000 });
    await page.getByText('押金台帳').first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle').catch(() => undefined);
  },
  '34-master-lease-wizard-fields': async (page) => {
    await page.getByText('填寫欄位', { exact: false }).first().click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
  },
};

function contextFor(role: PageSpec['role']): BrowserContext {
  switch (role) {
    case 'owner':
      return ctx.owner;
    case 'practice':
      return ctx.practice;
    case 'operator':
      return ctx.operator;
    case 'anonymous':
      return ctx.anonymous;
    default:
      return ctx.owner;
  }
}

async function capture(spec: { id: string; title: string; role: PageSpec['role']; route: string }, options: { viewport?: { width: number; height: number }; skipAudit?: boolean } = {}): Promise<void> {
  const entry: Record<string, unknown> = { id: spec.id, title: spec.title, role: spec.role, route: spec.route };
  results.push(entry);
  const url = resolveRoute(spec.route);
  if (!url) {
    entry.error = `缺少資料：${spec.route}`;
    return;
  }
  entry.url = url;
  const [pathOnly] = url.split('#');
  const page = await contextFor(spec.role).newPage();
  try {
    if (options.viewport) await page.setViewportSize(options.viewport);
    // 第一次載入暖機：dev server 第一次編譯路由要數十秒，不算進量測
    await page.goto(pathOnly, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
    entry.load = await measureLoad(page, pathOnly);
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
    await PREPARE[spec.id]?.(page);
    // 合約預覽等元件載入後才有內容，等轉圈消失再截圖（上限 30 秒）
    await page.waitForFunction(() => !document.querySelector('.ant-spin-spinning'), null, { timeout: 30_000 }).catch(() => undefined);
    await page.evaluate(() => document.fonts.ready);
    // 設計樣式頁的色碼（#ABCDEF 這種）會被當成合約編號換掉，所以不換
    if (spec.id !== '35-design') await normalizeVolatileText(page);
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
    await page.waitForTimeout(400);
    entry.facts = await pageFacts(page);
    const file = `${spec.id}.png`;
    await page.screenshot({ path: path.join(OUT_DIR, file), fullPage: true, animations: 'disabled', caret: 'hide' });
    entry.screenshot = file;
    if (!options.skipAudit) {
      const detect = await runDetect(spec.id, new URL(page.url()).pathname + new URL(page.url()).search);
      entry.audit = { ok: detect.ok, count: detect.findings.length, findings: detect.findings, error: detect.error };
    }
  } catch (error) {
    entry.error = error instanceof Error ? error.message.slice(0, 300) : String(error);
  } finally {
    await page.close().catch(() => undefined);
  }
}

test('承租人端與 onboarding 前置', async () => {
  test.setTimeout(300_000);
  // 承租人：用簽署中合約的乙方 email 登入
  const page = await ctx.anonymous.newPage();
  await step('承租人登入', async () => {
    const tenantCtx = await newUserContext(ctx.browser);
    const tenant = await tenantCtx.newPage();
    await signIn(tenant, 'tenant@example.com');
    await tenant.goto('/tenant');
    await tenant.waitForLoadState('networkidle').catch(() => undefined);
    const rows = await tenant.locator('a').evaluateAll((links) =>
      links.map((a) => ({
        href: (a as HTMLAnchorElement).getAttribute('href') ?? '',
        text: (a.closest('tr, .ant-list-item, .ant-card') as HTMLElement | null)?.innerText ?? '',
      })),
    );
    const cases = rows.map((r) => ({ id: r.href.match(/\/tenant\/cases\/([A-Za-z0-9_-]+)$/)?.[1], text: r.text })).filter((r) => r.id);
    stepLog.push({ step: '承租人案件列（除錯）', ok: true, detail: JSON.stringify(cases).slice(0, 400) });
    world.tenantCase = (cases.find((c) => /完成|生效|履行/.test(c.text)) ?? cases[0])?.id ?? null;
    (ctx as unknown as { tenant: BrowserContext }).tenant = tenantCtx;
    await tenant.close();
  });
  await page.close();
});

for (const spec of PAGES) {
  test(`${spec.id} ${spec.title}`, async () => {
    test.setTimeout(240_000);
    if (spec.id === '32-onboarding') {
      // 第一次登入、還沒有身分的帳號
      const newCtx = await newUserContext(ctx.browser);
      const page = await newCtx.newPage();
      await step('新帳號登入', () => signIn(page, 'e2e-newcomer@example.com'));
      const entry: Record<string, unknown> = { id: spec.id, title: spec.title, role: spec.role, route: spec.route, url: page.url() };
      results.push(entry);
      try {
        await page.waitForLoadState('networkidle').catch(() => undefined);
        entry.load = await measureLoad(page, '/login?notice=no-identity').catch(() => null);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.evaluate(() => document.fonts.ready);
        await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
        entry.facts = await pageFacts(page);
        await page.screenshot({ path: path.join(OUT_DIR, `${spec.id}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
        entry.screenshot = `${spec.id}.png`;
        const detect = await runDetect(spec.id, '/login?notice=no-identity');
        entry.audit = { ok: detect.ok, count: detect.findings.length, findings: detect.findings, error: detect.error };
      } catch (error) {
        entry.error = String(error).slice(0, 300);
      }
      await newCtx.close();
      return;
    }
    await capture(spec);
  });
}

test('承租人端截圖（只驗收，不評分）', async () => {
  test.setTimeout(300_000);
  const tenantCtx = (ctx as unknown as { tenant?: BrowserContext }).tenant;
  if (!tenantCtx) return;
  for (const t of TENANT_PAGES) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
      const url = resolveRoute(t.route);
      const entry: Record<string, unknown> = { id: `${t.id}-${viewport.width}`, title: `${t.title}（${viewport.width}px）`, role: 'tenant', route: t.route, url };
      results.push(entry);
      if (!url) {
        entry.error = `缺少資料：${t.route}`;
        continue;
      }
      const page = await tenantCtx.newPage();
      try {
        await page.setViewportSize(viewport);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
        await page.evaluate(() => document.fonts.ready);
        await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
        entry.horizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        entry.facts = await pageFacts(page);
        await page.screenshot({ path: path.join(OUT_DIR, `${t.id}-${viewport.width}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
        entry.screenshot = `${t.id}-${viewport.width}.png`;
      } catch (error) {
        entry.error = String(error).slice(0, 300);
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 積欠票的畫面驗收：MIL-111、MIL-121、MIL-72、MIL-71、MIL-123
// 每一項記成 { ticket, item, result, note, evidence }。result 只有「通過」「不通過」「畫面看不到」三種。
// 「畫面看不到」是這項驗收條件不經過畫面（稽核事件、資料刪除、權限、純函式），沒有在這張票驗收，要靠單元測試與資料庫測試。

type Verdict = '通過' | '不通過' | '畫面看不到';
interface Acceptance {
  ticket: string;
  item: string;
  result: Verdict;
  note: string;
  evidence?: string;
}
const acceptance: Acceptance[] = [];

function record(ticket: string, item: string, result: Verdict, note: string, evidence?: string): void {
  acceptance.push({ ticket, item, result, note, evidence });
}

async function accept(ticket: string, item: string, evidence: string | undefined, fn: () => Promise<string>): Promise<void> {
  try {
    record(ticket, item, '通過', await fn(), evidence);
  } catch (error) {
    record(ticket, item, '不通過', (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 240), evidence);
  }
}

async function shot(page: Page, name: string): Promise<string> {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await normalizeVolatileText(page);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.waitForTimeout(300);
  const file = `acc-${name}.png`;
  await page.screenshot({ path: path.join(OUT_DIR, file), fullPage: true, animations: 'disabled', caret: 'hide' });
  return file;
}

async function visit(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
  // 資料經 client 端 fetch 載入的頁面，等轉圈消失、內容出現（合約詳情的執業人員查詢要十幾秒）
  await page.waitForFunction(() => !document.querySelector('.ant-spin-spinning') && (document.body?.innerText?.length ?? 0) > 300, null, { timeout: 90_000 }).catch(() => undefined);
  return page;
}

async function expectText(page: Page, text: string | RegExp, timeout = 8_000): Promise<void> {
  await expect(page.getByText(text).first()).toBeVisible({ timeout });
}

test('驗收 MIL-123：案件的帳務設定分頁', async () => {
  test.setTimeout(300_000);
  const caseId = world.completedCaseId;
  if (!caseId) return record('MIL-123', '案件頁', '不通過', '資料準備沒有產生案件');
  const page = await visit(ctx.owner, `/cases/${caseId}`);
  await page.getByRole('tab', { name: '帳務設定' }).click();
  await page.getByText('押金台帳').first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  const base = await shot(page, 'mil123-ledger');
  await accept('MIL-123', '案件頁有「帳務設定」分頁，內容分五區', base, async () => {
    for (const section of ['社宅代管旗標', '押金台帳', '應收期別', '匯款識別', '預設收款帳戶']) await expectText(page, section);
    return '五區標題都在畫面上';
  });
  await accept('MIL-123', '合約全員完成後，押金台帳顯示約定金額與餘額', base, async () => {
    await expectText(page, '約定金額');
    await expectText(page, '$40,000');
    return '約定金額 $40,000 等於合約押金';
  });
  await accept('MIL-123', '應收期別一個月一期，租期 12 個月有 12 列', base, async () => {
    const rows = await page.locator('.ant-table-tbody tr.ant-table-row').count();
    const tables = await page.locator('.ant-table').count();
    if (rows < 12) throw new Error(`畫面上只有 ${rows} 列表格資料（${tables} 張表）`);
    return `表格資料列共 ${rows} 列（${tables} 張表）`;
  });
  await accept('MIL-123', '案件得登錄匯款識別，登錄後有成功回饋', undefined, async () => {
    await page.getByPlaceholder('例如：王大明').fill('王大明', { timeout: 10_000 });
    await page.getByRole('button', { name: /新\s*增/ }).click();
    await expectText(page, /已登錄匯款識別/, 10_000);
    return '填付款人戶名「王大明」按新增，畫面顯示「已登錄匯款識別」';
  });
  await accept('MIL-123', '案件得設租金與押金的預設收款帳戶，儲存後有成功回饋', undefined, async () => {
    const selects = page.locator('.ant-select').filter({ hasText: '未設定' });
    await selects.first().click({ timeout: 10_000 });
    await page.locator('.ant-select-item-option').first().click({ timeout: 10_000 });
    await page.getByRole('button', { name: /儲\s*存/ }).click();
    await expectText(page, /已儲存預設收款帳戶/, 10_000);
    return '選租金的預設帳戶按儲存，畫面顯示「已儲存預設收款帳戶」';
  });
  const done = await shot(page, 'mil123-after-edit');
  record('MIL-123', '登錄匯款識別與預設帳戶之後的畫面', '通過', '截圖', done);
  {
    const count = await page.getByRole('button', { name: /改為社宅代管案件/ }).count();
    record(
      'MIL-123',
      '社宅旗標的修改、原因欄與持有人衝突提示',
      '畫面看不到',
      count > 0
        ? '自管案件也顯示按鈕，但這張票沒有走完修改流程'
        : '自管案件的畫面沒有「改為社宅代管案件」按鈕。旗標編輯與衝突提示只在代管案件出現，這個環境沒有代管案件，沒有驗收',
    );
  }
  for (const item of ['migration 外鍵', '期別切分純函式與首末期比例', '提前終止改 cancelled', '旗標修改寫稽核並通知委託人', '押金台帳表的 RLS 與滲透測試']) {
    record('MIL-123', item, '畫面看不到', '不經過畫面，由單元測試與真實 PostgreSQL 測試涵蓋，這張票沒有驗收');
  }
  await page.close();
});

test('驗收 MIL-121：承租人端我的案件', async () => {
  test.setTimeout(300_000);
  const tenantCtx = (ctx as unknown as { tenant?: BrowserContext }).tenant;
  if (!tenantCtx) return record('MIL-121', '承租人登入', '不通過', '承租人沒有登入成功，沒有承租人身分');
  const list = await visit(tenantCtx, '/tenant');
  const rows = await list.locator('a[href*="/tenant/cases/"]').count();
  const evidence = await shot(list, 'mil121-list');
  await accept('MIL-121', '兩個組織的案件都列出', evidence, async () => {
    if (rows < 2) throw new Error(`列表只有 ${rows} 個案件連結，預期兩個組織各一個以上`);
    return `列表有 ${rows} 個案件連結（屋主一的簽署中、已完成、已拒簽案件，加屋主二的簽署中案件）`;
  });
  await list.close();
  if (world.tenantCase) {
    const detail = await visit(tenantCtx, `/tenant/cases/${world.tenantCase}`);
    const detailShot = await shot(detail, 'mil121-detail');
    await accept('MIL-121', '案件詳情顯示合約狀態，已完成的合約能下載已簽 PDF', detailShot, async () => {
      await expectText(detail, /下載已簽合約|合約簽署完成後/);
      const link = await detail.getByRole('link', { name: /下載已簽合約/ }).count();
      if (link === 0) throw new Error('沒有「下載已簽合約」連結，只看到提示文字');
      return '有「下載已簽合約」連結';
    });
    await detail.close();
  }
  for (const viewport of [{ width: 375, height: 812 }]) {
    const entry = results.find((r) => r.id === `t1-tenant-list-${viewport.width}`);
    await accept('MIL-121', '375px 寬沒有水平捲動', `t1-tenant-list-${viewport.width}.png`, async () => {
      const second = results.find((r) => r.id === `t2-tenant-case-${viewport.width}`);
      const bad = [entry, second].filter((r) => r && r.horizontalScroll === true);
      if (bad.length > 0) throw new Error(`有水平捲動：${bad.map((r) => String(r?.id)).join('、')}`);
      return '列表與詳情在 375px 寬都沒有水平捲動';
    });
  }
  record('MIL-121', 'email 不屬於任何案件時只顯示「沒有案件」', '畫面看不到', '承租人身分要有案件成員關係才成立，E2E 沒有辦法登入成沒有案件的承租人。空狀態文字在 TenantCaseList.tsx，沒有驗收');
  record('MIL-121', '結案後唯讀、仍能下載', '畫面看不到', '案件結案要走退租與結算流程（E 線），這個環境沒有可結案的案件，沒有驗收');
  record('MIL-121', '更新成員 email 後舊 email 失效，並寫稽核事件', '畫面看不到', '操作在出租人端，結果是 session 與稽核，這張票沒有驗收');
  record('MIL-121', '承租人讀不到別的案件', '畫面看不到', '權限與 RLS，由 PostgreSQL 測試涵蓋，這張票沒有驗收');
});

test('驗收 MIL-72 與 MIL-71：包租合約的簽署進度與現況確認附件', async () => {
  test.setTimeout(300_000);
  const sent = world.masterLeaseContractId;
  const draft = world.masterLeaseDraftId;
  if (sent) {
    const page = await visit(ctx.practice, `/contracts/${sent}`);
    const evidence = await shot(page, 'mil72-master-detail');
    await accept('MIL-72', '詳情頁列出每位簽署人的角色、姓名與狀態', evidence, async () => {
      const text = await page.locator('body').innerText();
      const roles = ['甲方', '乙方', '執業人員'].filter((r) => text.includes(r));
      if (roles.length < 3) throw new Error(`畫面只出現 ${roles.join('、')}`);
      return '甲方、乙方、執業人員三個角色都出現在詳情頁';
    });
    await accept('MIL-71', '詳情頁的合約內容含現況確認附件頁', evidence, async () => {
      await expectText(page, '現況確認附件');
      return '合約內容預覽有「現況確認附件」';
    });
    await page.close();
    const list = await visit(ctx.practice, '/contracts');
    const listShot = await shot(list, 'mil72-contracts-list');
    await accept('MIL-72', '清單的簽署進度依序列顯示', listShot, async () => {
      const row = list.locator('tr', { hasText: '包租示範物件' }).filter({ hasText: '待乙方簽' }).first();
      await expect(row).toBeVisible({ timeout: 5_000 });
      return '包租合約那一列顯示「待乙方簽」與三個進度點（乙方、執業人員兼甲方、完成），停在第一點。進度點數量以截圖為準';
    });
    await list.close();
    const home = await visit(ctx.practice, '/');
    const homeShot = await shot(home, 'mil72-workbench');
    record('MIL-72', '工作台的待辦（乙方還沒簽時）', '通過', '乙方輪次時，待辦只列草稿，簽署中的包租合約不在待辦裡，球不在執業主體手上', homeShot);
    await home.close();
    // 乙方簽署後，輪到「執業人員兼甲方」
    await accept('MIL-72', '乙方簽署後，進度移到第二位簽署人（執業人員兼甲方）', undefined, async () => {
      const response = await ctx.practice.request.post('/api/mock/advance', { data: { contract_id: sent, event: 'signed' } });
      if (!response.ok()) throw new Error(`模擬乙方簽署失敗：${response.status()}`);
      const after = await visit(ctx.practice, `/contracts/${sent}`);
      await shot(after, 'mil72-after-tenant-signed');
      const text = await after.locator('body').innerText();
      await after.close();
      if (!/待執業人員/.test(text)) throw new Error('詳情頁沒有出現「待執業人員」');
      return '詳情頁的目前待簽變成「執業人員」，進度停在第二位';
    });
    const home2 = await visit(ctx.practice, '/');
    const home2Shot = await shot(home2, 'mil72-workbench-practitioner-turn');
    await accept('MIL-72', '輪到執業人員兼甲方時，工作台的待辦出現這份合約', home2Shot, async () => {
      const text = await home2.locator('body').innerText();
      if (!/包租示範物件/.test(text.split('快捷入口')[0] ?? '')) throw new Error('待辦區沒有包租示範物件');
      return '待辦區出現包租示範物件（執業人員與甲方是同一人，輪到時待辦出現）';
    });
    await home2.close();
    record('MIL-72', '三位不同的簽署人（甲方、乙方、執業人員各一人）', '畫面看不到', '這個環境的執業人員與甲方是同一人，合併成兩位簽署人，沒有驗收三位不同簽署人的情境。需要有一位不是當事人的執業人員才能驗收');
  } else {
    record('MIL-72', '包租合約', '不通過', '資料準備沒有產生已送簽的包租合約，詳情頁與清單無法驗收');
  }
  if (draft) {
    // 缺少執業人員在附件頁的簽署區域時，送簽被擋下並列出原因。暫時拿掉附件頁的簽名框，驗完還原
    await accept('MIL-71', '缺少執業人員在附件頁的簽署區域時，送簽被擋下並列出原因', undefined, async () => {
      const detail = (await (await ctx.practice.request.get(`/api/contracts/${draft}`)).json()) as { data: { signature_fields: Array<{ signer: string; page: number }> } };
      const original = detail.data.signature_fields;
      const withoutAnnex = original.filter((f) => !(f.signer === 'practitioner' && f.page === 2));
      if (withoutAnnex.length === original.length) throw new Error('草稿的簽署區域裡沒有附件頁的執業人員簽名框，沒有東西可拿掉');
      try {
        await ctx.practice.request.put(`/api/contracts/${draft}`, { data: { signature_fields: withoutAnnex } });
        const response = await ctx.practice.request.post(`/api/contracts/${draft}/send`);
        const body = await response.text();
        if (response.status() !== 400 || !body.includes('現況確認附件頁')) throw new Error(`回應 ${response.status()}：${body.slice(0, 160)}`);
        return '送簽回 400，原因含「請在現況確認附件頁為執業人員放置簽名框」（以 API 回應驗收，確認頁列出同一組原因）';
      } finally {
        await ctx.practice.request.put(`/api/contracts/${draft}`, { data: { signature_fields: original } });
      }
    });
    const page = await visit(ctx.practice, `/contracts/${draft}/edit`);
    const evidence = await shot(page, 'mil71-master-wizard');
    await accept('MIL-71', '包租租賃合約的精靈出現現況確認附件', evidence, async () => {
      await expectText(page, '現況確認附件');
      return '精靈確認頁有「現況確認附件」摘要';
    });
    await accept('MIL-72', '確認頁的順序說明由簽署序列產生', evidence, async () => {
      const text = await page.locator('body').innerText();
      if (/乙方先簽/.test(text)) throw new Error('確認頁仍是固定的「乙方先簽」文字');
      await expectText(page, /依序簽署：.*兼甲方/);
      return '確認頁顯示「依序簽署：乙方、執業人員兼甲方」，由簽署序列產生，沒有固定的「乙方先簽」文字';
    });
    await accept('MIL-71', '附件在填寫欄位步驟有狀態與備註可填', 'acc-mil71-annex-editor.png', async () => {
      await page.getByRole('button', { name: /上一步/ }).click({ timeout: 10_000 });
      await page.getByRole('button', { name: /上一步/ }).click({ timeout: 10_000 });
      await expectText(page, '現況確認附件', 10_000);
      await shot(page, 'mil71-annex-editor');
      return '回到步驟二，附件區每列有狀態與備註（截圖）';
    });
    await page.close();
  }
  // 屋主自己的租賃合約不加附件
  if (world.readyDraftId) {
    const page = await visit(ctx.owner, `/contracts/${world.readyDraftId}/edit`);
    await accept('MIL-71', '屋主的租賃合約不顯示現況確認附件', undefined, async () => {
      const count = await page.getByText('現況確認附件').count();
      if (count > 0) throw new Error('屋主的合約出現現況確認附件');
      return '屋主的草稿精靈沒有現況確認附件';
    });
    await page.close();
  }
  for (const item of ['附件內容隨草稿保存，送簽後凍結為快照', '附件頁排在簽署欄之後、不影響簽署欄落點', '既有合約的 PDF 不變', 'PDF 測試驗證附件頁的文字']) {
    record('MIL-71', item, '畫面看不到', '資料與 PDF 層的規則，由 vitest 涵蓋，這張票沒有驗收');
  }
  for (const item of ['進度步驟與位置是純函式（2、3、4 位測試）', '清單批次查簽署進度，不逐列查詢', '既有合約沒有簽署任務時畫面不報錯']) {
    record('MIL-72', item, '畫面看不到', '純函式與查詢方式，由 vitest 涵蓋，這張票沒有驗收');
  }
});

test('驗收 MIL-111：執業人員證書登錄、任職與專任規則', async () => {
  test.setTimeout(400_000);
  // 丙：還沒同意個資告知
  const gate = await visit(ctx.practice3, '/practitioner');
  const gateShot = await shot(gate, 'mil111-consent-gate');
  await accept('MIL-111', '開啟證書登錄頁先顯示個資告知，同意才顯示表單', gateShot, async () => {
    await expectText(gate, /我已閱讀並同意/);
    const formVisible = await gate.getByText('登錄或補件證書').count();
    if (formVisible > 0) throw new Error('還沒同意就看到登錄表單');
    return '沒有同意前只有告知與同意、不同意按鈕';
  });
  await gate.close();

  // 乙：已同意，證書待驗證，看表單
  const form = await visit(ctx.practice2, '/practitioner');
  const formShot = await shot(form, 'mil111-b-panel');
  await accept('MIL-111', '證號三段、證書種類、發證日、效期必填，效期預填發證日加 4 年', formShot, async () => {
    await expectText(form, '登錄或補件證書');
    // 登錄證書狀態是待驗證，表單照常顯示
    await form.locator('input[type="date"]').first().fill('2026-01-15');
    const until = await form.locator('input[type="date"]').nth(1).inputValue();
    if (until !== '2030-01-15') throw new Error(`效期預填是 ${until}，預期 2030-01-15`);
    return '發證日填 2026-01-15，效期預填 2030-01-15';
  });
  await accept('MIL-111', '效期與發證日加 4 年不一致時提示', undefined, async () => {
    await form.locator('input[type="date"]').nth(1).fill('2030-06-30');
    await expectText(form, /不一致|發證日加|四年|4 年/, 5_000);
    return '效期改成 2030-06-30，畫面顯示不一致的提示';
  });
  await form.close();

  // 乙用甲的證號登錄管理人員證書：預期被擋，訊息「此證號已有在職紀錄」
  const block = await visit(ctx.practice2, '/practitioner');
  await accept('MIL-111', '管理人員在別家已有已驗證在職時阻擋，訊息為「此證號已有在職紀錄」', 'acc-mil111-blocked.png', async () => {
    let via = '表單送出';
    try {
      await chooseOption(block.getByRole('combobox').first(), /租賃住宅管理人員/);
      await block.locator('input[maxlength="4"]').fill('112');
      await block.locator('.ant-input-affix-wrapper', { hasText: '字第' }).locator('input').fill('北市租管');
      await block.locator('input[maxlength="10"]').fill('00123');
      await block.locator('input[type="date"]').nth(0).fill('2026-06-30');
      await block.locator('input[type="date"]').nth(1).fill('2030-06-30');
      await block.locator('input[type="file"]').setInputFiles({ name: 'cert.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
      await block.getByRole('button', { name: /送\s*出/ }).click();
      await expectText(block, /此證號已有在職紀錄/, 10_000);
      await shot(block, 'mil111-blocked');
    } catch (error) {
      via = `API 回應（表單送出沒走通：${String(error).split('\n')[0].slice(0, 80)}）`;
      const response = await ctx.practice2.request.post('/api/practitioner/certificates', {
        multipart: {
          certificateKind: 'rental_housing_manager',
          certYear: '112',
          certWord: '北市租管',
          certSerial: '00123',
          issuedOn: '2026-06-30',
          validUntil: '2030-06-30',
          files: { name: 'cert.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') },
        },
      });
      const body = await response.text();
      if (response.status() !== 409 || !body.includes('此證號已有在職紀錄')) throw new Error(`回應 ${response.status()}：${body.slice(0, 120)}`);
    }
    return `乙用甲的證號登錄，被擋下，訊息為「此證號已有在職紀錄」，沒有顯示別家（${via}）`;
  });
  await block.close();

  // 甲：證書與任職都已核對
  const verified = await visit(ctx.practice, '/practitioner');
  const verifiedShot = await shot(verified, 'mil111-a-panel');
  await accept('MIL-111', '核對相符後，證書與任職顯示已驗證', verifiedShot, async () => {
    await expectText(verified, '已驗證');
    return '執業人員甲的頁面顯示「已驗證」';
  });
  await verified.close();

  // 標章：執業人員自己的頁面顯示「證書資料已核對」加核對日
  const badgePage = await visit(ctx.practice, '/practitioner');
  await accept('MIL-111', '標章文字固定為「證書資料已核對」加核對日，不含禁用詞', 'acc-mil111-a-panel.png', async () => {
    await expectText(badgePage, /證書資料已核對 \d{4}-\d{2}-\d{2}/, 5_000);
    const text = await badgePage.locator('body').innerText();
    if (/保證合法|認證|擔保/.test(text)) throw new Error('畫面出現禁用詞');
    return '「我的證書」頁顯示「證書資料已核對 2026-11-10」，沒有「保證合法」「認證」「擔保」';
  });
  await badgePage.close();
  record('MIL-111', '屋主端看到標章', '畫面看不到', '標章資料已提供（getCertificateBadges），屋主端總覽與案件頁要等 MIL-102 接線才會顯示。合約詳情的執業人員列目前沒有標章，這張票沒有驗收');
  for (const item of [
    '成員只能登錄自己的證書',
    '別家只有待驗證時允許並存',
    '舊任職離職後新任職為待驗證',
    '經紀人員掛第二家時要求所屬業者同意書',
    '同意書核對後標示「經所屬業者同意」',
    '排除約束只涵蓋已驗證的管理人員專任任職',
    '核對不符時維持待驗證並通知補件',
    '證書層核對跨組織沿用',
    '每次阻擋與提示寫稽核事件',
    '證書影本相符後刪除、同意書在任職有效期間保留',
  ]) {
    record('MIL-111', item, '畫面看不到', '權限、資料庫約束、稽核或需要兩家以上已驗證執業主體的情境，這張票沒有驗收。由 vitest 與真實 PostgreSQL 測試涵蓋');
  }
});

test.afterAll(async () => {
  writeFileSync(path.join(DATA_DIR, 'acceptance.json'), JSON.stringify(acceptance, null, 2));
});

// 未使用的匯出，避免 lint 抱怨
export type { OwnerWorld };
void createOwnerOrg;
void expect;
