// 確認真實 PostgreSQL 的測試真的跑到了（MIL-89，驗收條件 13、14）。
//
// 為什麼：`*.pg.test.ts` 在沒有 TEST_DATABASE_URL 時整組靜默跳過，vitest 仍然回傳 0。
// CI 少設環境變數、或有人把 describe 改成 skip，結果都是綠燈，隔離檢查卻沒有跑。
//
// 規則（全部成立才通過）：
// 1. 環境變數 TEST_DATABASE_URL 有值。
// 2. 專案裡每一個 `*.pg.test.ts` 都出現在 vitest 的 JSON 報告裡。
// 3. 每個檔案至少 1 個測試通過，而且沒有任何跳過或待辦的測試。
// 4. 整體通過的 pg 測試數量不低於 --min（預設 100）。
//
// 用法：
//   vitest run --reporter=default --reporter=json --outputFile.json=vitest-report.json
//   node scripts/ci/check-pg-tests-ran.mjs vitest-report.json [--min 100]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PG_TEST_SUFFIX = '.pg.test.ts';

/** 列出 root 底下所有 pg 測試檔，回傳相對於 root 的路徑（用 / 分隔）。 */
export function listPgTestFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(PG_TEST_SUFFIX)) found.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'src'));
  return found.sort();
}

/**
 * 依 vitest 的 JSON 報告檢查。回傳 { problems, passed }。problems 是空陣列代表通過。
 * report.testResults 的每一項有 name（檔案絕對路徑）與 assertionResults（每個測試的 status）。
 */
export function evaluate({ report, files, root, databaseUrl, min }) {
  const problems = [];
  if (!databaseUrl) problems.push('環境變數 TEST_DATABASE_URL 沒有值，pg 測試不會執行');

  const byFile = new Map();
  for (const result of report.testResults ?? []) {
    byFile.set(path.relative(root, result.name).split(path.sep).join('/'), result);
  }

  let passed = 0;
  for (const file of files) {
    const result = byFile.get(file);
    if (!result) {
      problems.push(`${file}：不在報告裡，測試沒有被執行`);
      continue;
    }
    const tests = result.assertionResults ?? [];
    const count = (status) => tests.filter((t) => t.status === status).length;
    const ok = count('passed');
    const notRun = tests.length - ok - count('failed');
    passed += ok;
    if (result.status === 'failed' || count('failed') > 0) problems.push(`${file}：有失敗的測試`);
    if (ok === 0) problems.push(`${file}：沒有任何通過的測試`);
    else if (notRun > 0) problems.push(`${file}：有 ${notRun} 個測試被跳過`);
  }
  if (files.length === 0) problems.push('找不到任何 *.pg.test.ts');
  if (passed < min) problems.push(`通過的 pg 測試只有 ${passed} 個，低於下限 ${min}`);
  return { problems, passed };
}

function main(argv) {
  const reportPath = argv[2];
  if (!reportPath) {
    console.error('用法：node scripts/ci/check-pg-tests-ran.mjs <vitest-report.json> [--min N]');
    return 64;
  }
  const minIndex = argv.indexOf('--min');
  const min = minIndex === -1 ? 100 : Number(argv[minIndex + 1]);
  if (!Number.isInteger(min) || min < 1) {
    console.error('--min 必須是正整數');
    return 64;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const files = listPgTestFiles(root);
  const { problems, passed } = evaluate({ report, files, root, databaseUrl: process.env.TEST_DATABASE_URL, min });
  if (problems.length > 0) {
    console.error('真實 PostgreSQL 的測試檢查失敗：');
    for (const p of problems) console.error(`- ${p}`);
    return 1;
  }
  console.log(`真實 PostgreSQL 的測試檢查通過：${files.length} 個檔案，${passed} 個測試通過，沒有跳過。`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
