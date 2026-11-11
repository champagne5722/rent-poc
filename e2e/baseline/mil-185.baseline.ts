import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, test, type BrowserContext, type Page } from '@playwright/test';
import { createOwnerOrg, createPracticeOrg, newUserContext, signIn } from './session';
import { deskQueue, seedOwner, seedPracticeAndDesk, stepLog, type OwnerWorld } from './seed';

// UI 收尾（MIL-185）第一段的截圖、載入量測與 impeccable audit。測試自己啟動 Chromium 並開 CDP port，
// 每頁載入完成後截圖，再執行 `impeccable detect --cdp <port> --target <路徑> --json --no-config`。
// 執行方式（在 worktree 根目錄）：
//   HEAVY_COST=6 scripts/heavy.sh e2e-185 scripts/e2e/run-e2e.sh baseline --grep "MIL-185"
// 產出：docs/ui/mil-185/after-<頁面>.png、docs/ui/mil-185/data/results.json。
// 資料準備走應用程式自己的 API。準備不起來的項目只記下原因，不中斷。

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'ui', 'mil-185');
const DATA = path.join(OUT, 'data');
const CDP_PORT = Number(process.env.BASELINE_CDP_PORT ?? 9333);
const IMPECCABLE = path.join(ROOT, '.claude', 'skills', 'impeccable', 'scripts', 'impeccable');
const OPERATOR_EMAIL = process.env.BASELINE_OPERATOR_EMAIL ?? 'e2e-operator@example.com';
const OWNER_STATE = 'e2e-results/.auth/state.json';

interface Target {
  id: string;
  title: string;
  context: 'owner' | 'owner-empty' | 'practice' | 'operator';
  url: string | null;
  /** 頁面載入後要等到的文字 */
  ready?: string;
}

async function hrefs(page: Page, route: string, pattern: RegExp): Promise<string | null> {
  await page.goto(route, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const all = await page.locator('a').evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''));
  return all.map((h) => h.match(pattern)?.[1]).find(Boolean) ?? null;
}

async function pageFacts(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const primary = [...document.querySelectorAll('.ant-btn-primary')].filter(visible).map((el) => el.textContent?.trim().replace(/\s+/g, ' ') ?? '');
    const header = document.querySelector('.ant-layout-header') as HTMLElement | null;
    const logout = [...document.querySelectorAll('button')].find((b) => /登出/.test(b.textContent ?? ''));
    return {
      url: location.pathname + location.search,
      primaryButtons: primary,
      headerHeight: header ? Math.round(header.getBoundingClientRect().height) : null,
      logoutBottom: logout ? Math.round(logout.getBoundingClientRect().bottom) : null,
      menu: [...document.querySelectorAll('.ant-layout-sider .ant-menu-item')].map((el) => el.textContent?.trim() ?? ''),
      selectedMenu: document.querySelector('.ant-menu-item-selected')?.textContent?.trim() ?? null,
      scrollHeight: document.documentElement.scrollHeight,
    };
  });
}

async function measureLoad(page: Page, url: string) {
  const started = Date.now();
  await page.goto(url, { waitUntil: 'commit' });
  const measure = { msToStable: null as number | null, spinnerSamples: 0, samples: 0, skeletonSeen: false };
  let stable = 0;
  while (Date.now() - started < 25_000) {
    const state = await page
      .evaluate(() => ({
        spin: document.querySelectorAll('.ant-spin-spinning').length,
        skeleton: document.querySelectorAll('.ant-skeleton').length > 0,
        textLength: document.body?.innerText?.trim().length ?? 0,
      }))
      .catch(() => null);
    if (state) {
      measure.samples += 1;
      if (state.spin > 0) measure.spinnerSamples += 1;
      if (state.skeleton) measure.skeletonSeen = true;
      if (state.spin === 0 && state.textLength > 30) {
        stable += 1;
        if (stable >= 3) {
          measure.msToStable = Date.now() - started;
          break;
        }
      } else stable = 0;
    }
    await page.waitForTimeout(80);
  }
  return measure;
}

