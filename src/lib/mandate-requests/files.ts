import { parseObjectKey, type FileStore } from '../file-store';

// 業者代傳的謄本檔案（MIL-206）。檔案放 FileStore 的 general，key 是 org/<業者的組織 ID>/registry-requests/<申請 ID>/transcript.<副檔名>。
// 資料庫函式只回該刪的 key，檔案在交易提交之後才刪（交易內不做外部 I/O，ADR-0012 決議 10）。

/** 最佳努力刪除。刪不掉只留 log：資料庫已經沒有指到這個檔案的紀錄，孤兒檔不會被任何 route 讀到。 */
export async function deleteTranscriptFiles(store: FileStore, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    try {
      await store.delete(parseObjectKey(key));
    } catch (error) {
      console.error('[mandate-requests] 代傳謄本檔刪除失敗', error);
    }
  }
}
