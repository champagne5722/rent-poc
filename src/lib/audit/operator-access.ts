import type { SqlExecutor } from '../pg/executor';

// 平台營運者存取組織資料的紀錄（P0-23 AC5，MIL-82）。
// withTx 在 operator 脈絡開完交易後、執行 callback 之前呼叫它，與業務資料同一個交易。
//
// 所有內容（目標組織、營運者、工單號）都由資料庫函式讀交易內的設定，這裡不傳任何值，
// 所以紀錄一定和實際的脈絡相同。事件寫在目標組織的鏈上，組織匯出稽核紀錄時看得到。
// 函式失敗時交易整個失敗，callback 不會執行：沒有紀錄就沒有存取。
//
// 已知限制：callback 拋例外時交易回滾，這筆紀錄跟著消失。回滾的交易沒有提交任何資料，
// 呼叫端也拿不到結果，所以不算存取到資料。

export async function recordOperatorAccess(conn: SqlExecutor): Promise<void> {
  await conn.query('SELECT * FROM audit.record_operator_access()');
}
