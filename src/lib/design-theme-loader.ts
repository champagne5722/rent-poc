// 只給 server component 用：client bundle 不能含 node:fs，
// 所以讀檔與純解析（design-theme.ts）分成兩個模組。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDesignTheme, type DesignTheme } from './design-theme';

export function loadDesignTheme(
  filePath: string = join(process.cwd(), 'DESIGN.md'),
): DesignTheme | undefined {
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
