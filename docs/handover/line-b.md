<!-- ste-lint: off -->
<!-- 交接文件給 agent 讀，內容是指向既有文件的清單，句長規則不適用 -->
# B 線交接：產權錨點、租賃單位、重複偵測、出租權源

先讀 `README.md`。這條線還沒有 spec，第一步是寫規格。

## 範圍與依據

- P0-06 產權錨點與租賃單位、P0-07 重複登錄偵測、P0-08 出租權源鏈條。
- ADR：0013（五欄唯一鍵、`section_code` 用 text、行政區由編碼表帶出、單位後綴由平台發序號、租賃單位可合併且舊 ID 永久有效、狀態 `keyed`、電號水號不當輔助鍵、對外顯示不得含完整建號）、0012（`registry` schema 只經 SECURITY DEFINER 函式）、0016（案件成員）。
- 決議：MIL-42 的 Q2，出租權源待驗證得送簽，補三條規則（告知載明未驗證、必要文件未齊不得送簽、簽後驗證失敗撤回或通知）。
- 研究：MIL-63 筆記 `docs/research/asset-mgmt-platform/research_notes/mil-63-section-code-and-sublet-meter.md`。要點：全國有統一段碼表（地政司 CSV 與免 token 的 JSON API）；段碼 4 碼不全國唯一，縣市加鄉鎮市區加段碼唯一；行政區存編碼；段碼補 4 碼；5 組段碼落在不同鄉鎮市區，其中 3 組是跨越段，要定正規化規則；註銷碼與臺中、臺南、高雄重編碼的遷移方式不確定。
- 法務相關（第二類謄本相符判定 MIL-40、保存期限）在 MIL-62，第一版依 PRD 保守版本。

## 依賴

- 資料表在 `registry`，依賴 A 線。A 線的 MIL-81 會建 `registry` 骨架與「建立待驗證錨點」函式。
- B 線 tickets 的第一張 blocked-by MIL-81，並在 MIL-81 併進 `integration/line-a` 後，從那條分支開 worktree 實作。
- 整合分支 `integration/line-b` 從 `integration/line-a` 分出，不從 main。

## 規格要涵蓋的題目

段碼表的匯入與更新（來源、頻率、授權、跨越段與註銷碼的正規化）；行政區編碼表；物件登錄時輸入產權錨點的畫面流程；待驗證錨點轉已建號；重複偵測的硬性層與軟性層，以及 P0-07 AC1 的回應不洩漏他人資料並加頻率限制；租賃單位序號、合併（平台營運者執行並寫稽核）、舊 ID 解析；出租權源鏈條資料模型、謄本上傳與人工審核佇列、驗證狀態與送簽前提（併入 ADR-0018 的 `checkSendPreconditions`）、簽後驗證失敗處理；謄本新鮮度只留介面（P1-02）；個資遮罩與保存；與 A 線 MIL-81 的邊界；測試 seam。

## 第一步

1. 開一個 Opus 子對話寫規格，流程見 README 第 3 節。問題送回這個主控對話，照建議回。
2. spec 發 Linear 時 related MIL-35、MIL-78。tickets 第一張 blocked-by MIL-81。
3. 規格發完後等待 A 線通知 MIL-81 完成，再派實作。
