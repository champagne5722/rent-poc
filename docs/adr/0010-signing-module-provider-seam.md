---
status: accepted
---

# 簽署模組與簽署服務商分離，業務實體以簽署標的連接

簽署能力原本綁在租賃合約：兩位簽署人、乙先甲後、點點簽 API 與領域邏輯混在 route handler。Phase 1 要加委託管理合約，押金結算單與退還證明可能也要簽署，Phase 2 再加撥款指示。簽署人數與順序都依文件類型而變。決議：拆成簽署模組與簽署服務商 adapter 兩層，簽署進度由簽署模組擁有，業務實體只透過簽署標的連接。點點簽與 Mock 各是一個 adapter，所以這個 seam 上有兩個實作。

## 決議內容

1. **兩層。** route handler 只呼叫簽署模組。adapter 只翻譯服務商 API，不含領域邏輯。散落各處的 mock 判斷全部收進 Mock adapter。
2. **簽署進度自成兩張表。** 簽署任務與簽署人各一張表，以 `subject_type`、`subject_id` 連回業務實體。一個簽署標的最多一個簽署任務，符合 ADR-0006 的撤回後衍生。
3. **文件只傳資料。** 呼叫端傳檔名、PDF 位元組與頁面尺寸。PDF 產出與送簽前驗證留在各文件類型，簽署模組不回呼。
4. **本決議不做 inbox 與 outbox。** 那屬 PostgreSQL 遷移線。介面一律回傳 Promise，`send()` 回傳平台的簽署任務，呼叫端看不到服務商任務編號，之後改走 outbox 時呼叫端不用改。

5. **簽署序列是有序資料。** 簽署模組不解讀角色，陣列順序就是簽署順序，只支援依序簽署。簽署順序的來源互相矛盾（架構 4.10、PRD P0-11），法務也還沒回覆（Q12），所以順序不得寫死在程式碼。
6. **簽署角色屬合約層。** `SignerRole` 定為 `party_a`（甲方）、`party_b`（乙方）、`practitioner`（執業人員）。`landlord` 對 `party_a`，`tenant` 對 `party_b`，用一次性資料轉換改寫既有 `signature_fields.signer`，頁碼與座標不變。架構 6.2 步驟 10 原排在 M3，提前到本決議執行，因為新介面一開始就該用新識別字。

7. **合約狀態是簽署進度的投影。** 合約訂閱簽署模組的事件，由當前簽署人的角色決定狀態：`party_b` 對 `awaiting_tenant`，`party_a` 對 `awaiting_landlord`，`practitioner` 對 `awaiting_practitioner`。順序改變時對照表不變。最後一位簽完不動狀態，等全員完成事件才完成。
8. **同一交易。** 簽署進度、合約狀態、合約歷程在同一交易寫入，訂閱者在交易內被呼叫。分開寫時，進度已寫而合約寫入失敗，重試會被判定為重複，合約就永遠卡住。交易內不得呼叫外部 API。
9. **重複事件以 email 守門。** 點點簽沒有事件 ID，會重試。多位簽署人時，第一位的重試會把第二位誤判為已簽。所以簽署人已簽事件的 email 必須等於當前簽署人，否則忽略。送簽時拒絕同一簽署任務內 email 重複，比對不分大小寫。
10. **文件保存歸簽署模組。** 已簽 PDF 與 Audit Trail File 以簽署任務為鍵，失敗紀錄與補抓共用。M07 文件庫完成後只換儲存位置。
11. **合約歷程仍由合約層寫。** 簽署模組不另開事件表，只記簽署人的狀態與簽署時間。事件流水已在合約歷程，再存一份沒有讀取者。
12. **簽署人驗證只做介面。** 簽署人得帶驗證設定，由 adapter 轉成服務商的格式，預設不啟用。電話與身分證字號只傳給服務商，不寫進簽署人表。

## Considered Options

- **進度放 `contracts` 的 JSON，模組只服務合約。** 改動最小，但 Phase 1 的押金結算單與退還證明可能需要簽署，Phase 2 的撥款指示確定需要，它們都不是合約。否決。
- **合約狀態一般化成 `signing` 加序號。** 能表達任意人數，但清單、工作台與詳情頁都依狀態識別字運作，改動面最大，而且把服務商進度混進合約狀態。否決。

## Consequences

- 架構文件的 `SignatureRecord` 拆開：通用欄位（順序、狀態、簽署時間）歸簽署人表，法定欄位（`statute_ref`、`rule_id`、`credential_snapshot`）留給簽章分流，另存並參照簽署人列。與架構 3.14 不同。
- 架構 2.4 的 `ESignProvider` 改為 `SigningProvider`：`verifyWebhook` 與 `toInboxMessage` 併成 `parseWebhook`，空 body 的驗證 ping 也由 adapter 處理。
- **修訂 ADR-0006：** 合約狀態機由六態變七態，加 `awaiting_practitioner`。修約走撤回後衍生的規則不變。
- **延伸 ADR-0007：** 同交易的範圍加上簽署進度。法律舉證仍是 Audit Trail File，合約歷程的定位不變。
- 不與 ADR-0003 矛盾：點點簽仍用 Client Credentials 與 email 簽署，只換位置。
- 同一人兼任甲方代表與執業人員時，送簽會被擋下，直到 sandbox 驗證同一 email 能否出現在兩個 stage。
- email 守門依賴 `event_email` 等於簽署人 email。非會員簽署人的行為必須先以 sandbox 驗證，才能上線。
- 舊識別字 `awaiting_tenant`、`awaiting_landlord` 保留，委託管理合約的乙方是代管業者時，畫面標籤依文件類型顯示。

## 編號對應

本編號與架構文件第 8 節的候選 ADR-0010（PostgreSQL 與 RLS）不同。候選 ADR 尚未落檔，正式落檔時取下一個可用編號。候選 ADR-0016（簽章人綁定執業人員）的「改 `SignerRole`」與「加狀態」兩項由本決議承接，簽章人綁定與簽章分流規則表仍屬該候選 ADR。
