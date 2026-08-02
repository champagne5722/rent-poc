import { parse as parseYaml } from 'yaml';
import { theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';

// server component 不能把函式（algorithm）傳給 client component，
// 所以 parse 結果維持可序列化，darkAlgorithm 由 client 端的 toAntdTheme 掛上。
export interface DesignTheme {
  token: Record<string, string | number>;
  dark: boolean;
}

export interface DesignFrontMatter {
  name?: string;
  description?: string;
  colors?: Record<string, string>;
  typography?: Record<string, { fontFamily?: string; fontSize?: string }>;
  rounded?: Record<string, string>;
  spacing?: Record<string, string>;
}

const FRONT_MATTER_PATTERN = /^---\n([\s\S]*?)\n---/;

const COLOR_SEED_MAP: Record<string, string> = {
  primary: 'colorPrimary',
  ink: 'colorText',
  'ink-muted': 'colorTextSecondary',
  'ink-subtle': 'colorTextTertiary',
  canvas: 'colorBgLayout',
  'surface-1': 'colorBgContainer',
  'surface-2': 'colorBgElevated',
  hairline: 'colorSplit',
  'hairline-strong': 'colorBorder',
  'semantic-success': 'colorSuccess',
  'semantic-error': 'colorError',
  'semantic-warning': 'colorWarning',
  'semantic-info': 'colorInfo',
};

/** 取 front matter 的原始 token 資料（未映射），給設計頁呈現與版面程式碼引用。 */
export function parseDesignFrontMatter(content: string): DesignFrontMatter | null {
  const match = content.match(FRONT_MATTER_PATTERN);
  if (!match) return null;
  return parseYaml(match[1]) as DesignFrontMatter;
}

export function parseDesignTheme(content: string): DesignTheme | null {
  const data = parseDesignFrontMatter(content);
  if (!data) return null;

  const token: DesignTheme['token'] = {};
  for (const [designKey, seedKey] of Object.entries(COLOR_SEED_MAP)) {
    const value = data.colors?.[designKey];
    if (value) token[seedKey] = value;
  }

  const body = data.typography?.body;
  if (body?.fontFamily) token.fontFamily = `"${body.fontFamily}", sans-serif`;
  const fontSize = toPx(body?.fontSize);
  if (fontSize !== null) token.fontSize = fontSize;

  const borderRadius = toPx(data.rounded?.md);
  if (borderRadius !== null) token.borderRadius = borderRadius;

  const spacingMd = toPx(data.spacing?.md);
  if (spacingMd !== null) {
    token.sizeUnit = Math.round(spacingMd / 4);
    token.sizeStep = 4;
  }

  const canvas = data.colors?.canvas;
  return { token, dark: canvas ? isDarkColor(canvas) : false };
}

export function toAntdTheme(design: DesignTheme | undefined): ThemeConfig | undefined {
  if (!design) return undefined;
  return {
    token: design.token,
    ...(design.dark ? { algorithm: antdTheme.darkAlgorithm } : {}),
  };
}

function toPx(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// 只支援 hex 色值；canvas 用 rgb()/oklch() 等格式會被視為淺色。
function isDarkColor(hex: string): boolean {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}
