import { createHash } from 'node:crypto';
import type { ObjectKey } from './object-key';

// FileStore（ADR-0012，MIL-87）：檔案本體的儲存。介面有四個操作：寫入、讀取、是否存在、刪除。
// 本機開發用檔案系統（local-file-store.ts），demo 與 pilot 用 Cloud Storage（gcs-file-store.ts）。
// 兩個 adapter 通過同一組契約測試（file-store.contract.ts）。
//
// 文件表只存物件 key 與 SHA-256，不存本機路徑。換實例或換 adapter 後，key 仍指到同一個檔案。

export interface WriteResult {
  /** 實際寫入的位元組的 SHA-256，小寫十六進位。文件表存這個值，讀取時用來驗證檔案沒被改動。 */
  sha256: string;
  byteSize: number;
}

export interface FileStore {
  /** 寫入。key 已有檔案時整個取代，不會留下一半新一半舊。 */
  write(key: ObjectKey, bytes: Uint8Array, meta: { contentType: string }): Promise<WriteResult>;
  /** 讀取。沒有這個檔案回 null。其他失敗（權限、網路）丟例外，不要當成不存在。 */
  read(key: ObjectKey): Promise<Uint8Array | null>;
  exists(key: ObjectKey): Promise<boolean>;
  /**
   * 永久刪除。沒有這個檔案時不丟錯，所以失敗後可以安全重試。
   * 產品行為裡的刪除用它，例如核對相符後刪證據檔（ADR-0017 補充，MIL-109）。呼叫端自己寫稽核事件。
   */
  delete(key: ObjectKey): Promise<void>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
