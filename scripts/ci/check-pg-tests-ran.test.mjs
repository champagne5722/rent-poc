import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, listPgTestFiles, parseArgs } from './check-pg-tests-ran.mjs';

const root = '/repo';
const result = (file, statuses) => ({
  name: `${root}/${file}`,
  status: statuses.includes('failed') ? 'failed' : 'passed',
  assertionResults: statuses.map((status) => ({ status })),
});
const base = { root, databaseUrl: 'postgres://x', min: 3 };
const files = ['src/a.pg.test.ts', 'src/b.pg.test.ts'];

test('全部通過：沒有問題', () => {
  const report = { testResults: [result('src/a.pg.test.ts', ['passed', 'passed']), result('src/b.pg.test.ts', ['passed'])] };
  assert.deepEqual(evaluate({ ...base, report, files }), { problems: [], passed: 3 });
});

test('沒有 TEST_DATABASE_URL：失敗', () => {
  const report = { testResults: [result('src/a.pg.test.ts', ['passed', 'passed']), result('src/b.pg.test.ts', ['passed'])] };
  const { problems } = evaluate({ ...base, databaseUrl: '', report, files });
  assert.match(problems[0], /TEST_DATABASE_URL/);
});

test('整個檔案被跳過（describe.skip 或沒有環境變數）：失敗', () => {
  const report = { testResults: [result('src/a.pg.test.ts', ['passed', 'passed', 'passed']), result('src/b.pg.test.ts', ['skipped', 'skipped'])] };
  const { problems } = evaluate({ ...base, report, files });
  assert.deepEqual(problems, ['src/b.pg.test.ts：沒有任何通過的測試']);
});

test('檔案不在報告裡：失敗', () => {
  const report = { testResults: [result('src/a.pg.test.ts', ['passed', 'passed', 'passed'])] };
  const { problems } = evaluate({ ...base, report, files });
  assert.deepEqual(problems, ['src/b.pg.test.ts：不在報告裡，測試沒有被執行']);
});

test('檔案裡有一個測試被跳過：失敗', () => {
  const report = { testResults: [result('src/a.pg.test.ts', ['passed', 'skipped', 'passed']), result('src/b.pg.test.ts', ['passed'])] };
  const { problems } = evaluate({ ...base, report, files });
  assert.deepEqual(problems, ['src/a.pg.test.ts：有 1 個測試被跳過']);
});

test('有失敗的測試：失敗', () => {
  const report = { testResults: [result('src/a.pg.test.ts', ['passed', 'failed']), result('src/b.pg.test.ts', ['passed'])] };
  assert.ok(evaluate({ ...base, report, files }).problems.includes('src/a.pg.test.ts：有失敗的測試'));
});

test('通過數量低於下限：失敗', () => {
  const report = { testResults: [result('src/a.pg.test.ts', ['passed']), result('src/b.pg.test.ts', ['passed'])] };
  const { problems } = evaluate({ ...base, report, files });
  assert.deepEqual(problems, ['通過的 pg 測試只有 2 個，低於下限 3']);
});

test('專案裡找得到所有 pg 測試檔，包含這張票新增的兩個', () => {
  const found = listPgTestFiles(new URL('../..', import.meta.url).pathname);
  assert.ok(found.includes('src/lib/pg/rls-catalog.pg.test.ts'));
  assert.ok(found.includes('src/lib/pg/rls-penetration.pg.test.ts'));
  assert.ok(found.every((f) => f.endsWith('.pg.test.ts')));
});

// 分片（MIL-228）：每一片一份報告，合併後再檢查。
const shardA = { testResults: [result('src/a.pg.test.ts', ['passed', 'passed'])] };
const shardB = { testResults: [result('src/b.pg.test.ts', ['passed'])] };

test('分片：兩份報告合併後全部通過', () => {
  assert.deepEqual(evaluate({ ...base, reports: [shardA, shardB], files, expectReports: 2 }), { problems: [], passed: 3 });
});

test('分片：其中一片的 pg 測試整組被跳過：失敗', () => {
  const skippedB = { testResults: [result('src/b.pg.test.ts', ['skipped', 'skipped'])] };
  const { problems } = evaluate({ ...base, min: 2, reports: [shardA, skippedB], files, expectReports: 2 });
  assert.deepEqual(problems, ['src/b.pg.test.ts：沒有任何通過的測試']);
});

test('分片：少一份報告：失敗，並指出缺少的檔案', () => {
  const { problems } = evaluate({ ...base, reports: [shardA], files, expectReports: 2 });
  assert.equal(problems[0], '報告有 1 份，預期 2 份，某一片的報告不見了');
  assert.ok(problems.includes('src/b.pg.test.ts：不在報告裡，測試沒有被執行'));
});

test('分片：同一個檔案出現在兩份報告：失敗', () => {
  const { problems } = evaluate({ ...base, reports: [shardA, shardA, shardB], files });
  assert.ok(problems.includes('src/a.pg.test.ts：出現在多份報告裡，分片重疊'));
});

test('沒有指定 --expect-reports：不檢查份數', () => {
  assert.deepEqual(evaluate({ ...base, reports: [shardA, shardB], files }).problems, []);
});

test('命令列：多份報告與旗標，旗標的值不算報告路徑', () => {
  assert.deepEqual(parseArgs(['a.json', 'b.json', '--min', '100', '--expect-reports', '4']), {
    reportPaths: ['a.json', 'b.json'],
    min: 100,
    expectReports: 4,
  });
  assert.deepEqual(parseArgs(['--min', '5', 'a.json']), { reportPaths: ['a.json'], min: 5 });
});
