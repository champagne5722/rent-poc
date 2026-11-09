import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describeFileStoreContract } from './file-store.contract';
import { createLocalFileStore } from './local-file-store';
import { buildObjectKey } from './object-key';

const roots: string[] = [];
const tempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-file-store-'));
  roots.push(root);
  return root;
};
afterAll(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describeFileStoreContract('本機', () => createLocalFileStore(tempRoot()));

describe('本機 adapter 專屬行為', () => {
  it('換一個 store 實例指向同一個根目錄，仍讀得到（換實例後讀得到）', async () => {
    const root = tempRoot();
    const key = buildObjectKey('01ORGAAAAAAAAAAAAAAAAAAAAA', 'sign-tasks', 'T1', 'a.pdf');
    await createLocalFileStore(root).write(key, new TextEncoder().encode('持久'), { contentType: 'application/pdf' });
    const read = await createLocalFileStore(root).read(key);
    expect(new TextDecoder().decode(read ?? new Uint8Array())).toBe('持久');
  });

  it('寫入完成後根目錄下不留暫存檔', async () => {
    const root = tempRoot();
    const store = createLocalFileStore(root);
    const key = buildObjectKey('01ORGAAAAAAAAAAAAAAAAAAAAA', 'sign-tasks', 'T1', 'a.pdf');
    await store.write(key, new Uint8Array([1, 2, 3]), { contentType: 'application/pdf' });
    const dir = path.join(root, 'org', '01ORGAAAAAAAAAAAAAAAAAAAAA', 'sign-tasks', 'T1');
    expect(fs.readdirSync(dir)).toEqual(['a.pdf']);
  });

  it('key 的上層是檔案時，視為不存在', async () => {
    const root = tempRoot();
    const store = createLocalFileStore(root);
    const org = '01ORGAAAAAAAAAAAAAAAAAAAAA';
    await store.write(buildObjectKey(org, 'a', 'file'), new Uint8Array([1]), { contentType: 'application/pdf' });
    const under = buildObjectKey(org, 'a', 'file', 'child.pdf');
    expect(await store.exists(under)).toBe(false);
    expect(await store.read(under)).toBeNull();
  });
});
