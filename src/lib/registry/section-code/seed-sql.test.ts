import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import seedJson from './seed.json';
import { seedToSql } from './seed-sql';
import type { SectionCodeSeed } from './types';

const small: SectionCodeSeed = {
  source: { sectionCsvUrl: 'https://example.test/s.csv', areaCsvUrl: 'https://example.test/a.csv', downloadedOn: '2026-11-08' },
  cities: [
    { code: 'F', name: '新北市' },
    { code: 'W', name: '金門縣' },
  ],
  towns: [
    { cityCode: 'F', code: '02', name: '板橋區' },
    { cityCode: 'F', code: '03', name: '三重區' },
    { cityCode: 'W', code: '01', name: '金城鎮' },
  ],
  sections: [
    { cityCode: 'F', townCode: '02', code: '1818', name: '跨越段', subName: '', aliasTownCodes: ['03'], canceled: false },
    { cityCode: 'W', townCode: '01', code: '0009', name: "O'Neil 段", subName: '一小段', aliasTownCodes: [], canceled: true },
  ],
};

describe('seedToSql：把 seed 轉成載入參照表的 SQL', () => {
  const sql = seedToSql(small);

  it('鄉鎮市區列帶縣市名稱', () => {
    expect(sql).toContain("('F', '02', '新北市', '板橋區')");
    expect(sql).toContain("('W', '01', '金門縣', '金城鎮')");
  });

  it('段列帶別名行政區與註銷旗標，單引號跳脫', () => {
    expect(sql).toContain("('F', '02', '1818', '跨越段', '', '{03}', false)");
    expect(sql).toContain("('W', '01', '0009', 'O''Neil 段', '一小段', '{}', true)");
  });

  it('同一份 seed 每次產出完全相同的文字', () => {
    expect(seedToSql(small)).toBe(sql);
  });

  it('每 1000 列拆成一個 INSERT 敘述', () => {
    const many: SectionCodeSeed = {
      ...small,
      sections: Array.from({ length: 2500 }, (_, i) => ({
        cityCode: 'F',
        townCode: '02',
        code: String(i).padStart(4, '0'),
        name: `段${i}`,
        subName: '',
        aliasTownCodes: [],
        canceled: false,
      })),
    };
    expect(seedToSql(many).match(/INSERT INTO registry\.sections/g)).toHaveLength(3);
  });
});

describe('0031 migration 與 seed.json 同步', () => {
  it('db/migrations/0031_section_code_data.sql 等於 seed.json 產出的 SQL（改了 seed 必須重新產出）', () => {
    const file = readFileSync(new URL('../../../../db/migrations/0031_section_code_data.sql', import.meta.url), 'utf8');
    expect(file).toBe(seedToSql(seedJson as SectionCodeSeed));
  });
});