test('MIL-185 第一段截圖與 audit', async () => {
  test.setTimeout(1_500_000);
  mkdirSync(DATA, { recursive: true });
  const notes: string[] = [];
  const results: Array<Record<string, unknown>> = [];
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${CDP_PORT}`] });
  try {
    const contexts: Record<Target['context'], BrowserContext> = {
      owner: await newUserContext(browser, { storageState: OWNER_STATE }),
      'owner-empty': await newUserContext(browser),
      practice: await newUserContext(browser),
      operator: await newUserContext(browser),
    };
    const practice2 = await (await newUserContext(browser)).newPage();
    const practice3 = await (await newUserContext(browser)).newPage();
    const claimant = await (await newUserContext(browser)).newPage();
    const operator = await contexts.operator.newPage();
    const practice = await contexts.practice.newPage();
    const owner = await contexts.owner.newPage();
    const empty = await contexts['owner-empty'].newPage();

    // 屋主：物件、合約、案件、收款帳戶
    await owner.goto('/');
    const world: Partial<OwnerWorld> = await seedOwner(owner, browser).catch((e: unknown) => {
      notes.push(`屋主資料準備失敗：${String(e).slice(0, 200)}`);
      return {};
    });
    // 空狀態：全新屋主組織，沒有合約與案件
    await signIn(empty, 'e2e-empty-185@example.com');
    await createOwnerOrg(empty, 'E2E 空狀態屋主');

    // 執業主體甲（長組織名稱）、乙、丙與營運者
    await signIn(operator, OPERATOR_EMAIL);
    await signIn(practice, 'e2e-practice@example.com');
    await createPracticeOrg(practice, { name: '北辰示範租賃股份有限公司', taxId: '24680135', entityType: 'company', kinds: ['management', 'master_lease'] });
    await signIn(practice2, 'e2e-practice2@example.com');
    await createPracticeOrg(practice2, { name: '雲頂示範經紀行', taxId: '13572468', entityType: 'firm', kinds: ['brokerage'] });
    await signIn(practice3, 'e2e-practice3@example.com');
    await createPracticeOrg(practice3, { name: '星河示範經紀行', taxId: '11223344', entityType: 'firm', kinds: ['brokerage'] });
    const desk = await seedPracticeAndDesk(practice, practice2, practice3, operator);
    // 統編認領：另一個帳號用同一個統編登錄執業主體，審核台出現統編認領項目
    await signIn(claimant, 'e2e-claimant@example.com');
    await createPracticeOrg(claimant, { name: '遠山示範管理顧問有限公司', taxId: '24680135', entityType: 'company', kinds: ['management'] }).catch((e: unknown) => {
      notes.push(`統編認領準備失敗：${String(e).slice(0, 200)}`);
    });
    const failed = stepLog.filter((s) => !s.ok);
    if (failed.length > 0) notes.push(`資料準備失敗：${JSON.stringify(failed).slice(0, 600)}`);

    const open = await deskQueue(operator, 'open');
    const claimId = open.find((i) => i.type === 'entity_claim')?.id;
    const handover = await hrefs(owner, '/owner/handovers', /\/owner\/handovers\/([A-Za-z0-9_-]+)$/);
    const caseId = world.completedCaseId ?? null;

    const targets: Target[] = [
      { id: 'workbench', title: '工作台', context: 'owner', url: '/', ready: '工作台' },
      { id: 'contracts-list', title: '合約列表', context: 'owner', url: '/contracts', ready: '合約列表' },
      { id: 'contracts-list-empty', title: '合約列表（空狀態）', context: 'owner-empty', url: '/contracts', ready: '合約列表' },
      { id: 'cases-list-empty', title: '案件列表（空狀態）', context: 'owner-empty', url: '/cases', ready: '案件列表' },
      { id: 'case-detail-ledger', title: '案件詳情（帳務設定）', context: 'owner', url: caseId ? `/cases/${caseId}` : null, ready: '押金台帳' },
      { id: 'owner-case-detail', title: '屋主端 案件詳情', context: 'owner', url: caseId ? `/owner/cases/${caseId}` : null, ready: '案件屬性' },
      { id: 'owner-overview', title: '屋主資產總覽', context: 'owner', url: '/owner' },
      { id: 'owner-handovers', title: '屋主端 移交清單', context: 'owner', url: '/owner/handovers' },
      { id: 'owner-handover-new', title: '屋主端 發起移交', context: 'owner', url: '/owner/handovers/new' },
      { id: 'owner-handover-detail', title: '屋主端 移交詳情', context: 'owner', url: handover && handover !== 'new' ? `/owner/handovers/${handover}` : null },
      { id: 'owner-not-found', title: '屋主端 找不到頁面', context: 'owner', url: '/owner/not-a-page', ready: '找不到這個頁面' },
      { id: 'members', title: '成員管理', context: 'owner', url: '/settings/members' },
      { id: 'design', title: '設計樣式頁', context: 'owner', url: '/design' },
      { id: 'practice', title: '執業主體（長組織名稱的帳號列）', context: 'practice', url: '/practice' },
      { id: 'practitioner', title: '我的證書', context: 'practice', url: '/practitioner' },
      { id: 'desk-queue', title: '審核台佇列', context: 'operator', url: '/desk', ready: '待核對' },
      { id: 'desk-credential', title: '審核台項目（證書核對）', context: 'operator', url: desk.deskCredentialItemId ? `/desk/items/${desk.deskCredentialItemId}` : null, ready: '登錄核對結果' },
      { id: 'desk-claim', title: '審核台項目（統編認領）', context: 'operator', url: claimId ? `/desk/items/${claimId}` : null },
    ];

    for (const t of targets) {
      const entry: Record<string, unknown> = { id: t.id, title: t.title, url: t.url };
      results.push(entry);
      if (!t.url) {
        entry.error = '沒有對應的資料';
        notes.push(`略過 ${t.id}：沒有對應的資料`);
        continue;
      }
      const page = await contexts[t.context].newPage();
      try {
        await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
        entry.load = await measureLoad(page, t.url);
        await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
        if (t.ready) await page.getByText(t.ready).first().waitFor({ timeout: 60_000 }).catch(() => notes.push(`${t.id}：等不到「${t.ready}」`));
        await page.waitForFunction(() => !document.querySelector('.ant-spin-spinning'), null, { timeout: 30_000 }).catch(() => undefined);
        await page.evaluate(() => document.fonts.ready);
        await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
        await page.waitForTimeout(500);
        entry.facts = await pageFacts(page);
        const file = `after-${t.id}.png`;
        await page.screenshot({ path: path.join(OUT, file), fullPage: true, animations: 'disabled', caret: 'hide' });
        entry.screenshot = file;
        const pathname = new URL(page.url()).pathname + new URL(page.url()).search;
        const detect = await execFileAsync(IMPECCABLE, ['detect', '--cdp', String(CDP_PORT), '--target', pathname, '--json', '--no-config'], {
          cwd: ROOT,
          timeout: 120_000,
          maxBuffer: 20 * 1024 * 1024,
        }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '[]' }));
        try {
          const parsed = JSON.parse(detect.stdout) as unknown;
          entry.findings = Array.isArray(parsed) ? parsed : ((parsed as { findings?: unknown[] }).findings ?? []);
        } catch {
          entry.error = `detect JSON 解析失敗：${detect.stdout.slice(0, 120)}`;
        }
      } catch (error) {
        entry.error = error instanceof Error ? error.message.slice(0, 300) : String(error);
      } finally {
        await page.close().catch(() => undefined);
      }
    }

    // 帳號列放大圖：長組織名稱的執業主體使用者
    const headerPage = await contexts.practice.newPage();
    await headerPage.goto('/practice', { waitUntil: 'domcontentloaded' });
    await headerPage.waitForLoadState('networkidle').catch(() => undefined);
    await headerPage.waitForTimeout(800);
    await headerPage.screenshot({ path: path.join(OUT, 'after-shellheader-practitioner.png'), clip: { x: 0, y: 0, width: 1440, height: 120 } });
    await headerPage.close();
  } finally {
    writeFileSync(path.join(DATA, 'results.json'), JSON.stringify({ capturedAt: new Date().toISOString(), notes, pages: results }, null, 2));
    await browser.close();
  }
});
