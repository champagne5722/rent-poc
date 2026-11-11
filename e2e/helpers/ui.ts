import { expect, type Locator } from '@playwright/test';

/**
 * 按下按鈕，直到預期的結果出現。
 * dev server 的頁面剛載入時可能還沒 hydrate，第一下點擊會落空。這裡重試點擊，不靠固定等待。
 */
export async function clickUntil(target: Locator, outcome: Locator): Promise<void> {
  await expect(async () => {
    // 上一輪的點擊已經生效、只是結果慢出現時，按鈕可能已經消失。結果在了就不再點
    if (await outcome.isVisible()) return;
    await target.click({ timeout: 5_000 });
    await expect(outcome).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 40_000 });
}

/**
 * antd 的 Select：點開下拉，再選出名稱符合的選項。
 * 下拉用虛擬清單，role=option 的節點是隱藏的輔助節點，點不到。看得見的選項以 title（與顯示文字相同）定位。
 */
export async function chooseOption(select: Locator, optionName: RegExp | string): Promise<void> {
  const page = select.page();
  const option = page.getByTitle(optionName);
  await clickUntil(select, option);
  await option.click();
}
