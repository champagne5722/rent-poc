<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 的對照，句長規則不適用 -->
# `src/lib/tenancy-records/`：租期中與退租的純函式

MIL-158，母票 MIL-133，涵蓋 MIL-135、136、137、141 的純函式部分。依據是 ADR-0016 決議 6、ADR-0051 決議 3 到 7、9、10。

這個模組只匯出純函式、常數與型別。它不建表、不呼叫資料庫、不讀系統時鐘，也不 import `src/lib/db.ts`。表、畫面、PDF、送簽與 `withCaseMemberTx` 留給原票。

## 約定

- ID 一律 `string`。金額一律整數新台幣元，檢查 `Number.isSafeInteger`。
- 狀態轉移回傳 `{ ok: true, state, event }` 或 `{ ok: false, reason }`。這與 `src/lib/handover/transitions.ts` 回傳 `null` 不同，因為修繕缺費用、異議缺說明要告訴使用者原因。
- 狀態與輸入各有常數陣列，測試用「狀態乘輸入」的全矩陣表格，每個格子都有允許或拒絕。
- 誰有權做這個動作（出租人、委託範圍含該項的代管業者、承租人）由呼叫端的 repository 檢查。這裡只管狀態。
- 輸入資料不合法（金額、列序號、度數）丟 `RangeError`。使用者操作可能違反的業務規則回傳 `reason`。
- 業務類型 `BusinessType` 從 `../cases` 匯入，不重複定義。

## 函式

| 函式 | 作用 | 檔案 |
| -- | -- | -- |
| `decideRepairTransition(state, input)` | 修繕紀錄的狀態轉移 | `repair.ts` |
| `decideHandoverRecordTransition(state, input)` | 點交紀錄的狀態轉移 | `handover-record.ts` |
| `handoverConfirmations(state)` | 出租方與承租人是否已確認 | `handover-record.ts` |
| `decideObjectionTransition(state, input)` | 扣抵異議的狀態轉移 | `objection.ts` |
| `compareHandoverRecords(moveIn, moveOut)` | 入住與退租點交的逐列與度數對照 | `compare.ts` |
| `canAdvanceToSettling(facts)` | 推進到 `settling` 的前提檢查 | `settling.ts` |
| `settlementWarnings(deductions)` | 結算單送簽前的警告 | `warnings.ts` |

## 規則

### 修繕紀錄

- 狀態：`reported`（已報修）、`in_progress`（處理中）、`completed`（已完成）、`cancelled`（已取消）。
- 輸入：`start`、`complete`、`cancel`。只能往前。已報修得直接完成，不必經過處理中。
- 未完成（已報修、處理中）得取消。已完成與已取消之後不再轉移。
- `complete` 必須帶 `cost` 與 `payer`。缺費用回 `cost_required`，缺付款方回 `payer_required`。費用不是非負整數回 `invalid_cost`，付款方不在清單回 `invalid_payer`。費用得為 0。
- 付款方：`lessor`（出租人）、`owner`（屋主）、`lessee`（承租人）、`other`（其他）。
- 狀態錯誤先於欄位檢查回報。

### 點交紀錄

- 狀態：`draft`、`pending_lessee_confirmation`、`confirmed`。沒有拒絕狀態。
- 輸入：`submit`（出租方送出，視為出租方確認）、`lessee_confirm`、`edit_content`、`add_supplement`。
- 只有草稿得改內容。送出後改內容回 `immutable_use_supplement`，只得新增補充紀錄。
- 補充紀錄在待承租人確認與已確認都允許，草稿不允許。承租人不同意時不必先確認就能留下意見。這與 GLOSSARY「補充紀錄」寫的「確認後新增」字面不同，主控已同意，GLOSSARY 待補（見 MIL-61）。
- 入住與退租兩次點交共用同一張表。

### 扣抵異議

- 狀態：`none`（無）、`objected`（有異議）、`withdrawn`（已撤回）。沒有已解決狀態。
- 輸入：`raise`（必須有 `note`，空白回 `note_required`）、`withdraw`、`resolve`。
- `resolve` 一律回 `lessor_cannot_resolve`。出租方要處理時，沖銷扣抵並重新登錄，新扣抵從 `none` 開始。
- 已撤回後得再 `raise`，仍須填說明。

### 點交對照

- 設備列以合約凍結的附件列序號 `rowNo`（非負整數）配對。結果依 `rowNo` 排序。
- 差異種類：`unchanged`、`changed`（狀態不同）、`added`（退租有入住沒有）、`missing`（入住有退租沒有）。同一 `rowNo` 但名稱不同，視為原項目 `missing` 加新項目 `added`。
- 名稱與狀態前後空白不計。備註不影響對照。
- 度數有 `electricity`、`gas`、`water`，水表選填。`delta` 是退租減入住。任一邊沒記錄時 `delta` 是 `null`，狀態是 `not_comparable`。退租小於入住時狀態是 `decreased`，可能換表，由人判斷。
- `hasRowDifferences` 只看設備列。度數正常會增加，所以不計入，呼叫端自己看 `meters`。

### 推進到押金結算

- 自管：退租點交雙方已確認（`confirmed`），結果 `via: 'both_confirmed'`。
- 代管與包租：點交證明已完成，結果 `via: 'certificate_completed'`。退租點交的狀態不影響。
- 三種業務類型都得改走登錄催告，結果 `via: 'demand_notice'`。主要路徑與催告同時成立時回報主要路徑。
- 通過條件不成立時回傳 `missing`，列出主要路徑缺的前提。催告是另一條路，不列在 `missing`。
- 這個函式不檢查案件是否在 `move_out`。推進動作屬案件狀態機。

### 結算警告

- 有 `objected` 的扣抵時回傳一個 `disputed_deductions` 警告，帶扣抵 id、筆數、金額合計與 `requiresConfirmation: true`。已撤回的不算。
- 警告不阻擋。送簽前必須由使用者確認。

## 測試

```
npx vitest run src/lib/tenancy-records
```

`purity.test.ts` 檢查模組不讀系統時鐘、不產生亂數，匯入只限同目錄與 `../cases`。
