import type { Page } from '@playwright/test';

// 收集頁面的 console error、warning 與 pageerror。流程測試用它斷言「載入後沒有錯誤」。
// dev server 的 CSS preload 提示（例如 not-found.css）只在 next dev 出現，與頁面無關，不算。
const DEV_ONLY_NOISE = /was preloaded using link preload but not used/;

export function collectConsoleProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (DEV_ONLY_NOISE.test(msg.text())) return;
    if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`console.${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}
