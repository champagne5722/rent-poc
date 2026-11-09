import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildObjectKey, createFileStores, getFileStore, readFileStoreConfig } from './index';
import type { ObjectBucket } from './gcs-file-store';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

const bytes = (s: string) => new TextEncoder().encode(s);

describe('readFileStoreConfig', () => {
  it('沒設 FILE_STORE 時用本機，根目錄在 data/files', () => {
    expect(readFileStoreConfig({}, '/app/data')).toEqual({ mode: 'local', root: path.join('/app/data', 'files') });
  });

  it('gcs 模式讀兩個 bucket 名稱', () => {
    expect(readFileStoreConfig({ FILE_STORE: 'gcs', GCS_BUCKET_SIGNED: 'b-signed', GCS_BUCKET_GENERAL: 'b-gen' })).toEqual({
      mode: 'gcs',
      buckets: { 'signed-document': 'b-signed', general: 'b-gen' },
    });
  });

  it('gcs 模式缺 bucket 設定時馬上丟錯並列出缺哪個', () => {
    expect(() => readFileStoreConfig({ FILE_STORE: 'gcs', GCS_BUCKET_SIGNED: 'b' })).toThrow('GCS_BUCKET_GENERAL');
  });

  it('未知的 FILE_STORE 值丟錯', () => {
    expect(() => readFileStoreConfig({ FILE_STORE: 's3' })).toThrow('FILE_STORE');
  });
});

describe('createFileStores', () => {
  it('本機模式：不同用途放在不同子目錄，互相讀不到', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-stores-'));
    roots.push(root);
    const get = createFileStores({ mode: 'local', root });
    const key = buildObjectKey('01ORG', 'x', 'a.pdf');
    await get('general').write(key, bytes('一般'), { contentType: 'application/pdf' });
    expect(await get('general').exists(key)).toBe(true);
    expect(await get('signed-document').exists(key)).toBe(false);
  });

  it('Cloud Storage 模式：每個用途開自己的 bucket，且只開一次', async () => {
    const opened: string[] = [];
    const objects = new Map<string, Uint8Array>();
    const openBucket = async (name: string): Promise<ObjectBucket> => {
      opened.push(name);
      return {
        save: async (n, b) => void objects.set(`${name}/${n}`, b),
        download: async (n) => {
          const found = objects.get(`${name}/${n}`);
          if (!found) throw Object.assign(new Error('nf'), { code: 404 });
          return found;
        },
        exists: async (n) => objects.has(`${name}/${n}`),
      };
    };
    const get = createFileStores(
      { mode: 'gcs', buckets: { 'signed-document': 'b-signed', general: 'b-gen' } },
      { openBucket },
    );
    const key = buildObjectKey('01ORG', 'x', 'a.pdf');
    expect(opened).toEqual([]); // 還沒用到就不連線
    await get('signed-document').write(key, bytes('1'), { contentType: 'application/pdf' });
    await get('signed-document').write(key, bytes('2'), { contentType: 'application/pdf' });
    await get('general').write(key, bytes('3'), { contentType: 'application/pdf' });
    expect(opened).toEqual(['b-signed', 'b-gen']);
    expect(await get('signed-document').exists(key)).toBe(true);
    expect([...objects.keys()].sort()).toEqual(['b-gen/org/01ORG/x/a.pdf', 'b-signed/org/01ORG/x/a.pdf']);
  });
});

describe('getFileStore', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('取得 store 時不讀環境變數：設定有誤也不會讓匯入模組失敗，第一次讀寫才丟錯', async () => {
    vi.stubEnv('FILE_STORE', 'gcs');
    vi.stubEnv('GCS_BUCKET_SIGNED', '');
    vi.stubEnv('GCS_BUCKET_GENERAL', '');
    const store = getFileStore('general');
    await expect(store.exists(buildObjectKey('01ORG', 'x', 'a.pdf'))).rejects.toThrow('GCS_BUCKET_SIGNED');
  });
});

describe('Cloud Storage 連線', () => {
  it('第一次開 bucket 失敗不快取，下一次呼叫重試', async () => {
    let attempts = 0;
    const openBucket = async (): Promise<ObjectBucket> => {
      if (++attempts === 1) throw new Error('SDK 載入失敗');
      return { save: async () => {}, download: async () => new Uint8Array(), exists: async () => true };
    };
    const get = createFileStores({ mode: 'gcs', buckets: { 'signed-document': 'b1', general: 'b2' } }, { openBucket });
    const key = buildObjectKey('01ORG', 'x', 'a.pdf');
    await expect(get('general').exists(key)).rejects.toThrow('SDK 載入失敗');
    expect(await get('general').exists(key)).toBe(true);
    expect(attempts).toBe(2);
  });
});
