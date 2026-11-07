// 容器進入點（ADR-0011）：還原 SQLite、啟動 Litestream 複寫、啟動 Next.js。
//
// Cloud Run 的 max-instances 能短暫超過，換版時新舊實例會並存。多個程序複寫到同一個路徑可能讓
// 複寫資料無法還原，所以每次啟動都寫到新路徑 runs/<時間>-<亂數>，再用 CURRENT 物件指向最新一份。
// 並存期間寫入舊實例的資料會遺失。demo 接受這個代價，PostgreSQL 遷移後整個檔案移除。
//
// 只在新路徑確定能還原之後才移動 CURRENT。實例剛啟動就崩潰時，CURRENT 仍指向上一份完整資料。
//
// 環境變數：
//   LITESTREAM_GCS_BUCKET  複寫到這個 Cloud Storage bucket（Cloud Run 用）
//   LITESTREAM_FILE_ROOT   複寫到這個本機資料夾（冒煙測試用）
//   兩個都沒有時不複寫，資料隨容器消失。
//   LITESTREAM_BIN         Litestream 執行檔路徑，預設 litestream

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const APP_DIR = process.cwd();
const DB_PATH = path.join(APP_DIR, 'data', 'rent-poc.db');
const LITESTREAM = process.env.LITESTREAM_BIN ?? 'litestream';
const VERIFY_INTERVAL_MS = 3_000;
// Cloud Run 在 SIGTERM 後 10 秒送 SIGKILL，兩段等待加總要低於 10 秒
const SERVER_STOP_TIMEOUT_MS = 3_000;
const LITESTREAM_STOP_TIMEOUT_MS = 6_000;

function log(message) {
  console.log(`[entrypoint] ${message}`);
}

function gcsStore(bucket) {
  const object = 'CURRENT';
  async function token() {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } }
    );
    if (!res.ok) throw new Error(`metadata server 回應 ${res.status}`);
    return (await res.json()).access_token;
  }
  return {
    replicaUrl: (replicaPath) => `gs://${bucket}/${replicaPath}`,
    async readCurrent() {
      const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}?alt=media`, {
        headers: { Authorization: `Bearer ${await token()}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`讀取 CURRENT 回應 ${res.status}`);
      return (await res.text()).trim();
    },
    async writeCurrent(replicaPath) {
      const res = await fetch(
        `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${object}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'text/plain' },
          body: replicaPath,
        }
      );
      if (!res.ok) throw new Error(`寫入 CURRENT 回應 ${res.status}`);
    },
  };
}

function fileStore(root) {
  const current = path.join(root, 'CURRENT');
  return {
    replicaUrl: (replicaPath) => `file://${path.join(root, replicaPath)}`,
    readCurrent: async () => (existsSync(current) ? readFileSync(current, 'utf8').trim() : null),
    writeCurrent: async (replicaPath) => writeFileSync(current, replicaPath),
  };
}

function restoreTo(outputPath, replicaUrl) {
  const result = spawnSync(LITESTREAM, ['restore', '-o', outputPath, replicaUrl], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status === 0 && existsSync(outputPath)) return { ok: true };
  return { ok: false, detail: result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}` };
}

// 啟動時讀不到 CURRENT 就結束，讓 Cloud Run 重試。不得當成沒有資料而從空資料庫開始。
async function readCurrentWithRetry(store) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await store.readCurrent();
    } catch (e) {
      if (attempt >= 3) throw e;
      log(`讀取 CURRENT 失敗（第 ${attempt} 次）：${e.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
  }
}

// Litestream 需要資料庫檔案已存在且是 WAL 模式
function ensureDatabaseFile() {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.close();
}

function removeDatabaseFiles(filePath) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(filePath + suffix, { force: true });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function startServer() {
  return spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    stdio: 'inherit',
    env: { ...process.env, HOSTNAME: '0.0.0.0' },
  });
}

async function runWithoutReplication() {
  log('沒有設定 LITESTREAM_GCS_BUCKET 或 LITESTREAM_FILE_ROOT，不複寫，資料隨容器消失');
  const server = startServer();
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.kill('SIGTERM'));
  server.on('exit', (code) => process.exit(code ?? 1));
}

async function runWithReplication(store) {
  const previous = await readCurrentWithRetry(store);
  if (previous) {
    log(`從 ${previous} 還原`);
    const restored = restoreTo(DB_PATH, store.replicaUrl(previous));
    if (!restored.ok) {
      // demo 資料能重建，所以用空資料庫啟動。舊路徑不動，需要時能手動救回。
      log(`還原失敗，改用空資料庫啟動。舊資料仍在 ${previous}：${restored.detail}`);
      removeDatabaseFiles(DB_PATH);
    }
  } else {
    log('沒有 CURRENT，這是第一次啟動');
  }
  ensureDatabaseFile();

  const replicaPath = `runs/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const configPath = path.join(tmpdir(), 'litestream.yml');
  writeFileSync(
    configPath,
    `dbs:\n  - path: ${DB_PATH}\n    replica:\n      url: ${store.replicaUrl(replicaPath)}\n`
  );
  log(`複寫到 ${replicaPath}`);

  const litestream = spawn(LITESTREAM, ['replicate', '-config', configPath], { stdio: 'inherit' });
  const server = startServer();

  let verifyTimer;
  const verifyPath = path.join(tmpdir(), 'litestream-verify.db');
  async function moveCurrentWhenRestorable() {
    removeDatabaseFiles(verifyPath);
    const verified = restoreTo(verifyPath, store.replicaUrl(replicaPath));
    removeDatabaseFiles(verifyPath);
    if (verified.ok) {
      try {
        await store.writeCurrent(replicaPath);
        log(`CURRENT 已指向 ${replicaPath}`);
        return;
      } catch (e) {
        log(`寫入 CURRENT 失敗，稍後重試：${e.message}`);
      }
    }
    verifyTimer = setTimeout(moveCurrentWhenRestorable, VERIFY_INTERVAL_MS);
  }
  verifyTimer = setTimeout(moveCurrentWhenRestorable, VERIFY_INTERVAL_MS);

  let stopping = false;
  // 先停 server 才停 Litestream，最後一筆寫入才進得了最後一次同步
  async function stop(exitCode) {
    if (stopping) return;
    stopping = true;
    clearTimeout(verifyTimer);
    server.kill('SIGTERM');
    await waitForExit(server, SERVER_STOP_TIMEOUT_MS);
    litestream.kill('SIGTERM');
    await waitForExit(litestream, LITESTREAM_STOP_TIMEOUT_MS);
    process.exit(exitCode);
  }

  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(0));
  server.on('exit', (code) => {
    if (!stopping) log(`server 結束，exit ${code}`);
    stop(code ?? 1);
  });
  // 沒有複寫的實例不得繼續服務，否則寫入會無聲遺失
  litestream.on('exit', (code) => {
    if (!stopping) log(`Litestream 結束，exit ${code}`);
    stop(code === 0 ? 1 : (code ?? 1));
  });
  litestream.on('error', (e) => {
    log(`Litestream 無法啟動：${e.message}`);
    stop(1);
  });
}

const { LITESTREAM_GCS_BUCKET: bucket, LITESTREAM_FILE_ROOT: fileRoot } = process.env;
if (bucket) await runWithReplication(gcsStore(bucket));
else if (fileRoot) await runWithReplication(fileStore(fileRoot));
else await runWithoutReplication();
