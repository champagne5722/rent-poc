// 把地政司的全國段碼表 CSV 與縣市鄉鎮市區編碼表 CSV 轉成 seed 檔（JSON）。
// 只讀 CSV、只寫 seed 檔，不碰資料庫。決議見 ADR-0025。
//
// 用法：
//   node scripts/registry/import-section-codes.mjs \
//     --section <全國段碼表.csv> --area <縣市鄉鎮市區編碼表.csv> \
//     --downloaded-on 2026-11-08 [--out src/lib/registry/section-code/seed.json]
//
// CSV 請先下載到 repo 以外的新目錄，來源網址見
// docs/research/asset-mgmt-platform/research_notes/mil-63-section-code-and-sublet-meter.md。

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildSeed, serializeSeed } from '../../src/lib/registry/section-code/build-seed.ts';

const SECTION_CSV_URL =
  'https://lisp.land.moi.gov.tw/MMS/Handle/DownloadQuerySection.ashx?DownloadType=csv&CountyCode=&OfficeCode=&TownCode=';
const AREA_CSV_URL = 'https://lisp.land.moi.gov.tw/MMS/Handle/DownloadQueryArea.ashx?CountyCode=';

const { values } = parseArgs({
  options: {
    section: { type: 'string' },
    area: { type: 'string' },
    'downloaded-on': { type: 'string' },
    out: { type: 'string', default: 'src/lib/registry/section-code/seed.json' },
  },
});

if (!values.section || !values.area || !/^\d{4}-\d{2}-\d{2}$/.test(values['downloaded-on'] ?? '')) {
  console.error('必須帶 --section、--area 與 --downloaded-on YYYY-MM-DD');
  process.exit(1);
}

const seed = buildSeed({
  sectionCsv: readFileSync(values.section, 'utf8'),
  areaCsv: readFileSync(values.area, 'utf8'),
  source: { sectionCsvUrl: SECTION_CSV_URL, areaCsvUrl: AREA_CSV_URL, downloadedOn: values['downloaded-on'] },
});
writeFileSync(values.out, serializeSeed(seed));
console.log(`已寫入 ${values.out}：縣市 ${seed.cities.length}、鄉鎮市區 ${seed.towns.length}、段 ${seed.sections.length}`);
