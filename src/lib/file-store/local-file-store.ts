import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex, type FileStore } from './file-store';
import { parseObjectKey, type ObjectKey } from './object-key';

// 本機 adapter：把物件 key 對應到 root 底下的檔案。key 的每一段都驗過，組出的路徑不會跳出 root。
// 寫入先寫暫存檔再改名，讀的人不會看到寫到一半的檔案。

export function createLocalFileStore(root: string): FileStore {
  const resolved = path.resolve(root);

  function fileOf(key: ObjectKey): string {
    const safe = parseObjectKey(key);
    const file = path.join(resolved, ...safe.split('/'));
    // 防禦：parseObjectKey 已擋 . 與 ..，這裡確認結果仍在 root 內
    if (!file.startsWith(resolved + path.sep)) throw new Error(`物件 key 跳出儲存根目錄：${key}`);
    return file;
  }

  return {
    async write(key, bytes) {
      const file = fileOf(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, bytes);
        await fs.rename(temp, file);
      } catch (e) {
        await fs.rm(temp, { force: true });
        throw e;
      }
      return { sha256: sha256Hex(bytes), byteSize: bytes.length };
    },

    async read(key) {
      try {
        return new Uint8Array(await fs.readFile(fileOf(key)));
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },

    async exists(key) {
      try {
        return (await fs.stat(fileOf(key))).isFile();
      } catch (e) {
        if (isNotFound(e)) return false;
        throw e;
      }
    },
  };
}

// ENOTDIR：key 的上層恰好是檔案，等同不存在
function isNotFound(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
