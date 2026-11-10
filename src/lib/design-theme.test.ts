import { theme as antdTheme } from 'antd';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  designCssText,
  parseDesignFrontMatter,
  parseDesignTheme,
  toAntdTheme,
  type DesignTheme,
} from './design-theme';

const md = (frontMatter: string) => `---\n${frontMatter}\n---\n\n# 內文\n`;

const emptyDesign = (overrides: Partial<DesignTheme> = {}): DesignTheme => ({
  token: {},
  components: {},
  cssVars: {},
  warnings: [],
  dark: false,
  ...overrides,
});

describe('parseDesignTheme（DESIGN.md front matter → 可序列化 theme 資料）', () => {
  it('colors.primary 映射為 colorPrimary', () => {
    const design = parseDesignTheme(md('colors:\n  primary: "#5e6ad2"'));
    expect(design?.token.colorPrimary).toBe('#5e6ad2');
  });

  it('canvas 為深色時 dark 為 true', () => {
    const design = parseDesignTheme(md('colors:\n  canvas: "#010102"'));
    expect(design?.dark).toBe(true);
  });

  it('canvas 為亮色（或未提供）時 dark 為 false', () => {
    expect(parseDesignTheme(md('colors:\n  canvas: "#ffffff"'))?.dark).toBe(false);
    expect(parseDesignTheme(md('colors:\n  primary: "#5e6ad2"'))?.dark).toBe(false);
  });

  it('色彩、字體、圓角、間距映射到對應的 seed token', () => {
    const design = parseDesignTheme(
      md(
        [
          'colors:',
          '  ink: "#f7f8f8"',
          '  ink-muted: "#d0d6e0"',
          '  ink-subtle: "#8a8f98"',
          '  canvas: "#010102"',
          '  surface-1: "#0f1011"',
          '  surface-2: "#141516"',
          '  hairline: "#23252a"',
          '  hairline-strong: "#34343a"',
          '  semantic-success: "#27a644"',
          '  semantic-error: "#e5484d"',
          'typography:',
          '  body:',
          '    fontFamily: Linear Text',
          '    fontSize: 16px',
          'rounded:',
          '  md: 8px',
          'spacing:',
          '  md: 16px',
        ].join('\n'),
      ),
    );
    expect(design?.token).toMatchObject({
      colorText: '#f7f8f8',
      colorTextSecondary: '#d0d6e0',
      colorTextTertiary: '#8a8f98',
      colorBgLayout: '#010102',
      colorBgContainer: '#0f1011',
      colorBgElevated: '#141516',
      colorSplit: '#23252a',
      colorBorder: '#34343a',
      colorSuccess: '#27a644',
      colorError: '#e5484d',
      fontFamily: '"Linear Text", sans-serif',
      fontSize: 16,
      borderRadius: 8,
      sizeUnit: 4,
      sizeStep: 4,
    });
  });

  it('fontFamily 含逗號時視為完整字體堆疊，原樣輸出不加引號', () => {
    const design = parseDesignTheme(
      md('typography:\n  body:\n    fontFamily: IBM Plex Sans, PingFang TC, sans-serif'),
    );
    expect(design?.token.fontFamily).toBe('IBM Plex Sans, PingFang TC, sans-serif');
  });

  it('rounded.md 為 0px 時 borderRadius 為 0（直角）', () => {
    const design = parseDesignTheme(md('rounded:\n  md: 0px'));
    expect(design?.token.borderRadius).toBe(0);
  });

  it('front matter 沒提供的欄位不出現在 token，交給 antd 預設', () => {
    const design = parseDesignTheme(md('colors:\n  primary: "#5e6ad2"'));
    expect(design?.token).toEqual({ colorPrimary: '#5e6ad2' });
  });

  it('沒有 front matter 時回 null', () => {
    expect(parseDesignTheme('# 只有內文\n')).toBeNull();
  });
});

describe('parseDesignFrontMatter（原始 token 資料，給設計頁呈現）', () => {
  it('照 DESIGN.md 寫的內容回傳具名 scale，不經映射', () => {
    const data = parseDesignFrontMatter(
      md('colors:\n  primary: "#5e6ad2"\nspacing:\n  md: 16px\n  lg: 24px'),
    );
    expect(data?.colors).toEqual({ primary: '#5e6ad2' });
    expect(data?.spacing).toEqual({ md: '16px', lg: '24px' });
  });

  it('沒有 front matter 時回 null', () => {
    expect(parseDesignFrontMatter('# 只有內文\n')).toBeNull();
  });
});

describe('toAntdTheme（client 端組 ConfigProvider theme）', () => {
  it('dark 為 true 時掛 darkAlgorithm', () => {
    const theme = toAntdTheme(emptyDesign({ dark: true }));
    expect(theme?.algorithm).toBe(antdTheme.darkAlgorithm);
  });

  it('dark 為 false 時不掛 algorithm', () => {
    expect(toAntdTheme(emptyDesign())?.algorithm).toBeUndefined();
  });

  it('design 為 undefined（fallback）時回 undefined，讓 antd 用預設', () => {
    expect(toAntdTheme(undefined)).toBeUndefined();
  });
});

