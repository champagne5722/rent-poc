// 把段碼表 seed 轉成載入 `registry` 兩張參照表的 SQL。決議見 ADR-0025 決議 1、2。
// migration 0031 由 `scripts/registry/seed-to-migration.mjs` 呼叫這支產出，不手改。
//
// 這個檔案也由 Node 直接執行（型別剝除），所以只用可剝除的 TypeScript 語法，且不得有執行期的相對匯入。

import type { SectionCodeSeed } from './types';

/** 一個 INSERT 敘述最多放幾列。列太多會讓單一敘述過大，拆開也讓季度更新的 diff 好讀。 */
const ROWS_PER_STATEMENT = 1000;

function quote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function insert(table: string, columns: string[], rows: string[]): string {
  const chunks: string[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    chunks.push(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${rows.slice(i, i + ROWS_PER_STATEMENT).join(',\n')};\n`,
    );
  }
  return chunks.join('\n');
}

export function seedToSql(seed: SectionCodeSeed): string {
  const cityName = new Map(seed.cities.map((c) => [c.code, c.name]));
  const areaRows = seed.towns.map((t) => {
    const city = cityName.get(t.cityCode);
    if (city === undefined) throw new Error(`鄉鎮市區 ${t.cityCode}${t.code} 找不到縣市`);
    return `(${quote(t.cityCode)}, ${quote(t.code)}, ${quote(city)}, ${quote(t.name)})`;
  });
  const sectionRows = seed.sections.map(
    (s) =>
      `(${quote(s.cityCode)}, ${quote(s.townCode)}, ${quote(s.code)}, ${quote(s.name)}, ${quote(s.subName)}, ` +
      `${quote(`{${s.aliasTownCodes.join(',')}}`)}, ${s.canceled})`,
  );

  return [
    '-- 段碼表與行政區參照表的資料（MIL-143，ADR-0025 決議 1、2）。由腳本產出，不手改：',
    '--   node scripts/registry/seed-to-migration.mjs',
    `-- 來源：${seed.source.sectionCsvUrl}`,
    `--       ${seed.source.areaCsvUrl}`,
    `-- 下載日期：${seed.source.downloadedOn}`,
    `-- 縣市 ${seed.cities.length}、鄉鎮市區 ${seed.towns.length}、段 ${seed.sections.length}`,
    '',
    insert('registry.areas', ['city_code', 'town_code', 'city_name', 'town_name'], areaRows),
    insert(
      'registry.sections',
      ['city_code', 'town_code', 'code', 'name', 'sub_name', 'alias_town_codes', 'canceled'],
      sectionRows,
    ),
  ].join('\n');
}
