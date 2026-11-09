import { describe, expect, it } from 'vitest';
import { sha256Hex, type FileStore } from './file-store';
import { buildObjectKey } from './object-key';

// FileStore 的契約測試（MIL-87）。每個 adapter 的測試檔呼叫一次 describeFileStoreContract，
// 本機與 Cloud Storage 兩個 adapter 因此通過完全相同的案例。
// 每個案例用自己的組織 id 當前綴，同一個儲存位置可重複使用，案例之間不會互相影響。

const PDF = 'application/pdf';
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : null);
// ULID 字元集，每個案例一個新的組織前綴
let counter = 0;
const freshOrg = () => `01TESTORG${String(++counter).padStart(17, '0')}`;

export function describeFileStoreContract(name: string, makeStore: () => Promise<FileStore> | FileStore): void {
  describe(`FileStore 契約：${name}`, () => {
    it('寫入後讀得回同樣的位元組', async () => {
      const store = await makeStore();
      const key = buildObjectKey(freshOrg(), 'sign-tasks', 'T1', 'a.pdf');
      await store.write(key, bytes('%PDF-1.7 內容'), { contentType: PDF });
      expect(text(await store.read(key))).toBe('%PDF-1.7 內容');
    });

    it('二進位內容逐位元組相同', async () => {
      const store = await makeStore();
      const key = buildObjectKey(freshOrg(), 'sign-tasks', 'T1', 'bin.pdf');
      const all = Uint8Array.from({ length: 256 }, (_, i) => i);
      await store.write(key, all, { contentType: PDF });
      expect(Array.from((await store.read(key)) ?? [])).toEqual(Array.from(all));
    });

    it('寫入回傳位元組數與 SHA-256', async () => {
      const store = await makeStore();
      const key = buildObjectKey(freshOrg(), 'sign-tasks', 'T1', 'hash.pdf');
      const data = bytes('abc');
      const result = await store.write(key, data, { contentType: PDF });
      expect(result.byteSize).toBe(3);
      // 獨立來源：'abc' 的 SHA-256 是公開的標準測試向量
      expect(result.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      expect(result.sha256).toBe(sha256Hex(data));
    });

    it('空檔案可以寫入與讀取', async () => {
      const store = await makeStore();
      const key = buildObjectKey(freshOrg(), 'sign-tasks', 'T1', 'empty.pdf');
      await store.write(key, new Uint8Array(), { contentType: PDF });
      expect(await store.exists(key)).toBe(true);
      expect((await store.read(key))?.length).toBe(0);
    });

    it('沒寫過的 key：exists 回 false，read 回 null', async () => {
      const store = await makeStore();
      const key = buildObjectKey(freshOrg(), 'sign-tasks', 'T1', 'missing.pdf');
      expect(await store.exists(key)).toBe(false);
      expect(await store.read(key)).toBeNull();
    });

    it('寫入後 exists 回 true', async () => {
      const store = await makeStore();
      const key = buildObjectKey(freshOrg(), 'sign-tasks', 'T1', 'here.pdf');
      await store.write(key, bytes('x'), { contentType: PDF });
      expect(await store.exists(key)).toBe(true);
    });

    it('同一個 key 再寫一次，整個取代', async () => {
      const store = await makeStore();
      const key = buildObjectKey(freshOrg(), 'sign-tasks', 'T1', 'again.pdf');
      await store.write(key, bytes('很長的舊內容很長的舊內容'), { contentType: PDF });
      await store.write(key, bytes('新'), { contentType: PDF });
      expect(text(await store.read(key))).toBe('新');
    });

    it('不同組織的同名檔案不會互相覆蓋', async () => {
      const store = await makeStore();
      const orgA = freshOrg();
      const orgB = freshOrg();
      const keyA = buildObjectKey(orgA, 'sign-tasks', 'T1', 'same.pdf');
      const keyB = buildObjectKey(orgB, 'sign-tasks', 'T1', 'same.pdf');
      await store.write(keyA, bytes('A 的合約'), { contentType: PDF });
      expect(await store.exists(keyB)).toBe(false);
      await store.write(keyB, bytes('B 的合約'), { contentType: PDF });
      expect(text(await store.read(keyA))).toBe('A 的合約');
      expect(text(await store.read(keyB))).toBe('B 的合約');
    });

    it('同組織下，key 的上一層與下一層可以並存', async () => {
      const store = await makeStore();
      const org = freshOrg();
      const a = buildObjectKey(org, 'uploads', 'doc.pdf');
      const b = buildObjectKey(org, 'uploads', 'doc.pdf.bak', 'x.pdf');
      await store.write(a, bytes('1'), { contentType: PDF });
      await store.write(b, bytes('2'), { contentType: PDF });
      expect(text(await store.read(a))).toBe('1');
      expect(text(await store.read(b))).toBe('2');
    });

    it('delete 之後 exists 回 false，read 回 null', async () => {
      const store = await makeStore();
      const key = buildObjectKey(freshOrg(), 'vault', 'gone.pdf');
      await store.write(key, bytes('要刪的證據檔'), { contentType: PDF });
      await store.delete(key);
      expect(await store.exists(key)).toBe(false);
      expect(await store.read(key)).toBeNull();
    });

    it('delete 沒寫過的 key 不丟錯（重試安全）', async () => {
      const store = await makeStore();
      await expect(store.delete(buildObjectKey(freshOrg(), 'vault', 'never.pdf'))).resolves.toBeUndefined();
    });

    it('delete 只刪那一個 key，同組織與別的組織的其他檔案不受影響', async () => {
      const store = await makeStore();
      const orgA = freshOrg();
      const orgB = freshOrg();
      const target = buildObjectKey(orgA, 'vault', 'a.pdf');
      const sibling = buildObjectKey(orgA, 'vault', 'b.pdf');
      const other = buildObjectKey(orgB, 'vault', 'a.pdf');
      for (const key of [target, sibling, other]) await store.write(key, bytes(key), { contentType: PDF });
      await store.delete(target);
      expect(await store.exists(sibling)).toBe(true);
      expect(await store.exists(other)).toBe(true);
    });

    it('不合法的 key 不會被當成路徑使用', async () => {
      const store = await makeStore();
      const evil = ['org/x/../../etc/passwd', '/org/x/a/b.pdf', 'org/x/a/b.pdf/', 'org//a/b.pdf', 'x/y/z/w.pdf'];
      for (const key of evil) {
        await expect(store.read(key as never)).rejects.toThrow(/物件 key/);
        await expect(store.exists(key as never)).rejects.toThrow(/物件 key/);
        await expect(store.delete(key as never)).rejects.toThrow(/物件 key/);
        await expect(store.write(key as never, bytes('x'), { contentType: PDF })).rejects.toThrow(/物件 key/);
      }
    });
  });
}
