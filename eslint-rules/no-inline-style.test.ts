import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import noInlineStyle from './no-inline-style.mjs';

// 規則的外部行為：給一段 JSX 與選項，回報哪些訊息。測試走 ESLint 的 Linter，不碰規則內部（MIL-174、ADR-0090）。

function lint(code: string, options: { allow?: number } = {}, severity: 'error' | 'warn' = 'error') {
  const linter = new Linter();
  return linter.verify(
    code,
    [
      {
        files: ['**/*.jsx'],
        languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { rent: { rules: { 'no-inline-style': noInlineStyle } } },
        rules: { 'rent/no-inline-style': [severity, options] },
      },
    ],
    { filename: 'page.jsx' },
  );
}

describe('rent/no-inline-style', () => {
  it('沒有 style 屬性時沒有訊息', () => {
    expect(lint('const a = <div className="x"><Button type="primary" /></div>;')).toEqual([]);
  });

  it('DOM 元素與 antd 元件的 style 屬性都回報', () => {
    const messages = lint('const a = <div style={{ color: "red" }}><Space style={{ width: "100%" }} /></div>;');
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.severity === 2)).toBe(true);
    expect(messages[0].message).toContain('inline style');
  });

  it('style 引用變數也回報，只有名稱叫 style 的屬性算', () => {
    const messages = lint('const s = {}; const a = <div style={s} styles={{ root: {} }} data-style="x" />;');
    expect(messages).toHaveLength(1);
  });

  it('allow 是既有違規的額度：額度內不回報，超過的才回報', () => {
    const code = 'const a = <div><i style={{}} /><i style={{}} /><i style={{}} /></div>;';
    expect(lint(code, { allow: 3 })).toEqual([]);
    const over = lint(code, { allow: 2 });
    expect(over).toHaveLength(1);
    expect(over[0].line).toBe(1);
  });

  it('既有違規減少時，要求更新基準', () => {
    const messages = lint('const a = <div style={{}} />;', { allow: 4 });
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain('allow');
    expect(messages[0].message).toContain('4');
  });

  it('allow 為 0 且沒有 style 時不要求更新基準', () => {
    expect(lint('const a = <div />;', { allow: 0 })).toEqual([]);
  });

  it('警告等級照設定回報', () => {
    const messages = lint('const a = <div style={{}} />;', {}, 'warn');
    expect(messages).toHaveLength(1);
    expect(messages[0].severity).toBe(1);
  });
});
