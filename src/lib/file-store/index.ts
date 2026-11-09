import path from 'node:path';
import { DATA_DIR } from '../db';
import type { FileStore } from './file-store';
import { createGcsFileStore, createSdkBucket, type ObjectBucket } from './gcs-file-store';
import { createLocalFileStore } from './local-file-store';
import type { FilePurpose } from './object-key';

// FileStore 的組裝處（MIL-87）：依環境變數選 adapter，依用途選 bucket。呼叫端只做
//   const store = getFileStore('general');
//   const key = buildObjectKey(orgId, 'transcripts', fileName);
//   await store.write(key, bytes, { contentType: 'application/pdf' });
// 並把 key 與 SHA-256 存進自己的表。key 一律含 org_id（見 object-key.ts）。
//
// 環境變數：
// - FILE_STORE：local（預設）或 gcs。
// - GCS_BUCKET_SIGNED：signed-document 用途的 bucket。
// - GCS_BUCKET_GENERAL：general 用途的 bucket。
// 設定步驟與權限見 docs/deployment.md。

export { sha256Hex } from './file-store';
export type { FileStore, WriteResult } from './file-store';
export { buildObjectKey, FILE_PURPOSES, InvalidObjectKey, parseObjectKey } from './object-key';
export type { FilePurpose, ObjectKey } from './object-key';

const BUCKET_ENV: Record<FilePurpose, string> = {
  'signed-document': 'GCS_BUCKET_SIGNED',
  general: 'GCS_BUCKET_GENERAL',
};

export type FileStoreConfig =
  | { mode: 'local'; root: string }
  | { mode: 'gcs'; buckets: Record<FilePurpose, string> };

/** 讀環境變數。gcs 模式缺 bucket 設定時馬上丟錯，不等到第一次寫檔才發現。 */
export function readFileStoreConfig(
  env: Record<string, string | undefined> = process.env,
  dataDir: string = DATA_DIR,
): FileStoreConfig {
  const mode = env.FILE_STORE?.trim() || 'local';
  if (mode === 'local') return { mode, root: path.join(dataDir, 'files') };
  if (mode !== 'gcs') throw new Error(`FILE_STORE 只能是 local 或 gcs，目前是「${mode}」`);
  const missing = Object.values(BUCKET_ENV).filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new Error(`FILE_STORE=gcs 時必須設定 ${missing.join('、')}`);
  return {
    mode,
    buckets: {
      'signed-document': env[BUCKET_ENV['signed-document']]!.trim(),
      general: env[BUCKET_ENV.general]!.trim(),
    },
  };
}

export interface FileStoreFactoryDeps {
  /** 換掉 Cloud Storage 的連線方式（測試用）。預設用 SDK。 */
  openBucket?: (bucketName: string) => Promise<ObjectBucket>;
}

/** 依設定建出各用途的 FileStore。用途之間完全隔離：本機是不同子目錄，Cloud Storage 是不同 bucket。 */
export function createFileStores(
  config: FileStoreConfig,
  { openBucket = createSdkBucket }: FileStoreFactoryDeps = {},
): (purpose: FilePurpose) => FileStore {
  const cache = new Map<FilePurpose, FileStore>();
  return (purpose) => {
    let store = cache.get(purpose);
    if (!store) {
      store =
        config.mode === 'local'
          ? createLocalFileStore(path.join(config.root, purpose))
          : createGcsFileStore(lazyBucket(() => openBucket(config.buckets[purpose])));
      cache.set(purpose, store);
    }
    return store;
  };
}

// SDK 在第一次用到時才載入與建立，之後共用同一個連線
function lazyBucket(open: () => Promise<ObjectBucket>): ObjectBucket {
  let opened: Promise<ObjectBucket> | undefined;
  const bucket = () => (opened ??= open());
  return {
    save: async (name, bytes, meta) => (await bucket()).save(name, bytes, meta),
    download: async (name) => (await bucket()).download(name),
    exists: async (name) => (await bucket()).exists(name),
  };
}

let defaultFactory: ((purpose: FilePurpose) => FileStore) | undefined;

/** 目前環境的 FileStore。第一次呼叫時讀環境變數。 */
export function getFileStore(purpose: FilePurpose): FileStore {
  if (!defaultFactory) {
    if (process.env.K_SERVICE && !process.env.FILE_STORE) {
      console.warn('[file-store] 在 Cloud Run 上沒有設定 FILE_STORE，檔案存在實例的本機磁碟，換實例就會遺失');
    }
    defaultFactory = createFileStores(readFileStoreConfig());
  }
  return defaultFactory(purpose);
}
