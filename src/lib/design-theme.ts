import { parse as parseYaml } from 'yaml';
import { theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';

// server component 不能把函式（algorithm）傳給 client component，
// 所以 parse 結果維持可序列化，darkAlgorithm 由 client 端的 toAntdTheme 掛上。
export interface DesignTheme {
  /** antd Seed Token 與少數派生 token（字級、行高、圓角）。 */
  token: Record<string, string | number>;
  /** 元件層 token，原樣放進 antd 的 theme.components。 */
  components: Record<string, Record<string, string | number>>;
  /** 給全域 CSS 引用的 CSS 變數，例如 --color-canvas、--type-body-size。 */
  cssVars: Record<string, string>;
  /** 解析時略過的欄位。載入端把它們記成 error，不擋啟動。 */
  warnings: string[];
  dark: boolean;
}

export interface DesignTypographyLevel {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: number | string;
  lineHeight?: number | string;
}

export interface DesignFrontMatter {
  name?: string;
  description?: string;
  colors?: Record<string, string>;
  typography?: Record<string, DesignTypographyLevel>;
  rounded?: Record<string, string>;
  spacing?: Record<string, string>;
  components?: Record<string, Record<string, string | number>>;
}

const FRONT_MATTER_PATTERN = /^---\n([\s\S]*?)\n---/;

/** 一個設計色可以餵給多個 antd seed。hairline 同時是分隔線色與卡片邊框色。 */
const COLOR_SEED_MAP: Record<string, string | string[]> = {
  primary: 'colorPrimary',
  'primary-hover': 'colorPrimaryHover',
  'on-primary': 'colorTextLightSolid',
  ink: 'colorText',
  'ink-muted': 'colorTextSecondary',
  'ink-subtle': 'colorTextTertiary',
  canvas: 'colorBgLayout',
  'surface-1': 'colorBgContainer',
  'surface-2': 'colorBgElevated',
  hairline: ['colorSplit', 'colorBorderSecondary'],
  'hairline-strong': 'colorBorder',
  'semantic-success': 'colorSuccess',
  'semantic-error': 'colorError',
  'semantic-warning': 'colorWarning',
  'semantic-info': 'colorInfo',
};

/**
 * 字階的名稱對應到 antd 的字級 token。
 * 頁面標題與區段標題用 Typography.Title 的 level 4 與 5，所以映射到 Heading4 與 Heading5。
 */
const TYPE_SCALE_MAP: Record<string, { size: string[]; lineHeight: string[] }> = {
  'page-title': { size: ['fontSizeHeading4'], lineHeight: ['lineHeightHeading4'] },
  'section-title': { size: ['fontSizeHeading5', 'fontSizeLG'], lineHeight: ['lineHeightHeading5', 'lineHeightLG'] },
  body: { size: ['fontSize'], lineHeight: ['lineHeight'] },
  caption: { size: ['fontSizeSM'], lineHeight: ['lineHeightSM'] },
};

const CSS_NAME_PATTERN = /^[a-z0-9-]+$/;
const REFERENCE_PATTERN = /\{([a-z0-9.-]+)\}/g;
const PX_PATTERN = /^-?\d+(\.\d+)?px$/;
const UNSAFE_CSS_VALUE = /[;{}<>]/;

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
  const cssVars: DesignTheme['cssVars'] = {};
  const warnings: string[] = [];

  for (const [designKey, seedKeys] of Object.entries(COLOR_SEED_MAP)) {
    const value = data.colors?.[designKey];
    if (!value) continue;
    for (const seedKey of [seedKeys].flat()) token[seedKey] = value;
  }

  const body = data.typography?.body;
  if (body?.fontFamily) {
    // 含逗號代表已是完整字體堆疊（含 fallback），原樣使用；單一字體名才補引號與 sans-serif。
    token.fontFamily = body.fontFamily.includes(',')
      ? body.fontFamily
      : `"${body.fontFamily}", sans-serif`;
    cssVars['--font-family'] = token.fontFamily;
  }
  // 沒寫字體時完全交給 antd 的預設堆疊，不輸出變數。
  // 不能在這裡讀 antd 的 theme.defaultSeed：server component 載入的 antd 沒有它，會讓整份解析失敗。

  mapTypeScale(data.typography, token, cssVars);

  const borderRadius = toPx(data.rounded?.md);
  if (borderRadius !== null) token.borderRadius = borderRadius;
  const radiusSM = toPx(data.rounded?.sm);
  if (radiusSM !== null) token.borderRadiusSM = radiusSM;
  const radiusLG = toPx(data.rounded?.lg);
  if (radiusLG !== null) token.borderRadiusLG = radiusLG;

  const spacingMd = toPx(data.spacing?.md);
  if (spacingMd !== null) {
    token.sizeUnit = Math.round(spacingMd / 4);
    token.sizeStep = 4;
  }

  addCssVars(cssVars, '--color-', data.colors);
  addCssVars(cssVars, '--space-', data.spacing);
  addCssVars(cssVars, '--radius-', data.rounded);

  const components = mapComponents(data, warnings);

  const canvas = data.colors?.canvas;
  return { token, components, cssVars, warnings, dark: canvas ? isDarkColor(canvas) : false };
}

