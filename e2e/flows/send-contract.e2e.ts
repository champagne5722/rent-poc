import { expect, test } from '@playwright/test';
import { seedProperty, seedSendableDraft, uniqueSuffix } from '../helpers/api';

// 流程 2：從合約詳情送簽，合約進入簽署中（MIL-168）。簽署走 mock 模式，不呼叫點點簽。
// 目前的產品把「確認送簽」放在建約精靈最後一步，詳情頁的草稿用「繼續編輯」進精靈。

test('合約詳情：草稿經確認送簽後，合約進入簽署中', async ({ page }) => {
  const property = await seedProperty(page, `E2E 送簽物件 ${uniqueSuffix()}`);
  const contractId = await seedSendableDraft(page, property.id);

  // 詳情頁：草稿狀態，標示 mock 模式
  await page.goto(`/contracts/${contractId}`);
  await expect(page.getByRole('heading', { name: /合約 #/ })).toBeVisible();
  await expect(page.getByText('mock 模式').first()).toBeVisible();
  await expect(page.getByText('草稿').first()).toBeVisible();

  // 繼續編輯：欄位與簽署區都齊全，直接來到最後一步
  await page.getByRole('link', { name: /繼續編輯/ }).click();
  await page.waitForURL(/\/contracts\/[^/]+\/edit$/);
  await expect(page.getByText(/乙方先簽/)).toBeVisible();
  await expect(page.getByText('王租客（tenant@example.com）')).toBeVisible();

  await page.getByRole('button', { name: /確認送簽/ }).click();

  // 送簽成功：回到詳情頁，狀態變成等乙方簽署
  await page.waitForURL(new RegExp(`/contracts/${contractId}$`));
  await expect(page.getByText('待乙方簽').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /繼續編輯/ })).toBeHidden();
  await expect(page.getByText('王租客').first()).toBeVisible();

  // 合約列表上，這份合約也在簽署中
  await page.goto('/contracts');
  const row = page.getByRole('row').filter({ hasText: property.name });
  await expect(row).toContainText('待乙方簽');
});
