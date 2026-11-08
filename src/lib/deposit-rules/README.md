<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 的對照，句長規則不適用 -->
# `src/lib/deposit-rules/`：押金帳戶規則與押金金額檢查

純函式模組，沒有 I/O。只匯出純函式、常數與型別，不 import `src/lib/db.ts`，不呼叫 `Date.now()`。ID 參數一律 `string`。金額一律是整數新台幣元，用 `Number.isSafeInteger` 檢查。

依據：ADR-0014 決議 13（押金帳戶規則）、ADR-0015 決議 5、6、8（金額、押金台帳不存餘額、扣抵）、MIL-42 Q3。票是 MIL-156，涵蓋 MIL-118 與 MIL-128 不碰資料庫的部分。

這個模組不 import `ledger` 與 `receivables`。接線由母票處理。

## 檔案

| 檔案 | 內容 |
|---|---|
| `holder-rules.ts` | `DEPOSIT_HOLDER_RULES`、`evaluateHolderRule()` 與型別 |
| `messages.ts` | 警告與阻擋的訊息鍵常數 |
| `balance.ts` | `checkDepositBalance()`、`settlementAmounts()` |
| `index.ts` | 三個檔案的匯出 |

## `DEPOSIT_HOLDER_RULES`

ADR-0014 決議 13 的 5 列。`control.deposit_holder_rules` 的 migration 直接讀這個常數寫入。條件欄位為 `null` 表示不限。

| rule_id | 版本 | 業務類型 | 社宅代管案件 | `holder_kind` | 委託範圍含押金 | 動作 | 通知委託人 |
|---|---|---|---|---|---|---|---|
| `DHR-01` | 1 | `managed` | 是 | `manager` | 不限 | `block` | 否 |
| `DHR-02` | 1 | `managed` | 否 | `manager` | 是 | `warn` | 是 |
| `DHR-03` | 1 | `managed` | 否 | `manager` | 否 | `warn_fix_mandate` | 是 |
| `DHR-04` | 1 | `master_lease` | 否 | `lessor` | 不限 | `allow` | 否 |
| `DHR-05` | 1 | 不限 | 不限 | 不限 | 不限 | `allow` | 否 |

業務類型沿用 `src/lib/cases/transitions.ts` 的 `BUSINESS_TYPES`（`self_managed`、`managed`、`master_lease`），本模組重新匯出。`notifyMandator` 對應 ADR 的「通知委託人」，委託人依 GLOSSARY 是委託管理合約的甲方。

## `evaluateHolderRule(rules, ctx)`

取最具體的命中列，也就是條件欄位不是「不限」的數量最多者，同樣具體時取陣列中靠前的。結果與陣列順序無關，`DHR-05` 排在哪裡都不會蓋過具體的列。回傳：

```ts
{
  action: 'allow' | 'warn' | 'warn_fix_mandate' | 'block';
  ruleId: string | null;       // 命中的規則 ID
  ruleVersion: number | null;
  notifyMandator: boolean;
  messageKey: DepositHolderMessageKey | null; // allow 時為 null
}
```

規則陣列為空、缺列、沒有命中，或輸入在執行期不合法（欄位是 `null`、`undefined` 或未知字串）時，一律回傳 `warn`，`ruleId` 與 `ruleVersion` 為 `null`，`notifyMandator` 為 `true`，訊息鍵是 `deposit_holder.warn.rule_unmatched`。持有人確認紀錄的 `rule_id` 存 `null`。

`ctx.mandateIncludesDeposit` 在非代管案件沒有意義，傳 `false`。

## 訊息鍵

`DEPOSIT_HOLDER_MESSAGE_KEYS` 只放鍵，文字內容待法務確認（MIL-62），由介面層的字串表提供。文字不寫「合法」或「違法」，只列公告義務。

## `checkDepositBalance(balance, deduction)`

扣抵或返還後餘額必須不小於 0。回傳 `{ ok: true, remaining }` 或 `{ ok: false, error }`。`deduction` 必須大於 0，`balance` 必須不小於 0，兩者都是安全整數，否則回 `invalid_amount`。扣抵大於餘額回 `insufficient_balance`。呼叫端必須先 `SELECT ... FOR UPDATE` 鎖押金台帳。

## `settlementAmounts(expected, received, deductions)`

押金結算單的金額。回傳 `{ ok: true, amounts: { expected, received, deductionTotal, refundable } }`。

- `refundable = received - deductionTotal`，以已收計算，不以約定金額計算。
- 已收與約定金額不同不算錯誤，例如押金分次收取未收足。
- 扣抵合計超過已收回 `insufficient_balance`。
- 任何一筆金額不是安全整數、扣抵不大於 0、或合計超出安全整數，回 `invalid_amount`。

## 測試

`*.test.ts` 與原始檔同目錄。規則函式用表格窮舉：3 種業務類型乘社宅是否乘 4 種 `holder_kind` 乘委託範圍含押金是否，共 48 個組合。
