<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 的對照，句長規則不適用 -->
# `src/lib/case-ledger/`：接上案件的帳務設定

票是 MIL-123。依據：ADR-0015 決議 6、11、12，ADR-0050 決議 2、4、5、6、10。表在 migration `0055_case_ledger_tables.sql` 與 `0056_ledger_case_link.sql`。

所有函式收呼叫端的組織交易 `tx`，不開交易，稽核事件與寫入同一個交易。權限由呼叫端先 `authorize()`，函式不判斷。

## 函式

| 檔案 | 函式 | 作用 |
|---|---|---|
| `open.ts` | `openCaseLedger(tx, caseId, terms)` | 合約全員完成時建立押金台帳與全部應收期別。已存在回 `already_open`。欄位不足以切期別時台帳照建、期別跳過並回報原因，不丟錯 |
| `open.ts` | `cancelPeriodsAfterTermination(tx, caseId, terminationDate)` | 提前終止：終止日之後才開始的期別改 `cancelled`，回傳期別鍵。現在沒有呼叫端，退租與終止的票接線（MIL-136） |
| `reads.ts` | `getDepositLedger`、`getDepositBalance`、`listPeriods` | 讀取。餘額由 view `org.deposit_balances` 加總 |
| `remitters.ts` | `addRemitterId`、`listRemitterIds`、`removeRemitterId` | 匯款識別。戶名與末五碼先正規化再存（`remitter-input.ts`） |
| `default-accounts.ts` | `getDefaultAccounts`、`setDefaultAccounts` | 租金與押金的預設收款帳戶。帳戶必須屬於本組織且啟用中 |
| `social-housing.ts` | `changeSocialHousing`、`listSocialHousingChanges`、`resolveSocialHousingDefault` | 社宅旗標。修改必須填原因，同交易寫紀錄、稽核並用 `notify()` 通知委託人 |
| `holder-conflicts.ts` | `listHolderConflicts(tx, caseId)` | 押金所在的收款帳戶中，押金帳戶規則不是 allow 的那些 |

## 接線

- 完成事件：`src/lib/case-store/contract-subscription.ts` 的 `onContractOutcomeForCase`，案件接受 `contract_completed`（`dispatch` 回 `ok`）才呼叫 `openCaseLedger`。簽署模組的合約訂閱者原本就在同一個交易呼叫它，沒有另開路徑。
- 為了避免循環匯入，`contract-subscription.ts` 直接匯入 `./open`，不經 `index.ts`。

## 規則與假設

- 首末期不足一個月時依日數比例計算，四捨五入到元。按比例是假設，待訪談驗證。
- 約定金額取合約的押金，沒填記 0。
- 通知委託人：案件連到的委託管理案件中，有效的 `mandator` 成員。每位寄一封 email，寄件名義是主辦組織。站內通知寫進主辦組織。委託人若有自己的組織，跨組織的站內通知還沒有，現在只有 email。
- 修改原因存在 `org.case_social_housing_changes`，稽核事件只放 ID 與旗標值（原因是自由文字，可能含個資）。
- 持有人的判定看分錄：同一筆分錄同時動到 `liability.deposit.{case}` 與一個收款帳戶，押金的增減記在那個帳戶上。扣抵不經收款帳戶，不計入。
- 委託範圍是否含押金，案件上沒有資料，先當 false。

## 測試

`*.test.ts` 與原始檔同目錄，連線是 PGlite 的 `app_rw`。期別切分的表格測試在 `src/lib/receivables`。migration 的約束測試在 `src/lib/pg/case-ledger-schema.test.ts`，讀取矩陣在 `src/lib/pg/case-rls.test.ts`。
