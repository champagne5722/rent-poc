// 把 seed 檔轉成載入段碼參照表的 migration（0031）。只讀 seed、只寫 SQL，不碰資料庫。決議見 ADR-0025。
//
// 用法：
//   node scripts/registry/seed-to-migration.mjs \
//     [--seed src/lib/registry/section-code/seed.json] [--out db/migrations/0031_section_code_data.sql]
//
// 每季更新時，先用 import-section-codes.mjs 產新 seed，再開新編號的 migration 放差異（參照表只增改，不刪列）。

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { seedToSql } from '../../src/lib/registry/section-code/seed-sql.ts';

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: 'src/lib/registry/section-code/seed.json' },
    out: { type: 'string', default: 'db/migrations/0031_section_code_data.sql' },
  },
});

const seed = JSON.parse(readFileSync(values.seed, 'utf8'));
const sql = seedToSql(seed);
writeFileSync(values.out, sql);
console.log(`已寫入 ${values.out}：${(Buffer.byteLength(sql) / 1024 / 1024).toFixed(2)} MB`);
