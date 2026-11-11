import { expect, test } from '@playwright/test';
import { seedDraft, seedVerifiedProperty, uniqueSuffix } from '../helpers/api';

// MIL-200：居間只限主辦組織自己兼營經紀業。屋主組織看不到居間選項，也沒有任何提示（ADR-0029 決議 3）。
// 順便存一張畫面截圖到 e2e-results（不進版控），給主控看畫面。

test('屋主組織建約：分流條件沒有居間選項，也沒有提示', async ({ page, browser }, testInfo) => {
  const property = await seedVerifiedProperty(page, browser, `E2E 居間物件 ${uniqueSuffix()}`);
  const id = await seedDraft(page, property.id);

  // 居間選項的狀態由伺服端算出，隨指派選項的回應回來
  const res = await page.request.get(`/api/contracts/${id}/practitioners`);
  expect({ status: res.status(), body: (await res.text()).slice(0, 300) }).toMatchObject({ status: 200 });
  expect(((await res.json()) as { data: { brokerChoice: unknown } }).data.brokerChoice).toEqual({ kind: 'hidden' });

  await page.goto(`/contracts/${id}/edit`);
  // 等指派選項載入完，「看不到」才不是因為還沒載入
  await page.waitForLoadState('networkidle');
  // 草稿預設落在第二步。回到第一步看分流條件
  await page.getByRole('button', { name: /上一步/ }).click();
  await expect(page.getByText('分流條件（決定誰要簽署與簽署順序）')).toBeVisible();
  await expect(page.getByText('承租人是否為包租業者')).toBeVisible();
  await expect(page.getByText('是否有經紀業者居間')).toHaveCount(0);
  await expect(page.getByText('經紀業別驗證後才能勾選')).toHaveCount(0);

  await page.screenshot({ path: testInfo.outputPath('owner-routing-no-broker.png'), fullPage: true });
});

test('屋主組織從物件入口進建約精靈：第一步沒有居間選項，也沒有提示', async ({ page, browser }) => {
  const property = await seedVerifiedProperty(page, browser, `E2E 精靈居間物件 ${uniqueSuffix()}`);

  await page.goto(`/contracts/new?property=${property.id}&kind=lease`);
  await expect(page.getByRole('heading', { name: '建立合約' })).toBeVisible();
  // 居間選項的狀態在伺服端算好才送到畫面，不必等額外的請求
  await expect(page.getByText('分流條件（決定誰要簽署與簽署順序）')).toBeVisible();
  await expect(page.getByText('承租人是否為包租業者')).toBeVisible();
  await expect(page.getByText('是否有經紀業者居間')).toHaveCount(0);
  await expect(page.getByText('經紀業別驗證後才能勾選')).toHaveCount(0);
});
