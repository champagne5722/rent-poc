# 領域模型：合約狀態機與資料模型

詞彙定義見 repo 根目錄 [GLOSSARY.md](../GLOSSARY.md)；PoC 刻意不做的範圍見[已知簡化清單](./known-simplifications.md)。

## 合約狀態機

簽署順序固定：租客（乙方）先簽、房東（甲方）後簽（點點簽 `has_order: true`）。

```
draft（草稿）
  └─ 送簽 → awaiting_tenant（待乙方簽）
                ├─ 租客簽署 → awaiting_landlord（待甲方簽）
                │                 ├─ 房東簽署 → completed（已完成，可下載已簽 PDF）
                │                 └─ 房東撤回 → voided（已撤回）
                ├─ 租客拒簽 → declined（已拒簽）
                └─ 房東撤回 → voided（已撤回）
```

- 狀態轉移由點點簽 webhook 事件驅動（撤回由系統主動呼叫後更新），轉移邏輯集中在 `src/lib/transitions.ts`。
- `voided` / `declined` 的合約可「複製為新草稿」重走流程。修約（撤回後複製）會記錄衍生關聯；拒簽後的複製為純省時便利，不記關聯（ADR-0006）。續約機制與到期標示不在目前範圍。
- 程式識別字：`draft` / `awaiting_tenant` / `awaiting_landlord` / `completed` / `declined` / `voided`。

## 資料模型（概念層）

- **Property**：id、name、address、type（整層/套房/雅房）、size（坪）、default_rent、note、設備清單（每項：詞彙庫項目＋數量）
- **Equipment Vocabulary（設備詞彙庫）**：房東層的設備項目字典，平台預設項目＋房東自訂項目同一份；各物件設備清單由此挑選（ADR-0008）
- **Contract**：id、property_id、狀態、欄位值（租金、押金、租期起迄、付款日、雙方姓名/email 等）、補充合約內容（自由文字，含 `{{合約變數}}`，產出時解析）、設備附件列（每列：項目＋數量＋修繕責任＋備註，建約由物件帶入後逐約調整）、signature_fields（JSON：簽署方＋頁碼＋座標）、dottedsign_task_id、產出的 PDF、已簽 PDF 下載資訊、點點簽 Audit Trail File（完成時保存，ADR-0007）、衍生自（derived from——撤回修約路徑才記錄，ADR-0006）
- 合約文件三層組裝：主約（公版鎖定）＋補充合約（房東自訂獨立頁）＋設備附件（系統產出表單頁），見 ADR-0008
- **Contract Event（合約事件）**：附屬合約的 append-only 里程碑事件序列——型別（建立／送簽／乙方簽署／拒簽／甲方簽署完成／撤回／被複製）、行為者（房東／租客／系統）、時間、附註（拒簽原因、衍生對象等）；webhook 事件與狀態轉移同交易寫入，隨合約保存（ADR-0007）
- **Template（範本）／Optional Clause（選用條款）**：平台資料，皆含版本；PoC 以程式內常數表達（`src/lib/clause-library.ts`），無維護介面（ADR-0005）
- Contract 引用 Property 帶入資料後即自成快照，物件後續修改不回溯影響既有合約。
- Contract 對範本的綁定與勾選條款同理：建約時記下範本版本並把條款**條文整段**快照進合約欄位 JSON（`templateId` / `templateVersion` / `clauses`），平台改版不回溯影響既有合約與草稿；草稿遇新版時 wizard 提示可升版重建（＝重新快照），不強制（ADR-0005）。