export function toAntdTheme(design: DesignTheme | undefined): ThemeConfig | undefined {
  if (!design) return undefined;
  return {
    token: design.token,
    ...(Object.keys(design.components).length > 0 ? { components: design.components } : {}),
    ...(design.dark ? { algorithm: antdTheme.darkAlgorithm } : {}),
  };
}

/**
 * 把 cssVars 組成 `:root{...}` 規則，由 layout 放進 <style>。
 * 含 `;{}<>` 的值會被略過，避免 DESIGN.md 的值跳出宣告，插入其他規則或標籤。
 */
export function designCssText(design: DesignTheme | undefined): string {
  if (!design) return '';
  const declarations = Object.entries(design.cssVars)
    .filter(([name, value]) => /^--[a-z0-9-]+$/.test(name) && !UNSAFE_CSS_VALUE.test(value))
    .map(([name, value]) => `${name}:${value};`);
  return declarations.length > 0 ? `:root{${declarations.join('')}}` : '';
}

function mapTypeScale(
  typography: DesignFrontMatter['typography'],
  token: DesignTheme['token'],
  cssVars: DesignTheme['cssVars'],
): void {
  for (const [level, spec] of Object.entries(typography ?? {})) {
    if (!spec || typeof spec !== 'object' || !CSS_NAME_PATTERN.test(level)) continue;
    const size = toPx(spec.fontSize);
    const lineHeight = toLineHeight(spec.lineHeight);
    const weight = toWeight(spec.fontWeight);
    const mapping = TYPE_SCALE_MAP[level];

    if (size !== null) {
      cssVars[`--type-${level}-size`] = `${size}px`;
      for (const key of mapping?.size ?? []) token[key] = size;
    }
    if (lineHeight !== null) {
      cssVars[`--type-${level}-line-height`] = String(lineHeight);
      for (const key of mapping?.lineHeight ?? []) token[key] = lineHeight;
    }
    if (weight !== null) {
      cssVars[`--type-${level}-weight`] = String(weight);
      // antd 的標題字重只有一個 token（fontWeightStrong），以頁面標題為準。
      if (level === 'page-title') token.fontWeightStrong = weight;
    }
  }
}

function addCssVars(
  cssVars: DesignTheme['cssVars'],
  prefix: string,
  scale: Record<string, string> | undefined,
): void {
  for (const [name, value] of Object.entries(scale ?? {})) {
    if (!CSS_NAME_PATTERN.test(name) || typeof value !== 'string') continue;
    cssVars[`${prefix}${name}`] = value;
  }
}

function mapComponents(data: DesignFrontMatter, warnings: string[]): DesignTheme['components'] {
  const result: DesignTheme['components'] = {};
  for (const [component, tokens] of Object.entries(data.components ?? {})) {
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
      warnings.push(`components.${component} 不是 token 物件，已略過`);
      continue;
    }
    const mapped: Record<string, string | number> = {};
    for (const [name, raw] of Object.entries(tokens)) {
      const value = resolveComponentValue(raw, data);
      if (value === null) {
        warnings.push(`components.${component}.${name} 的值無法解析（${String(raw)}），已略過`);
        continue;
      }
      mapped[name] = value;
    }
    if (Object.keys(mapped).length > 0) result[component] = mapped;
  }
  return result;
}

/** 解析 `{colors.canvas}` 這類參照。參照找不到、或值不是字串與數字時回 null。 */
function resolveComponentValue(raw: unknown, data: DesignFrontMatter): string | number | null {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return null;

  let unresolved = false;
  const resolved = raw.replace(REFERENCE_PATTERN, (_, path: string) => {
    const found = lookup(data, path);
    if (found === null) unresolved = true;
    return found ?? '';
  });
  if (unresolved) return null;
  return PX_PATTERN.test(resolved) ? parseFloat(resolved) : resolved;
}

function lookup(data: unknown, path: string): string | null {
  let node: unknown = data;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'string' || typeof node === 'number' ? String(node) : null;
}

function toPx(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toLineHeight(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toWeight(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

// 只支援 hex 色值；canvas 用 rgb()/oklch() 等格式會被視為淺色。
function isDarkColor(hex: string): boolean {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}
