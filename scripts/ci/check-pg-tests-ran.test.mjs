import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, listPgTestFiles } from './check-pg-tests-ran.mjs';

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
