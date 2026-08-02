// 只給 server component 用：client bundle 不能含 node:fs，
// 所以讀檔與純解析（design-theme.ts）分成兩個模組。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseDesignFrontMatter,
  parseDesignTheme,
  type DesignFrontMatter,
  type DesignTheme,
} from './design-theme';

const DEFAULT_PATH = () => join(process.cwd(), 'DESIGN.md');

export function loadDesignTheme(filePath: string = DEFAULT_PATH()): DesignTheme | undefined {
  try {
    const design = parseDesignTheme(readFileSync(filePath, 'utf8'));
    if (!design) {
      console.error(`DESIGN.md 缺少 front matter，改用 antd 預設 theme：${filePath}`);
      return undefined;
    }
    return design;
  } catch (error) {
    console.error(`DESIGN.md 解析失敗，改用 antd 預設 theme：${filePath}`, error);
    return undefined;
  }
}

/** 設計頁用：讀 DESIGN.md 的原始 token 資料（未映射），讀不到時回 undefined 並記 error。 */
export function loadDesignFrontMatter(
  filePath: string = DEFAULT_PATH(),
): DesignFrontMatter | undefined {
  try {
    return parseDesignFrontMatter(readFileSync(filePath, 'utf8')) ?? undefined;
  } catch (error) {
    console.error(`DESIGN.md 讀取失敗：${filePath}`, error);
    return undefined;
  }
}
