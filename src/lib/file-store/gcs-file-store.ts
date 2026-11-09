import { sha256Hex, type FileStore } from './file-store';
import { parseObjectKey } from './object-key';

// Cloud Storage adapter（MIL-87）。
//
// 權限：不帶任何金鑰。Cloud Run 上 SDK 用 Application Default Credentials，也就是服務的執行身分
// （RUNTIME_SA），該身分在 bucket 上要有 roles/storage.objectUser。repo、映像、環境變數都沒有金鑰檔。
// 本機若要連真的 bucket，用 `gcloud auth application-default login`，這不是日常開發流程（本機預設用檔案系統）。
//
// 實際呼叫在 MIL-92 驗證。這裡的契約測試用記憶體替身（ObjectBucket 的實作），驗證 adapter 對 bucket 的使用方式。

/**
 * adapter 需要 bucket 提供的最小能力。SDK 的 File 物件有同樣的行為：
 * download 在物件不存在時丟 code 為 404 的錯誤，其他失敗丟別的錯誤。
 */
export interface ObjectBucket {
  save(name: string, bytes: Uint8Array, meta: { contentType: string }): Promise<void>;
  download(name: string): Promise<Uint8Array>;
  exists(name: string): Promise<boolean>;
  /** 物件不存在時不丟錯。 */
  delete(name: string): Promise<void>;
}

export function createGcsFileStore(bucket: ObjectBucket): FileStore {
  return {
    async write(key, bytes, meta) {
      await bucket.save(parseObjectKey(key), bytes, { contentType: meta.contentType });
      return { sha256: sha256Hex(bytes), byteSize: bytes.length };
    },

    async read(key) {
      try {
        return new Uint8Array(await bucket.download(parseObjectKey(key)));
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },

    exists: async (key) => bucket.exists(parseObjectKey(key)),

    delete: async (key) => bucket.delete(parseObjectKey(key)),
  };
}

function isNotFound(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 404;
}

/**
 * 以 SDK 連到指定 bucket。SDK 到這裡才載入，本機模式與測試不會載入它。
 * 不傳 projectId 與金鑰：Cloud Run 的 metadata server 提供專案與執行身分。
 */
export async function createSdkBucket(bucketName: string): Promise<ObjectBucket> {
  const { Storage } = await import('@google-cloud/storage');
  const bucket = new Storage().bucket(bucketName);
  return {
    // 檔案不大，用單次上傳（resumable: false）少一次往返。物件取代是原子的。
    save: (name, bytes, meta) =>
      bucket.file(name).save(Buffer.from(bytes), { contentType: meta.contentType, resumable: false }),
    download: async (name) => {
      const [data] = await bucket.file(name).download();
      return new Uint8Array(data);
    },
    exists: async (name) => {
      const [found] = await bucket.file(name).exists();
      return found;
    },
    delete: async (name) => {
      await bucket.file(name).delete({ ignoreNotFound: true });
    },
  };
}
