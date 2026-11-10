import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { seedProperty, seedSendableDraft, uniqueSuffix } from '../helpers/api';
import { clickUntil } from '../helpers/ui';

// 案件列表與案件詳情（MIL-184）。重構只改呈現：狀態分組、成員、帳務設定、案件事件的行為沿用既有 API。
// 設定環境變數 SHOT_DIR 時，順便把畫面存成截圖（前後對照用）。

async function seedCase(page: Page): Promise<{ caseId: string; contractId: string }> {
  const property = await seedProperty(page, `E2E 案件物件 ${uniqueSuffix()}`);
  const contractId = await seedSendableDraft(page, property.id);
  const res = await page.request.get('/api/cases');
  expect(res.ok()).toBe(true);
  const rows = (await res.json()).data as Array<{ id: string }>;
  const detail = await Promise.all(
    rows.map(async (r) => ({ id: r.id, contracts: (await (await page.request.get(`/api/cases/${r.id}`)).json()).data.contracts as Array<{ id: string }> })),
  );
  const found = detail.find((d) => d.contracts.some((c) => c.id === contractId));
  expect(found, '合約所屬的案件').toBeTruthy();
  return { caseId: found!.id, contractId };
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
}

test('案件列表：頁首、狀態分組與狀態標籤，點案件進入詳情', async ({ page }) => {
  const { caseId } = await seedCase(page);
  await page.goto('/cases');

  await expect(page.getByRole('heading', { name: '案件列表' })).toBeVisible();
  // 狀態分組：草稿案件算在「草稿」，不在「簽署中」
  const drafts = page.getByText('草稿', { exact: false }).first();
  await expect(drafts).toBeVisible();
  const row = page.locator(`a[href="/cases/${caseId}"]`);
  await expect(row).toBeVisible();
  await shot(page, 'cases-list-after');

  await page.getByText(/^簽署中 \d+$/).click();
  await expect(page.getByText('沒有符合篩選條件的資料')).toBeVisible();
  await shot(page, 'cases-list-filtered-empty');
  await page.getByRole('button', { name: '清除篩選' }).last().click();
  await expect(row).toBeVisible();

  await clickUntil(row, page.getByRole('link', { name: /返回案件列表/ }));
  await expect(page).toHaveURL(new RegExp(`/cases/${caseId}$`));
});

test('案件詳情：頂端寫出狀態與下一步，帳務設定與案件事件是可收合區段', async ({ page }) => {
  const { caseId, contractId } = await seedCase(page);
  await page.goto(`/cases/${caseId}`);

  await expect(page.getByRole('link', { name: /返回案件列表/ })).toBeVisible();
  const nextStep = page.getByLabel('下一步');
  await expect(nextStep).toContainText('完成合約欄位與簽署區後送簽');
  await expect(nextStep).toContainText('負責人：主辦組織');
  await expect(page.getByText('案件屬性')).toBeVisible();
  await expect(nextStep.getByRole('link', { name: '前往目前合約' })).toHaveAttribute('href', `/contracts/${contractId}`);

  // 帳務設定預設展開，案件事件預設收合
  const ledger = page.getByRole('button', { name: '帳務設定' });
  await expect(ledger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('押金台帳').first()).toBeVisible({ timeout: 30_000 });
  const events = page.getByRole('button', { name: /案件事件/ });
  await expect(events).toHaveAttribute('aria-expanded', 'false');
  await shot(page, 'case-detail-after');
  await events.click();
  await expect(page.getByText('建立案件').first()).toBeVisible();

  // 帳務設定可以收合
  await ledger.click();
  await expect(ledger).toHaveAttribute('aria-expanded', 'false');
});

test('案件詳情：送簽後狀態與下一步更新；加入共同承租人後成員列表更新', async ({ page }) => {
  const { caseId, contractId } = await seedCase(page);
  const sent = await page.request.post(`/api/contracts/${contractId}/send`);
  expect(sent.ok()).toBe(true);
  await page.goto(`/cases/${caseId}`);
  await expect(page.getByLabel('下一步')).toContainText('等待合約全員簽署');

  const email = `co-${uniqueSuffix()}@example.com`;
  await page.getByLabel('姓名').fill('林共同');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: /加\s?入/ }).click();
  await expect(page.getByText('已加入共同承租人')).toBeVisible();
  await expect(page.getByRole('cell', { name: email })).toBeVisible();
  await expect(page.getByRole('cell', { name: '共同承租人' })).toBeVisible();
});

test('案件詳情：不存在的案件顯示找不到，並有返回列表的連結', async ({ page }) => {
  await page.goto('/cases/01ARZ3NDEKTSV4RRFFQ69G5FAV');
  await expect(page.getByRole('heading', { name: '找不到案件' })).toBeVisible();
  await expect(page.getByRole('link', { name: /返回案件列表/ })).toBeVisible();
  await page.goto('/cases/not-a-ulid');
  await expect(page.getByRole('heading', { name: '找不到案件' })).toBeVisible();
});
