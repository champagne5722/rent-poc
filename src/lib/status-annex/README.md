<!-- ste-lint: off -->
<!-- 模組說明給開發者與 agent 讀，內容是介面與接點清單，句長規則不適用 -->
# 現況確認附件（`src/lib/status-annex/`）

MIL-71 的成果。依據：P0-12 AC3、ADR-0018 決議 6 與 8、GLOSSARY「現況確認附件」。文字用「現況確認附件」，法定文件名保留「現況確認書」。項目清單與必附條件都是待法務確認的假設（MIL-62）。

## 檔案

| 檔案 | 內容 | 純函式 |
|---|---|---|
| `items.ts` | `STATUS_ANNEX_ITEMS`（10 項固定清單）、`STATUS_ANNEX_VERSION`、狀態標籤、備註字數上限 | 是 |
| `types.ts` | `StatusAnnex`、`StatusAnnexRow`、`StatusAnnexStatus` | 是 |
| `index.ts` | `defaultStatusAnnex`、`statusAnnexIssues`、`statusAnnexInputError`、`statusAnnexRequired`、`statusAnnexOf`、`statusAnnexSummary`、`statusAnnexSignatureMissingMessage`。client 也能引用 | 是 |
| `server.ts` | `statusAnnexPageMap(contract)`、`statusAnnexSendReasons(contract)`。引用 PDF 產出函式，只有伺服器能引用 | 否 |

## 必附條件

不另寫條件。`statusAnnexRequired(routing, contractType)` 問簽章分流規則表：簽署序列有席位的 `requiredFieldPages` 含 `status_annex` 就必附。第一版只有 `lease.master_lease` 的專任管理人員席位（包租，含居間加包租）。自管、代管、屋主與包租業者（自管且承租人是包租業者，ADR-0018 決議 8）、委託管理合約都不附。改條件時只改 `signature-routing/rules.ts` 的規則列。

## 儲存：放在合約欄位，不另開資料表

內容收在 `LeaseContractFields.statusAnnex`（合約欄位快照 JSON）。形狀：`{ version, rows: [{ id, label, status, note }] }`。

理由：

1. 附件隨合約凍結，生命週期與設備附件（`equipmentAnnex`）相同。草稿存檔、複製為新草稿、送簽後不可改（`PUT /api/contracts/[id]` 只收草稿），都由既有的欄位機制處理，不必另寫 repository、複製與刪除。
2. 與分流條件、設備附件同在一份快照內，不會出現欄位與子表不同步。
3. A 線搬 PostgreSQL 時不需要帶任何東西：合約欄位本來就會搬。
4. 沒有跨合約查詢需求。委託標的清單（MIL-74）存新表是為了 C 線依租賃單位查詢，這裡沒有。

列的 `label` 在建立時快照，之後項目清單改版不回溯影響已存的內容。沒有 `statusAnnex` 的舊合約讀入不報錯。

## 什麼時候印

`statusAnnexOf(status, contractType, fields)`：

- 草稿：必附時印已存的內容，還沒有內容就印預設清單（全部「未填」），預覽看得到缺什麼。
- 送簽之後：只印已凍結的內容。送簽前就存在的舊包租合約沒有內容，所以不印，PDF 與送簽時相同。
- 不必附：不印，即使欄位裡留有內容（改分流條件後不刪內容，改回來還在）。

## 送簽前檢查

- 欄位檢核：`leaseMissingFields` 與 `leaseMissingFieldsForSend` 在必附時併入 `statusAnnexIssues`（每項要有狀態，有瑕疵的項目要有備註）。
- 附件頁簽署區域：`send-preconditions/status-annex.ts` 的 `checkStatusAnnexSignatureFields(routing, signatureFields, pages)`。規則列要求的席位在附件頁沒有簽署區域時回 `status_annex_signature_missing`。只要求規則列指定的席位，兼任（MIL-76）與居間加包租的四位都不改這個要求。
- 附件頁在哪一頁由產出 PDF 的函式回報（`PdfPageMap`），伺服器用 `statusAnnexPageMap`。`prepareContractSend(contract, resolution, at, db, { pages })` 收地圖並併入原因清單。送簽 route 與 `GET /api/contracts/[id]/practitioners`（確認頁的預檢）都會帶。

## 給其他票

- **E 線點交**：項目與狀態定義在 `items.ts`，是程式內常數。點交的現況項目要共用時從這裡取，或複製後另開版本，不要改 `STATUS_ANNEX_VERSION` 已存的內容。
- **MIL-77**：委託管理合約不受影響，`statusAnnexRequired` 對 `management` 回 false。
- **A 線**：不需要搬任何東西。
