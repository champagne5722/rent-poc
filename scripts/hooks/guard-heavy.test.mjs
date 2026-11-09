// guard-heavy 的測試。執行：node --test scripts/hooks/
// 縫（seam）有兩個：decide(command) 的判斷結果，以及 CLI（標準輸入 JSON 進、結束碼與 stderr 出）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decide } from './guard-heavy.mjs';

const CLI = fileURLToPath(new URL('./guard-heavy.mjs', import.meta.url));

function runCli(payload, env = {}) {
  const base = { ...process.env };
  delete base.CI;
  return spawnSync('node', [CLI], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...base, ...env },
  });
}

const BLOCKED = [
  ['npx vitest run', 'npm test'],
  ['npx vitest run src/lib/foo.test.ts', 'npm test -- '],
  ['vitest run', 'npm test'],
  ['./node_modules/.bin/vitest run', 'npm test'],
  ['npx eslint src', 'npm run lint'],
  ['npx eslint src --max-warnings=10 2>&1 | tail -2', 'npm run lint'],
  ['npx tsc --noEmit', 'npm run typecheck'],
  ['npx next dev', 'scripts/smoke/run-smoke.sh'],
  ['npx next dev --webpack -p 3192', 'scripts/smoke/run-smoke.sh'],
  ['npx next build', 'npm run build'],
  // 串接
  ['cd app && npx vitest run', 'npm test'],
  ['git status; npx eslint src', 'npm run lint'],
  ['npm run lint && npx tsc --noEmit', 'npm run typecheck'],
  ['true || npx vitest run', 'npm test'],
  ['echo start\nnpx vitest run', 'npm test'],
  ['(cd x && npx tsc --noEmit)', 'npm run typecheck'],
  ['echo $(npx tsc --noEmit)', 'npm run typecheck'],
  // 前綴與包裝
  ['FOO=1 npx vitest run', 'npm test'],
  ['time npx vitest run', 'npm test'],
  ['nice -n 5 npx eslint src', 'npm run lint'],
  ['env NODE_ENV=test npx vitest run', 'npm test'],
  ['npx --yes tsc --noEmit', 'npm run typecheck'],
  ['npx vitest@latest run', 'npm test'],
  ['npm exec vitest run', 'npm test'],
  ['bash -c "npx vitest run"', 'npm test'],
  ["sh -c 'cd x && npx eslint src'", 'npm run lint'],
  ['node node_modules/vitest/vitest.mjs run', 'npm test'],
];

for (const [command, hint] of BLOCKED) {
  test(`擋下：${JSON.stringify(command)}`, () => {
    const result = decide(command);
    assert.equal(result.block, true);
    assert.ok(result.message.includes(hint), `訊息要包含 ${hint}，實際：${result.message}`);
  });
}

const ALLOWED = [
  // 經排程
  'scripts/heavy.sh test npx vitest run',
  './scripts/heavy.sh lint npx eslint src',
  'HEAVY_COST=4 scripts/heavy.sh t npx vitest run',
  'bash scripts/heavy.sh t npx tsc --noEmit',
  'scripts/heavy.sh smoke scripts/smoke/run-smoke.sh 3192 smoke.mjs',
  // 過渡期：repo 外的排程腳本
  '/Users/someone/rent-poc-notes/scripts/heavy.sh t-1 npx vitest run src/lib',
  'zsh /Users/someone/rent-poc-notes/scripts/verify.sh /wt branch --no-main',
  '/Users/someone/rent-poc-notes/scripts/verify.sh /wt branch',
  // npm script
  'npm test',
  'npm test -- src/lib/foo.test.ts',
  'npm run lint',
  'npm run typecheck',
  'npm run verify',
  'npm run build',
  'npm run test:scripts',
  // 只是提到這些字
  'git commit -m "修 vitest 設定"',
  'git commit -m "npx vitest run 改成 npm test && npx eslint src"',
  'grep -r vitest .',
  'rg "next build" docs',
  'cat vitest.config.ts',
  'cat package.json | grep tsc',
  'sed -n 1,20p eslint.config.mjs',
  'echo "npx vitest run"',
  "echo 'npx tsc --noEmit' > note.txt",
  'git commit -m "$(cat <<\'EOF\'\n修 vitest 設定\nnpx vitest run 要改成 npm test\nEOF\n)"',
  'ls scripts # npx vitest run',
  // 不是重命令
  'npx next typegen',
  'npx next --version',
  'npx prettier --check .',
  'npm install',
  'node scripts/migrate.mjs',
  'git status --short',
  '',
];

for (const command of ALLOWED) {
  test(`放行：${JSON.stringify(command)}`, () => {
    assert.deepEqual(decide(command), { block: false });
  });
}

test('訊息寫出被擋的命令', () => {
  const result = decide('git status; npx eslint src');
  assert.ok(result.message.includes('npx eslint src'));
});

test('多個重命令時回報第一個', () => {
  const result = decide('npx tsc --noEmit && npx vitest run');
  assert.ok(result.message.includes('npm run typecheck'));
});

test('CLI：直接執行 vitest 時結束碼 2，stderr 有正確的命令', () => {
  const r = runCli({ tool_name: 'Bash', tool_input: { command: 'npx vitest run' } });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('npm test'));
});

test('CLI：經排程的命令結束碼 0 且沒有輸出', () => {
  const r = runCli({ tool_name: 'Bash', tool_input: { command: 'scripts/heavy.sh t npx vitest run' } });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('CLI：不是 Bash 工具時放行', () => {
  const r = runCli({ tool_name: 'Read', tool_input: { file_path: 'vitest.config.ts' } });
  assert.equal(r.status, 0);
});

test('CLI：CI=true 時放行', () => {
  const r = runCli({ tool_name: 'Bash', tool_input: { command: 'npx vitest run' } }, { CI: 'true' });
  assert.equal(r.status, 0);
});

test('CLI：輸入不是合法 JSON 時放行', () => {
  const r = runCli('not json');
  assert.equal(r.status, 0);
});

test('CLI：沒有命令欄位時放行', () => {
  const r = runCli({ tool_name: 'Bash', tool_input: {} });
  assert.equal(r.status, 0);
});
