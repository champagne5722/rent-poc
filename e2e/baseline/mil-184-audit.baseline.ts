import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect, test } from '@playwright/test';
import { seedProperty, seedSendableDraft, uniqueSuffix } from '../helpers/api';

// 案件列表與案件詳情的 impeccable audit（MIL-184）。測試自己啟動 Chromium 並開 CDP port，
// 每頁載入完成後執行 `impeccable detect --cdp <port> --target <路徑> --json --no-config`，掃渲染後的頁面。
// 執行方式（在 worktree 根目錄）：
//   HEAVY_COST=6 scripts/heavy.sh e2e-audit scripts/e2e/run-e2e.sh baseline --grep "MIL-184 audit"
// 產出：e2e-results/mil-184-audit/<頁面>.json。判讀方式同 docs/ui/baseline/README.md 的 impeccable audit 一節。

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'e2e-results', 'mil-184-audit');
const CDP_PORT = Number(process.env.BASELINE_CDP_PORT ?? 9333);
const IMPECCABLE = path.join(ROOT, '.claude', 'skills', 'impeccable', 'scripts', 'impeccable');

test('MIL-184 audit：案件列表、案件詳情、屋主端案件詳情', async () => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${CDP_PORT}`] });
  try {
    const context = await browser.newContext({
      storageState: 'e2e-results/.auth/state.json',
      baseURL: process.env.BASE_URL ?? 'http://localhost:3410',
      viewport: { width: 1440, height: 900 },
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei',
    });
    const page = await context.newPage();
    const property = await seedProperty(page, `E2E 稽核物件 ${uniqueSuffix()}`);
    const contractId = await seedSendableDraft(page, property.id);
    const rows = (await (await page.request.get('/api/cases')).json()).data as Array<{ id: string }>;
    let caseId = '';
    for (const r of rows) {
      const d = (await (await page.request.get(`/api/cases/${r.id}`)).json()).data;
      if ((d.contracts as Array<{ id: string }>).some((c) => c.id === contractId)) caseId = r.id;
    }
    expect(caseId).not.toBe('');
    expect((await page.request.post(`/api/contracts/${contractId}/send`)).ok()).toBe(true);

    const targets: Array<{ id: string; url: string; ready: string }> = [
      { id: 'cases-list', url: '/cases', ready: '案件列表' },
      { id: 'case-detail', url: `/cases/${caseId}`, ready: '案件屬性' },
      { id: 'owner-case-detail', url: `/owner/cases/${caseId}`, ready: '案件屬性' },
    ];
    for (const t of targets) {
      await page.goto(t.url);
      await expect(page.getByText(t.ready).first()).toBeVisible({ timeout: 60_000 });
      if (t.id !== 'cases-list') await expect(page.getByText('押金台帳').first()).toBeVisible({ timeout: 30_000 });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      const { stdout } = await execFileAsync(IMPECCABLE, ['detect', '--cdp', String(CDP_PORT), '--target', new URL(page.url()).pathname, '--json', '--no-config'], {
        maxBuffer: 20 * 1024 * 1024,
      }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '[]' }));
      writeFileSync(path.join(OUT, `${t.id}.json`), stdout);
      await page.screenshot({ path: path.join(OUT, `${t.id}.png`), fullPage: true });
    }
  } finally {
    await browser.close();
  }
});