describe('元件層 token（front matter 的 components → antd theme.components）', () => {
  it('數字與 px 字串映射為數字，其他字串原樣輸出', () => {
    const design = parseDesignTheme(
      md(
        [
          'components:',
          '  Table:',
          '    cellPaddingBlockMD: 8px',
          '    cellFontSize: 14',
          '    borderColor: "#e4e5e8"',
          '  Alert:',
          '    defaultPadding: 8px 12px',
        ].join('\n'),
      ),
    );
    expect(design?.components).toEqual({
      Table: { cellPaddingBlockMD: 8, cellFontSize: 14, borderColor: '#e4e5e8' },
      Alert: { defaultPadding: '8px 12px' },
    });
  });

  it('{colors.x}、{spacing.x}、{rounded.x} 參照解析成該 token 的值', () => {
    const design = parseDesignTheme(
      md(
        [
          'colors:',
          '  canvas: "#f7f8f8"',
          'spacing:',
          '  sm: 12px',
          'rounded:',
          '  md: 6px',
          'components:',
          '  Table:',
          '    headerBg: "{colors.canvas}"',
          '    cellPaddingInlineMD: "{spacing.sm}"',
          '  Menu:',
          '    itemBorderRadius: "{rounded.md}"',
          '  Alert:',
          '    defaultPadding: "{spacing.sm} {spacing.sm}"',
        ].join('\n'),
      ),
    );
    expect(design?.components).toEqual({
      Table: { headerBg: '#f7f8f8', cellPaddingInlineMD: 12 },
      Menu: { itemBorderRadius: 6 },
      Alert: { defaultPadding: '12px 12px' },
    });
  });

  it('參照找不到時略過該欄位並記入 warnings，其他欄位照常輸出', () => {
    const design = parseDesignTheme(
      md(
        [
          'components:',
          '  Table:',
          '    headerBg: "{colors.nope}"',
          '    cellFontSize: 14',
        ].join('\n'),
      ),
    );
    expect(design?.components).toEqual({ Table: { cellFontSize: 14 } });
    expect(design?.warnings).toEqual([expect.stringContaining('Table.headerBg')]);
  });

  it('沒有 components 欄位時輸出空物件，不影響其他映射', () => {
    const design = parseDesignTheme(md('colors:\n  primary: "#5e6ad2"'));
    expect(design?.components).toEqual({});
    expect(design?.warnings).toEqual([]);
  });

  it('components 內的元件不是物件時略過並記入 warnings', () => {
    const design = parseDesignTheme(md('components:\n  Table: 12\n  Card:\n    bodyPadding: 16px'));
    expect(design?.components).toEqual({ Card: { bodyPadding: 16 } });
    expect(design?.warnings).toEqual([expect.stringContaining('Table')]);
  });

  it('toAntdTheme 把 components 放進 theme.components', () => {
    const theme = toAntdTheme(emptyDesign({ components: { Table: { cellFontSize: 14 } } }));
    expect(theme?.components).toEqual({ Table: { cellFontSize: 14 } });
  });

  it('components 為空時 toAntdTheme 不輸出 components 欄位', () => {
    expect(toAntdTheme(emptyDesign())).not.toHaveProperty('components');
  });
});

describe('多級字階（front matter 的 typography → antd 字級 token 與 CSS 變數）', () => {
  const scale = [
    'typography:',
    '  page-title:',
    '    fontSize: 20px',
    '    fontWeight: 600',
    '    lineHeight: 1.4',
    '  section-title:',
    '    fontSize: 16px',
    '    fontWeight: 600',
    '    lineHeight: 1.5',
    '  body:',
    '    fontSize: 14px',
    '    fontWeight: 400',
    '    lineHeight: 1.5',
    '  caption:',
    '    fontSize: 12px',
    '    fontWeight: 400',
    '    lineHeight: 1.5',
  ].join('\n');

  it('四級字階映射到 antd 的字級與行高 token', () => {
    const token = parseDesignTheme(md(scale))?.token;
    expect(token).toMatchObject({
      fontSize: 14,
      lineHeight: 1.5,
      fontSizeSM: 12,
      lineHeightSM: 1.5,
      fontSizeLG: 16,
      lineHeightLG: 1.5,
      fontSizeHeading5: 16,
      lineHeightHeading5: 1.5,
      fontSizeHeading4: 20,
      lineHeightHeading4: 1.4,
      fontWeightStrong: 600,
    });
  });

  it('缺少某一級時，該級的 antd token 不出現', () => {
    const token = parseDesignTheme(md('typography:\n  body:\n    fontSize: 14px'))?.token;
    expect(token).toEqual({ fontSize: 14 });
  });

  it('每一級輸出 --type-<名稱>-size / -weight / -line-height 三個 CSS 變數', () => {
    const vars = parseDesignTheme(md(scale))?.cssVars;
    expect(vars).toMatchObject({
      '--type-page-title-size': '20px',
      '--type-page-title-weight': '600',
      '--type-page-title-line-height': '1.4',
      '--type-caption-size': '12px',
      '--type-caption-weight': '400',
      '--type-caption-line-height': '1.5',
    });
  });

  it('某一級缺 fontWeight 時，不輸出該級的 weight 變數', () => {
    const vars = parseDesignTheme(md('typography:\n  caption:\n    fontSize: 12px'))?.cssVars;
    expect(vars?.['--type-caption-size']).toBe('12px');
    expect(vars).not.toHaveProperty('--type-caption-weight');
  });

  it('沒寫 fontFamily 時，不輸出 --font-family，字體交給 antd 預設堆疊', () => {
    const design = parseDesignTheme(md(scale));
    expect(design?.cssVars).not.toHaveProperty('--font-family');
    expect(design?.token).not.toHaveProperty('fontFamily');
  });

  it('寫了 fontFamily 時，--font-family 與 antd 的 fontFamily token 是同一組堆疊', () => {
    const design = parseDesignTheme(
      md('typography:\n  body:\n    fontFamily: IBM Plex Sans, PingFang TC, sans-serif'),
    );
    expect(design?.cssVars['--font-family']).toBe('IBM Plex Sans, PingFang TC, sans-serif');
    expect(design?.token.fontFamily).toBe('IBM Plex Sans, PingFang TC, sans-serif');
  });
});

