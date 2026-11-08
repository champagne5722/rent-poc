# ledger：鏡像帳純函式

這個模組是鏡像帳裡不碰資料庫的部分（MIL-159，母票 MIL-117）。依據是 ADR-0015 決議 2 到 5、13，與 ADR-0050 決議 1 到 3。

模組只匯出純函式與型別。不建表，不呼叫資料庫，不匯入 `src/lib/db.ts`。時間與 ID 都由參數傳入。表、觸發器與 `postJournal()`、`reverseJournal()` 留在 MIL-117，等 A 線的 MIL-83。

## 規則

- ID 參數一律 `string`，只准英數、底線與連字號，長度 1 到 64。ULID 與 UUID 都符合。
- 金額一律整數新台幣元，必須是 `Number.isSafeInteger`。借貸合計用 `BigInt` 加總，不會因超過安全整數而失真。
- 每列明細恰好一欄大於 0。每筆分錄至少 2 列，借方合計等於貸方合計。
- 失敗時回傳錯誤清單，不丟錯。只有程式寫錯（例如科目 ID 不合法、事件類型重複）才丟 `RangeError`。

## 匯出

| 函式 | 用途 |
|---|---|
| `validateJournal({ lines })` | 檢查列數、科目編碼、金額、每列單邊、借貸平衡。回傳 `{ ok: true }` 或完整錯誤清單。 |
| `buildJournal(registry, input)` | 依事件類型查登錄表，解析 payload，套模板，再用 `validateJournal` 檢查。`eventType` 是開放字串。 |
| `buildReversal(journal, input)` | 產生借貸互換的沖銷分錄。必須帶原因。輸入只收 `OriginalJournal`。 |
| `defineLedgerEvent(input)` | 定義一個事件類型與它的分錄模板。 |
| `createLedgerRegistry(defs)`、`extendLedgerRegistry(base, defs)` | 建立或擴充登錄表。事件類型重複會丟錯。 |
| `defaultLedgerRegistry` | E1 的六個事件。 |
| `bankAccount`、`depositAccount`、`prepaidRentAccount`、`rentIncomeAccount`、`deductionIncomeAccount` | 產生科目編碼。 |
| `parseAccountCode`、`naturalBalance` | 解析科目編碼，算自然方向餘額。 |
| `accountTotals(journals)` | 加總各科目的借方與貸方。 |
| `readId`、`readAmount`、`asRecord` | 寫事件的 `parsePayload` 時用的欄位檢查工具。 |

## 科目編碼

格式固定三段：`{類型}.{名稱}.{ID}`。類型只有 `asset`、`liability`、`income`。

| 科目 | 編碼 |
|---|---|
| 收款帳戶 | `asset.bank.{payment_account_id}` |
| 押金負債 | `liability.deposit.{case}` |
| 預收租金負債 | `liability.prepaid_rent.{case}` |
| 租金收入 | `income.rent.{case}` |
| 扣抵收入 | `income.deduction.{case}` |

收款帳戶用 ID，不用遮罩識別，因為同銀行同末四碼的遮罩識別會撞（ADR-0015 決議 2）。

## E1 的六個事件

| 事件 | payload | 借方 | 貸方 |
|---|---|---|---|
| `receipt_confirmed` | `paymentAccountId`、`deposit`、`rent`、`prepaidRent`（後三項缺值視為 0，合計必須大於 0） | 收款帳戶，合計金額 | 押金、租金收入、預收租金，金額為 0 的不產生明細 |
| `prepaid_applied` | `amount` | 預收租金 | 租金收入 |
| `deposit_deducted` | `amount` | 押金 | 扣抵收入 |
| `deposit_returned` | `paymentAccountId`、`amount` | 押金 | 收款帳戶 |
| `funds_handed_over` | `fromPaymentAccountId`、`toPaymentAccountId`、`amount` | 收受方帳戶 | 交付方帳戶 |
| `reversal` | 不得直接寫入，由 `buildReversal` 產生 | 原分錄的貸方 | 原分錄的借方 |

一筆入帳含押金與租金時，只寫一筆 `receipt_confirmed` 分錄，同一案件。一筆匯款付兩個案件時，呼叫端拆成兩筆（ADR-0015 決議 4）。

## 沖銷

- `buildReversal(journal, input)`：`input` 帶新的 `journalId`、新的 `eventId`、`reason`、`postedAt`、`effectiveDate`。
- 原因去掉前後空白後不得為空。
- 輸入型別是 `OriginalJournal`。`ReversalJournal` 傳進去編譯不過。繞過型別時，執行時以 `reversesJournalId !== null` 拒絕。
- 沖銷分錄的 `reason` 是新欄位。MIL-117 的 `ledger_journals` 必須有對應欄位。

## 新增事件（給 F 線等其他線）

只加事件定義，不改本模組。

```ts
import { defineLedgerEvent, extendLedgerRegistry, defaultLedgerRegistry, readId, readAmount, asRecord } from '@/lib/ledger';

const handoverReleased = defineLedgerEvent({
  type: 'handover_released',
  label: '移交交出側',
  parsePayload: (raw) => { /* 用 asRecord、readId、readAmount 讀欄位 */ },
  template: (payload, { caseId }) => [ /* 借方兩列、貸方一列都可以 */ ],
});

const registry = extendLedgerRegistry(defaultLedgerRegistry, [handoverReleased, handoverReceived]);
```

- `template` 可回傳任意列數。ADR-0024 的移交分錄是「借方兩列（押金、預收），貸方一列」，介面裝得下。`extension.test.ts` 用同樣形狀證明。
- 登錄表由呼叫端組裝。`defaultLedgerRegistry` 只含 E1 的事件。
- 事件類型字串必須是小寫英文加底線，開頭是字母。

## 測試

- `validate.test.ts`、`accounts.test.ts`、`events.test.ts`、`journal.test.ts`、`reversal.test.ts`：表格測試，期望值是手寫字面值。
- `property.test.ts`：種子亂數（mulberry32）產生事件序列，驗證每筆分錄平衡，餘額等於另一套手算模型。
- `extension.test.ts`：測試用的擴充事件，證明核心函式沒有依事件類型分支。另有原始碼守門測試，核心檔案不得出現 E1 事件類型的字串常值。

## 之後 MIL-117 要接的

- `postJournal()` 包 `buildJournal()`：先用這裡的純函式建出並檢查分錄，再寫入資料庫。
- `reverseJournal()` 包 `buildReversal()`。
- 業務函式（`confirmReceipt()` 等）組好 payload，呼叫 `postJournal()`。
- 資料庫觸發器仍是最後一道防線，這裡的檢查不取代它。
