import { theme as antdTheme } from 'antd';
import { describe, expect, it } from 'vitest';
import { parseDesignTheme, toAntdTheme } from './design-theme';

const md = (frontMatter: string) => `---\n${frontMatter}\n---\n\n# 內文\n`;

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

  it('front matter 沒提供的欄位不出現在 token，交給 antd 預設', () => {
    const design = parseDesignTheme(md('colors:\n  primary: "#5e6ad2"'));
    expect(design?.token).toEqual({ colorPrimary: '#5e6ad2' });
  });

  it('沒有 front matter 時回 null', () => {
    expect(parseDesignTheme('# 只有內文\n')).toBeNull();
  });
});

describe('toAntdTheme（client 端組 ConfigProvider theme）', () => {
  it('dark 為 true 時掛 darkAlgorithm', () => {
    const theme = toAntdTheme({ token: {}, dark: true });
    expect(theme?.algorithm).toBe(antdTheme.darkAlgorithm);
  });

  it('dark 為 false 時不掛 algorithm', () => {
    expect(toAntdTheme({ token: {}, dark: false })?.algorithm).toBeUndefined();
  });

  it('design 為 undefined（fallback）時回 undefined，讓 antd 用預設', () => {
    expect(toAntdTheme(undefined)).toBeUndefined();
  });
});
