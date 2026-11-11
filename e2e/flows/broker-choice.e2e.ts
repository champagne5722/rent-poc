import { expect, test } from '@playwright/test';
import { seedDraft, seedVerifiedProperty, uniqueSuffix } from '../helpers/api';

// MIL-200：居間只限主辦組織自己兼營經紀業。屋主組織看不到居間選項，也沒有任何提示（ADR-0029 決議 3）。
// 設定環境變數 MIL200_SHOTS 為資料夾路徑時，順便存一張畫面截圖。

test('屋主組織建約：分流條件沒有居間選項，也沒有提示', async ({ page, browser }) => {
  const property = await seedVerifiedProperty(page, browser, `E2E 居間物件 ${uniqueSuffix()}`);
  const id = await seedDraft(page, property.id);

  // 居間選項的狀態由伺服端算出，隨指派選項的請求回來。等它回來再檢查，不然「看不到」可能只是還沒載入
  const options = page.waitForResponse((r) => r.url().includes(`/api/contracts/${id}/practitioners`) && r.request().method() === 'GET');
  await page.goto(`/contracts/${id}/edit`);
  const body = (await (await options).json()) as { data: { brokerChoice: { kind: string } } };
  expect(body.data.brokerChoice).toEqual({ kind: 'hidden' });

  await page.getByText('物件與範本').click();
  await expect(page.getByText('分流條件（決定誰要簽署與簽署順序）')).toBeVisible();
  await expect(page.getByText('承租人是否為包租業者')).toBeVisible();
  await expect(page.getByText('是否有經紀業者居間')).toHaveCount(0);
  await expect(page.getByText('經紀業別驗證後才能勾選')).toHaveCount(0);

  const shots = process.env.MIL200_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/owner-routing-no-broker.png`, fullPage: true });
});
