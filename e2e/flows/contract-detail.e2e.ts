import { expect, test, type Browser, type Page } from '@playwright/test';
import { seedSendableDraft, seedVerifiedProperty, uniqueSuffix } from '../helpers/api';
import { clickUntil } from '../helpers/ui';

// 合約詳情的「下一步」區塊與狀態變更（MIL-175）。簽署走 mock 模式，不呼叫點點簽。
// 重構只改呈現：撤回、模擬拒簽的結果、複製為新草稿的行為都沿用既有 API。

async function seedSentContract(page: Page, browser: Browser): Promise<string> {
  const property = await seedVerifiedProperty(page, browser, `E2E 詳情物件 ${uniqueSuffix()}`);
  const contractId = await seedSendableDraft(page, property.id);
  const sent = await page.request.post(`/api/contracts/${contractId}/send`);
  expect(sent.ok()).toBe(true);
  return contractId;
}

test('合約詳情：簽署中寫出下一步與負責人，撤回後處理動作變成複製為新草稿', async ({ page, browser }) => {
  const contractId = await seedSentContract(page, browser);
  await page.goto(`/contracts/${contractId}`);

  // 頂端：返回列表、狀態、下一步與負責人
  await expect(page.getByRole('link', { name: /返回合約列表/ })).toBeVisible();
  const nextStep = page.getByLabel('下一步');
  await expect(nextStep).toContainText('等待乙方簽署');
  await expect(nextStep).toContainText('負責人：乙方 王租客');

  // 簽署進度列出每位簽署人的狀態，歷程用時間軸
  await expect(page.getByText('王租客・待簽署')).toBeVisible();
  await expect(page.getByText('合約歷程')).toBeVisible();

  // 撤回：確認後狀態變成已撤回，下一步改成複製為新草稿
  await clickUntil(nextStep.getByRole('button', { name: /撤回/ }), page.getByRole('button', { name: /確\s?定|OK/ }));
  await page.getByRole('button', { name: /確\s?定|OK/ }).click();
  await expect(page.getByText('已撤回').first()).toBeVisible();
  await expect(nextStep).toContainText('複製為新草稿');

  // 複製為新草稿：進入新合約的詳情，狀態是草稿
  await nextStep.getByRole('button', { name: /複製為新草稿/ }).click();
  await page.waitForURL((url) => /\/contracts\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(contractId), {
    waitUntil: 'commit',
  });
  await expect(page.getByText('草稿').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel('下一步')).toContainText('完成欄位與簽署區後送簽');
});

test('合約詳情：撤回失敗時還原狀態，顯示原因與下一步', async ({ page, browser }) => {
  const contractId = await seedSentContract(page, browser);
  await page.route(`**/api/contracts/${contractId}/void`, (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '簽署任務已經結束' }) })
  );
  await page.goto(`/contracts/${contractId}`);

  const nextStep = page.getByLabel('下一步');
  await clickUntil(nextStep.getByRole('button', { name: /撤回/ }), page.getByRole('button', { name: /確\s?定|OK/ }));
  await page.getByRole('button', { name: /確\s?定|OK/ }).click();

  // 失敗：畫面還原成待乙方簽，並寫出原因與下一步
  await expect(page.getByText('撤回失敗')).toBeVisible();
  await expect(page.getByText(/簽署任務已經結束/)).toBeVisible();
  await expect(page.getByText(/請重新整理頁面確認合約狀態/)).toBeVisible();
  await expect(page.getByText('待乙方簽').first()).toBeVisible();
  await expect(nextStep).toContainText('等待乙方簽署');
});

test('合約詳情：乙方拒簽後，下一步寫出拒簽的人，處理動作是複製為新草稿', async ({ page, browser }) => {
  const contractId = await seedSentContract(page, browser);
  await page.goto(`/contracts/${contractId}`);

  await clickUntil(page.getByRole('button', { name: '模擬乙方拒簽' }), page.getByLabel('下一步').getByText(/已拒簽/));
  const nextStep = page.getByLabel('下一步');
  await expect(nextStep).toContainText('乙方已拒簽');
  await expect(nextStep).toContainText('負責人：甲方（出租人）');
  await expect(nextStep.getByRole('button', { name: /複製為新草稿/ })).toBeVisible();
});

test('合約詳情：不存在的合約顯示找不到，並能回到列表', async ({ page }) => {
  await page.goto('/contracts/01JZZZZZZZZZZZZZZZZZZZZZZZ');
  await expect(page.getByRole('heading', { name: '找不到合約' })).toBeVisible();
  await page.getByRole('link', { name: /返回合約列表/ }).click();
  await page.waitForURL(/\/contracts$/);
});
