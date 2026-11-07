<!-- ste-lint: off -->
<!-- 交接文件給 agent 讀，內容是指向既有文件的清單，句長規則不適用 -->
# D 線交接：簽章分流、委託管理合約、三位簽署人的畫面

先讀 `README.md`。這條線的 spec 與 tickets 已發，等簽署模組做完就能派實作。

## 範圍與依據

- P0-10 合約與電子簽署、P0-11 委託管理合約、P0-12 簽章分流。
- spec：Linear MIL-64。tickets：MIL-65 到 MIL-77，13 張，原生 blocked-by 已接好。MIL-65 blocked-by MIL-60。
- ADR：0018（簽章人綁定執業人員、簽章分流規則表在程式碼內、各文件類型的簽署序列、同一人兼任合併、簽署中失效自動撤回、送簽前檢查 7 項、簽章紀錄與快照、簽署人驗證第一版 email、PDF 簽署欄 N 列）、0021（分流條件存合約、`practitionerDirectory` seam 用 seed 假資料、`contract_type` 欄位）、0010（簽署模組）、0016、0017、0006、0008。
- 票的順序與限制在 MIL-64：第 8、9、10 張（MIL-71、72、73）都動 wizard 或詳情頁，一次只做一張。第 10 張 MIL-73 是 prefactor。

## 依賴

- 簽署模組 MIL-57 到 MIL-60 由原主控對話做，MIL-60 結案後 MIL-65 解鎖。
- D 線不等 A 線。用現有 SQLite 的 `ensureSchema`，新表走 repository 函式並回傳 Promise，A 線遷移時一起搬。
- A 線的 schema 票先於 D 線的 schema 票開工（MIL-78 Further Notes）。實務上 MIL-79 與 MIL-65 都等 MIL-60，所以 A 線先開 MIL-79，D 線隔一張票再開 MIL-65。
- 整合分支 `integration/line-d` 從 main 分出。每張票開工前先把 main 併進來。
- C 線完成後要接手 `practitionerDirectory` 與委託範圍限制動作（P0-11 AC3 到 AC5）。

## 第一步

1. 等簽署模組 MIL-60 結案的通知，或自己查 Linear。
2. 讀 MIL-64 與 MIL-65 的票，開 MIL-65 的實作子對話。MIL-65 會動 `src/lib/signing-module/`，開工前先確認 main 已含 MIL-60。
3. 之後依 blocked-by 順序逐張派工，動畫面的票載入 impeccable。
