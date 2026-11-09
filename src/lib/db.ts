import path from 'path';

// 本機檔案的根目錄：本機 FileStore 放在 data/files/，mock 簽署的暫存 PDF 放在 data/mock-signing/。
// SQLite 已經沒有任何資料表（合約與物件在 MIL-81、MIL-83 搬走，簽署任務與指派在 MIL-85 搬走），
// 資料庫一律走 src/lib/pg/。文件本體走 FileStore（src/lib/file-store/），demo 與 pilot 在 Cloud Storage。
// 這個常數只剩本機開發用，MIL-91 移除 SQLite 時一併檢視。
export const DATA_DIR = path.join(process.cwd(), 'data');
