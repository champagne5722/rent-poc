# 領域模型：合約狀態機與資料模型

詞彙定義見 repo 根目錄 [GLOSSARY.md](../GLOSSARY.md)；PoC 刻意不做的範圍見[已知簡化清單](./known-simplifications.md)。

## 合約狀態機

合約有七個狀態。合約狀態是簽署進度的投影（ADR-0010）：簽署中的狀態由當前簽署人的簽署角色決定。

| 簽署角色 | 合約狀態 |
| -- | -- |
| 乙方 `party_b` | `awaiting_tenant`（待乙方簽） |
| 執業人員 `practitioner` | `awaiting_practitioner`（待執業人員簽） |
| 甲方 `party_a` | `awaiting_landlord`（待甲方簽） |

簽署順序由呼叫端交給簽署模組的簽署序列決定，陣列順序就是簽署順序（點點簽 `has_order: true`）。租賃合約目前的簽署序列是乙方、甲方。三位簽署人的序列是乙方、執業人員、甲方，目前只由測試經簽署模組建立。

```
draft（草稿）
  └─ 送簽 → 第一位簽署人對應的簽署中狀態
              awaiting_tenant / awaiting_practitioner / awaiting_landlord
                ├─ 簽署人已簽，還有下一位 → 下一位簽署人對應的簽署中狀態
                ├─ 全員完成 → completed（已完成，可下載已簽 PDF 與 Audit Trail File）
                ├─ 拒簽 → declined（已拒簽，記拒簽者的簽署角色與原因）
                └─ 出租人撤回 → voided（已撤回）
```

- 簽署事件由點點簽 webhook 或 mock 模擬送進簽署模組。撤回由系統主動呼叫服務商後更新。
- 簽署模組推進簽署進度，再呼叫合約訂閱者（`src/lib/contract-signing.ts`）。合約狀態的轉移規則在 `src/lib/transitions.ts`。
- 簽署進度、合約狀態與合約歷程在同一交易寫入（ADR-0007、ADR-0010）。
- 當前簽署人只由簽署進度推導，不由合約狀態推導。沒有簽署任務的合約沒有當前簽署人。
- `voided` / `declined` 的合約可「複製為新草稿」重走流程。修約（撤回後複製）會記錄衍生關聯。拒簽後的複製只為省時，不記關聯（ADR-0006）。續約機制與到期標示不在目前範圍。
- 程式識別字：`draft` / `awaiting_tenant` / `awaiting_practitioner` / `awaiting_landlord` / `completed` / `declined` / `voided`。`isSigningStatus` 判斷三個簽署中狀態。

## 資料模型（概念層）

- **Property**：id、name、address、type（整層/套房/雅房）、size（坪）、default_rent、note、設備清單（每項：詞彙庫項目＋數量）
- **Equipment Vocabulary（設備詞彙庫）**：房東層的設備項目字典，平台預設項目＋房東自訂項目同一份；各物件設備清單由此挑選（ADR-0008）
- **Contract**：id、property_id、狀態、欄位值（租金、押金、租期起迄、付款日、雙方姓名/email 等）、補充合約內容（自由文字，含 `{{合約變數}}`，產出時解析）、設備附件列（每列：項目＋數量＋修繕責任＋備註，建約由物件帶入後逐約調整）、signature_fields（JSON：簽署角色＋頁碼＋座標）、拒簽原因、衍生自（derived from，撤回修約路徑才記錄，ADR-0006）。合約不存服務商任務編號，也不存已簽文件。這兩者都屬簽署任務。
- **Sign Task（簽署任務，`sign_tasks`）**：服務商、服務商任務編號、簽署標的（`subject_type` 加 `subject_id`）、狀態（`in_progress` / `completed` / `declined` / `voided`）、時間戳。一個簽署標的最多一筆，一個服務商任務編號最多一筆。只有簽署模組讀寫（ADR-0010）
- **Signer（簽署人，`signers`）**：簽署任務、順序、簽署角色、姓名、email、狀態（`pending` / `signed` / `declined`）、簽署時間。順序就是簽署序列，送簽時凍結。當前簽署人是順序最前面的待簽者，不另存指標。電話與身分證字號不寫入這張表
- **Sign Task File（簽署任務文件，`sign_task_files`）**：簽署任務、種類（已簽 PDF 或 Audit Trail File）、狀態、檔名、相對 `data/` 的路徑、大小、錯誤訊息。全員完成後保存（ADR-0007、ADR-0010）
- 舊形式的轉移：MIL-60 之前的資料庫有合約的 `dottedsign_task_id` 欄位與以合約為鍵的 `contract_files` 表。`ensureSchema()` 開檔時先由它們回填簽署任務、簽署人與文件紀錄，再刪除欄位與表（`src/lib/signing-module/contract-backfill.ts`）。舊檔案留在 `data/contract-files/`，回填後的文件紀錄仍指向那裡
- 合約文件三層組裝：主約（公版鎖定）＋補充合約（房東自訂獨立頁）＋設備附件（系統產出表單頁），見 ADR-0008
- **Contract Event（合約事件）**：附屬合約的 append-only 里程碑事件序列：型別（建立／送簽／簽署人簽署／拒簽／簽署完成／撤回／被複製，舊資料另有乙方簽署）、行為者（出租人／系統／甲方／乙方／執業人員，舊資料另有承租人）、時間、附註（拒簽原因、衍生對象等）；webhook 事件與狀態轉移同交易寫入，隨合約保存（ADR-0007）
- **Template（範本）／Optional Clause（選用條款）**：平台資料，皆含版本；PoC 以程式內常數表達（`src/lib/clause-library.ts`），無維護介面（ADR-0005）
- Contract 引用 Property 帶入資料後即自成快照，物件後續修改不回溯影響既有合約。
- Contract 對範本的綁定與勾選條款同理：建約時記下範本版本並把條款**條文整段**快照進合約欄位 JSON（`templateId` / `templateVersion` / `clauses`），平台改版不回溯影響既有合約與草稿；草稿遇新版時 wizard 提示可升版重建（＝重新快照），不強制（ADR-0005）。
