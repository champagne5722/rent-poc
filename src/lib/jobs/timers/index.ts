import { createTimerRegistry } from './registry';

// 正式環境的計時器註冊處。scan-timers 只執行這裡註冊的計時器。
//
// 各線在自己的票裡，把計時器寫成一個檔案（實作 OrgTimer 或 GlobalTimer，介面與規則見 ./registry.ts），
// 然後在下面加一行 timerRegistry.register(...)。名稱全系統唯一，重複會在載入時丟錯。
//
//   C 線 MIL-112：6 條計時器（計時器表在 Linear MIL-100 的 Further Notes）。
//                 純函式決策已在 src/lib/registry-rules/timers.ts，scan 載入事實後呼叫它，把決策轉成 TimerFire。
//   E 線 MIL-129、130、136；F 線 MIL-107。
//
// A 線（MIL-86）不註冊任何計時器，只用測試用的計時器驗證機制（scan-timers.test.ts）。
export const timerRegistry = createTimerRegistry();
