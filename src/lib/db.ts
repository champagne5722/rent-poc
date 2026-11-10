import path from 'path';

// 本機檔案的根目錄：本機 FileStore 放在 data/files/，mock 簽署的暫存 PDF 放在 data/mock-signing/。
// 資料庫一律走 src/lib/pg/（PostgreSQL）。文件本體走 FileStore（src/lib/file-store/），demo 與 pilot 在 Cloud Storage。
// 這個常數只給本機開發與測試用。
export const DATA_DIR = path.join(process.cwd(), 'data');
