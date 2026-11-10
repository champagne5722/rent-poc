import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect, test, type Page } from '@playwright/test';
import { seedProperty, uniqueBuildingNo, uniqueSuffix, verifyPropertyViaApi } from '../helpers/api';
import { createOwnerOrg, createPracticeOrg, newUserContext, signIn } from './session';
import { deskQueue, seedPracticeAndDesk, stepLog } from './seed';

// 審核台的前後截圖與 impeccable audit（MIL-180）。測試自己啟動 Chromium 並開 CDP port，
// 每頁載入完成後截圖，再執行 `impeccable detect --cdp <port> --target <路徑> --json --no-config`。
// 執行方式（在 worktree 根目錄，PHASE 是 before 或 after）：
//   MIL180_PHASE=after HEAVY_COST=6 scripts/heavy.sh e2e-desk scripts/e2e/run-e2e.sh baseline --grep "MIL-180"
// 產出：docs/ui/mil-180/<PHASE>-<頁面>.png、e2e-results/mil-180-audit-<PHASE>/<頁面>.json。
// 資料準備走應用程式自己的 API。撞號與認領項目是盡力準備，準備不起來時只記下原因，不中斷。

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..', '..');
const PHASE = process.env.MIL180_PHASE ?? 'after';
const SHOTS = path.join(ROOT, 'docs', 'ui', 'mil-180');
const AUDIT = path.join(ROOT, 'e2e-results', `mil-180-audit-${PHASE}`);
const CDP_PORT = Number(process.env.BASELINE_CDP_PORT ?? 9333);
const IMPECCABLE = path.join(ROOT, '.claude', 'skills', 'impeccable', 'scripts', 'impeccable');
const OPERATOR_EMAIL = process.env.BASELINE_OPERATOR_EMAIL ?? 'e2e-operator@example.com';

test('MIL-180 審核台前後截圖與 audit', async () => {
  test.setTimeout(900_000);
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(AUDIT, { recursive: true });
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${CDP_PORT}`] });
  const notes: string[] = [];
  try {
    const owner = await (await newUserContext(browser)).newPage();
    const practice = await (await newUserContext(browser)).newPage();
    const practice2 = await (await newUserContext(browser)).newPage();
    const practice3 = await (await newUserContext(browser)).newPage();
    const operator = await (await newUserContext(browser)).newPage();
    await signIn(operator, OPERATOR_EMAIL);

    // 執業主體與證書：業別核對與證書核對項目
    await signIn(practice, 'e2e-practice@example.com');
    await createPracticeOrg(practice, { name: '北辰示範租賃股份有限公司', taxId: '24680135', entityType: 'company', kinds: ['management', 'master_lease'] });
    await signIn(practice2, 'e2e-practice2@example.com');
    await createPracticeOrg(practice2, { name: '雲頂示範經紀行', taxId: '13572468', entityType: 'firm', kinds: ['brokerage'] });
    await signIn(practice3, 'e2e-practice3@example.com');
    await createPracticeOrg(practice3, { name: '星河示範經紀行', taxId: '11223344', entityType: 'firm', kinds: ['brokerage'] });
    const desk = await seedPracticeAndDesk(practice, practice2, practice3, operator);
    const failed = stepLog.filter((s) => !s.ok);
    if (failed.length > 0) notes.push(`資料準備失敗：${JSON.stringify(failed).slice(0, 600)}`);

    // 出租權源：一個待核對、一個已結案
    await signIn(owner, 'e2e-owner-desk@example.com');
    await createOwnerOrg(owner, 'E2E 審核台屋主');
    const openProperty = await seedProperty(owner, `E2E 待核對物件 ${uniqueSuffix()}`);
    await verifyPropertyViaApi(owner, browser, openProperty, { submitOnly: true });
    const doneProperty = await seedProperty(owner, `E2E 已結案物件 ${uniqueSuffix()}`);
    await verifyPropertyViaApi(owner, browser, doneProperty);

    // 撞號：另一個屋主對已驗證的同一個鍵登錄物件
    const owner2 = await (await newUserContext(browser)).newPage();
    await signIn(owner2, 'e2e-owner-desk2@example.com');
    await createOwnerOrg(owner2, 'E2E 審核台屋主二');
    const collisionResponse = await owner2.request.post('/api/properties', {
      data: {
        name: `E2E 撞號物件 ${uniqueSuffix()}`,
        address: '台北市大安區和平東路二段 100 號 3 樓',
        default_rent: 20000,
        equipment: [],
        anchor: { key: { city: 'A', town: '02', section: '0021', buildingNo: doneProperty.buildingNo, subNo: '' } },
      },
    });
    if (!collisionResponse.ok()) notes.push(`撞號物件建立失敗：${collisionResponse.status()}`);
    void uniqueBuildingNo;

    const open = await deskQueue(operator, 'open');
    const resolved = await deskQueue(operator, 'resolved');
    const find = (list: typeof open, type: string): string | undefined => list.find((i) => i.type === type)?.id;
    const targets: Array<{ id: string; url: string | null; ready: string }> = [
      { id: 'queue-open', url: '/desk', ready: '待核對' },
      { id: 'queue-resolved', url: '/desk?status=resolved', ready: '已結案' },
      { id: 'item-license', url: desk.deskLicenseItemId ? `/desk/items/${desk.deskLicenseItemId}` : null, ready: '登錄核對結果' },
      { id: 'item-credential', url: desk.deskCredentialItemId ? `/desk/items/${desk.deskCredentialItemId}` : null, ready: '登錄核對結果' },
      { id: 'item-collision', url: find(open, 'anchor_collision') ? `/desk/items/${find(open, 'anchor_collision')}` : null, ready: '宣稱方' },
      { id: 'item-claim', url: find(open, 'entity_claim') ? `/desk/items/${find(open, 'entity_claim')}` : null, ready: '判定歸屬' },
      { id: 'ownership-open', url: find(open, 'leasing_authority') ? `/desk/ownership/${find(open, 'leasing_authority')}` : null, ready: '判定' },
      { id: 'ownership-resolved', url: find(resolved, 'leasing_authority') ? `/desk/ownership/${find(resolved, 'leasing_authority')}` : null, ready: '判定結果' },
    ];

    for (const t of targets) {
      if (!t.url) {
        notes.push(`略過 ${t.id}：沒有對應的項目`);
        continue;
      }
      await operator.goto(t.url);
      if (t.id === 'queue-resolved') await operator.getByText(/^已結案/).first().click();
      await expect(operator.getByText(t.ready).first()).toBeVisible({ timeout: 60_000 });
      await operator.waitForLoadState('networkidle').catch(() => undefined);
      await shoot(operator, t.id);
      const { stdout } = await execFileAsync(IMPECCABLE, ['detect', '--cdp', String(CDP_PORT), '--target', new URL(operator.url()).pathname, '--json', '--no-config'], {
        maxBuffer: 20 * 1024 * 1024,
      }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '[]' }));
      writeFileSync(path.join(AUDIT, `${t.id}.json`), stdout);
    }
  } finally {
    writeFileSync(path.join(AUDIT, 'notes.txt'), notes.join('\n'));
    await browser.close();
  }
});

async function shoot(page: Page, id: string): Promise<void> {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, `${PHASE}-${id}.png`), fullPage: true });
}