describe('CSS 變數（給全域 CSS 引用）', () => {
  it('colors、spacing、rounded 輸出為 --color-*、--space-*、--radius-*', () => {
    const vars = parseDesignTheme(
      md(
        [
          'colors:',
          '  canvas: "#f7f8f8"',
          '  ink-muted: "#5d606b"',
          'spacing:',
          '  lg: 24px',
          'rounded:',
          '  md: 6px',
        ].join('\n'),
      ),
    )?.cssVars;
    expect(vars).toMatchObject({
      '--color-canvas': '#f7f8f8',
      '--color-ink-muted': '#5d606b',
      '--space-lg': '24px',
      '--radius-md': '6px',
    });
  });

  it('名稱含非法字元的 token 不輸出變數', () => {
    const vars = parseDesignTheme(md('colors:\n  "bad name;}": "#ffffff"\n  ok: "#000000"'))?.cssVars;
    expect(Object.keys(vars ?? {})).toContain('--color-ok');
    expect(Object.keys(vars ?? {}).filter((k) => k.includes('bad'))).toEqual([]);
  });

  it('designCssText 輸出 :root 規則', () => {
    const css = designCssText(emptyDesign({ cssVars: { '--color-canvas': '#f7f8f8', '--space-lg': '24px' } }));
    expect(css).toBe(':root{--color-canvas:#f7f8f8;--space-lg:24px;}');
  });

  it('designCssText 略過含 ; { } < > 的值，避免注入其他規則或標籤', () => {
    const css = designCssText(
      emptyDesign({
        cssVars: { '--color-a': '#fff;}body{display:none', '--color-b': '</style>', '--color-c': '#000' },
      }),
    );
    expect(css).toBe(':root{--color-c:#000;}');
  });

  it('design 為 undefined（fallback）時輸出空字串', () => {
    expect(designCssText(undefined)).toBe('');
  });
});

describe('現行 DESIGN.md（欄位完整性）', () => {
  const design = parseDesignTheme(readFileSync(join(process.cwd(), 'DESIGN.md'), 'utf8'));

  it('解析時沒有 warnings', () => {
    expect(design?.warnings).toEqual([]);
  });

  it('含 Table、Card、Button、Tag、Menu、Layout、Descriptions、Form、Alert、Steps 的元件層 token', () => {
    expect(Object.keys(design?.components ?? {}).sort()).toEqual(
      ['Alert', 'Button', 'Card', 'Descriptions', 'Form', 'Layout', 'Menu', 'Steps', 'Table', 'Tag'].sort(),
    );
  });

  it('含頁面標題、區段標題、內文、輔助文字四級字階', () => {
    for (const level of ['page-title', 'section-title', 'body', 'caption']) {
      expect(design?.cssVars).toHaveProperty(`--type-${level}-size`);
      expect(design?.cssVars).toHaveProperty(`--type-${level}-weight`);
      expect(design?.cssVars).toHaveProperty(`--type-${level}-line-height`);
    }
  });

  it('只有一個強調色：資訊色與連結色都跟隨 primary', () => {
    expect(design?.token.colorInfo).toBe(design?.token.colorPrimary);
  });

  it('字體堆疊明寫在 DESIGN.md，且 --font-family 與 antd 的 fontFamily token 相同', () => {
    expect(design?.cssVars['--font-family']).toContain('-apple-system');
    expect(design?.cssVars['--font-family']).toBe(design?.token.fontFamily);
  });

  it('畫布色變數與 colorBgLayout 一致', () => {
    expect(design?.cssVars['--color-canvas']).toBe(design?.token.colorBgLayout);
  });
});
