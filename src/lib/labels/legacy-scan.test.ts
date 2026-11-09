import { describe, expect, it } from 'vitest';
import { scanSource } from './legacy-scan';

// 掃描器自己的行為（MIL-122 AC7、AC8）。測資的舊用詞都在字串裡，所以本檔屬測試檔，不被 lint 掃描。

describe('scanSource：只抓介面字串裡的舊用詞', () => {
  it.each([
    ['字串字面值', `const a = '甲方（房東）';`, '房東'],
    ['雙引號字串', `const a = "乙方（租客）";`, '租客'],
    ['樣板字串', 'const a = `共 ${n} 位房客`;', '房客'],
    ['樣板字串開頭', 'const a = `房東：${n}`;', '房東'],
    ['JSX 文字', `const a = <p>修繕責任預設出租方</p>;`, '出租方'],
    ['JSX 屬性字串', `const a = <Form label="承租方姓名" />;`, '承租方'],
    ['物件鍵值', `const a = { landlord: '業主' };`, '業主'],
  ])('%s', (_name, code, term) => {
    const hits = scanSource('src/x.tsx', code);
    expect(hits.map((h) => h.term)).toEqual([term]);
  });

  it.each([
    ['行註解', `// 房東視角\nconst a = 1;`],
    ['區塊註解', `/* 租客不進系統 */ const a = 1;`],
    ['JSDoc', `/** 房東按了才會動 */\nexport const a = 1;`],
    ['JSX 註解', `const a = <div>{/* 房東 */}</div>;`],
    ['識別字', `const landlord房東 = tenant租客Name;`],
    ['執業主體含業主子字串', `const a = '執業主體';`],
  ])('不抓：%s', (_name, code) => {
    expect(scanSource('src/x.tsx', code)).toEqual([]);
  });

  it('LEGACY_TERMS 本身不掃', () => {
    expect(scanSource('src/x.ts', `export const LEGACY_TERMS = { everywhere: ['房東'] };`)).toEqual([]);
  });

  it('標記 legacy-term-ok 的字串略過，標記在同一行或上一行', () => {
    expect(scanSource('src/x.ts', `const a = '房東'; // legacy-term-ok: 引用法條`)).toEqual([]);
    expect(scanSource('src/x.ts', `// legacy-term-ok: 法定文件名\nconst a = '租客';`)).toEqual([]);
    expect(scanSource('src/x.ts', `// legacy-term-ok: x\n\nconst a = '租客';`)).toHaveLength(1);
  });

  it('回報行號與檔名', () => {
    const [hit] = scanSource('src/x.ts', `const a = 1;\nconst b = '租客';`);
    expect(hit).toMatchObject({ file: 'src/x.ts', line: 2, term: '租客' });
  });
});

describe('scanSource：「經理人」只在合約 PDF、承租人端與標章禁用', () => {
  const code = `const a = '經理人';`;
  it.each([
    'src/lib/pdf.ts',
    'src/lib/pdf-layout.ts',
    'src/lib/contract-clauses.ts',
    'src/lib/clause-library.ts',
    'src/app/api/contracts/[id]/pdf/route.ts',
    'src/app/lessee/page.tsx',
    'src/lib/registry-rules/exclusivity.ts',
  ])('禁用：%s', (file) => {
    expect(scanSource(file, code).map((h) => h.term)).toEqual(['經理人']);
  });

  it.each(['src/lib/nav.ts', 'src/components/OwnerOverview.tsx', 'src/app/page.tsx'])('不禁用：%s', (file) => {
    expect(scanSource(file, code)).toEqual([]);
  });
});
