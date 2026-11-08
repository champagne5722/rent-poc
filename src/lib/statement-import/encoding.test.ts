import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeStatement, detectEncoding } from './encoding';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));

describe('detectEncoding', () => {
  it('UTF-8 檔案', () => {
    expect(detectEncoding(fixture('basic-utf8.csv'))).toBe('utf-8');
  });
  it('Big5 檔案', () => {
    expect(detectEncoding(fixture('basic-big5.csv'))).toBe('big5');
  });
  it('帶 BOM 的 UTF-8', () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...fixture('basic-utf8.csv')]);
    expect(detectEncoding(bytes)).toBe('utf-8');
  });
  it('純 ASCII 視為 UTF-8', () => {
    expect(detectEncoding(new TextEncoder().encode('date,amount\n2026-03-05,100\n'))).toBe('utf-8');
  });
  it('空檔案視為 UTF-8', () => {
    expect(detectEncoding(new Uint8Array())).toBe('utf-8');
  });
});

describe('decodeStatement', () => {
  it('UTF-8 與 Big5 解出相同文字', () => {
    const utf8 = decodeStatement(fixture('basic-utf8.csv'));
    const big5 = decodeStatement(fixture('basic-big5.csv'));
    expect(utf8.encoding).toBe('utf-8');
    expect(big5.encoding).toBe('big5');
    expect(big5.text).toBe(utf8.text);
    expect(utf8.text.startsWith('交易日期,摘要')).toBe(true);
  });
  it('去掉 BOM', () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a,b\n')]);
    expect(decodeStatement(bytes).text).toBe('a,b\n');
  });
});
