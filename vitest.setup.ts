// 測試預設用 seed 假資料登錄。真實 adapter 的測試明確傳入 env 或執行器（MIL-113）。
process.env.PRACTICE_REGISTRY ??= 'seed';
