import path from 'path';

// 檔案型資料的根目錄：簽署任務的文件本體、mock 簽署的暫存 PDF 放在 data/ 下。
// SQLite 已經沒有任何資料表（合約與物件在 MIL-81、MIL-83 搬走，簽署任務與指派在 MIL-85 搬走），
// 資料庫一律走 src/lib/pg/。MIL-87 的 FileStore 完成後，這個常數連同 data/ 目錄一起移除。
export const DATA_DIR = path.join(process.cwd(), 'data');
