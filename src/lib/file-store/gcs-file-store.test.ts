import { describe, expect, it } from 'vitest';
import { describeFileStoreContract } from './file-store.contract';
import { createGcsFileStore, type ObjectBucket } from './gcs-file-store';
import { buildObjectKey } from './object-key';

// 記憶體替身：行為對齊 SDK 的 File（download 找不到丟 code 404，其他失敗丟別的錯誤）。
// 真的 bucket 在 MIL-92 驗證。
class MemoryBucket implements ObjectBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  failWith: Error | null = null;

  async save(name: string, bytes: Uint8Array, meta: { contentType: string }) {
    if (this.failWith) throw this.failWith;
    this.objects.set(name, { bytes: new Uint8Array(bytes), contentType: meta.contentType });
  }
  async download(name: string) {
    if (this.failWith) throw this.failWith;
    const found = this.objects.get(name);
    if (!found) throw Object.assign(new Error(`No such object: ${name}`), { code: 404 });
    return new Uint8Array(found.bytes);
  }
  async exists(name: string) {
    if (this.failWith) throw this.failWith;
    return this.objects.has(name);
  }
  async delete(name: string) {
    if (this.failWith) throw this.failWith;
    this.objects.delete(name);
  }
}

describeFileStoreContract('Cloud Storage（記憶體替身）', () => createGcsFileStore(new MemoryBucket()));

describe('Cloud Storage adapter 專屬行為', () => {
  it('delete 的權限或網路錯誤不吞掉，呼叫端才知道檔案還在', async () => {
    const bucket = new MemoryBucket();
    const store = createGcsFileStore(bucket);
    bucket.failWith = new Error('Permission denied');
    await expect(store.delete(buildObjectKey('01ORG', 'vault', 'a.pdf'))).rejects.toThrow('Permission denied');
  });

  it('物件名稱就是物件 key，contentType 一併送出', async () => {
    const bucket = new MemoryBucket();
    const store = createGcsFileStore(bucket);
    const key = buildObjectKey('01ORG', 'sign-tasks', '01TASK', 'a.pdf');
    await store.write(key, new Uint8Array([1]), { contentType: 'application/pdf' });
    expect([...bucket.objects.keys()]).toEqual(['org/01ORG/sign-tasks/01TASK/a.pdf']);
    expect(bucket.objects.get(key)?.contentType).toBe('application/pdf');
  });

  it('權限或網路錯誤不當成「不存在」', async () => {
    const bucket = new MemoryBucket();
    const store = createGcsFileStore(bucket);
    const key = buildObjectKey('01ORG', 'sign-tasks', '01TASK', 'a.pdf');
    bucket.failWith = Object.assign(new Error('Permission denied'), { code: 403 });
    await expect(store.read(key)).rejects.toThrow('Permission denied');
    await expect(store.exists(key)).rejects.toThrow('Permission denied');
    await expect(store.write(key, new Uint8Array([1]), { contentType: 'application/pdf' })).rejects.toThrow(
      'Permission denied',
    );
  });

  it('不合法的 key 在送到 bucket 前就被擋下', async () => {
    const bucket = new MemoryBucket();
    const store = createGcsFileStore(bucket);
    await expect(store.write('../x' as never, new Uint8Array([1]), { contentType: 'a/b' })).rejects.toThrow(/物件 key/);
    expect(bucket.objects.size).toBe(0);
  });
});
