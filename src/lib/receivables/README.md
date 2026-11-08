# receivables：應收期別純函式

MIL-155，母票 MIL-123，涵蓋 MIL-125、127、130 的純函式部分。依據是 ADR-0015 決議 11 與 ADR-0050 決議 3 到 5、13。

這個模組只匯出純函式與型別。它不建表、不呼叫資料庫、不讀系統時鐘。期別與分錄的接線留給 MIL-123。

## 約定

- ID 一律 `string`。
- 金額一律整數新台幣元，檢查 `Number.isSafeInteger`。
- 日期一律 `YYYY-MM-DD`，代表台灣當地日期。
- 時間由參數傳入。`toTaipeiDate(instant)` 把含時區的 ISO 時間換成台灣日期，給呼叫端產生 `today`。
- 輸入資料不合法（日期格式、付款日、月租）丟 `RangeError`。
- 使用者操作可能違反的業務規則回傳 `{ ok: false, reason }`，不丟例外。
- 函式不改動輸入，也不產生 ID。配置函式回傳「要寫的草稿」與「要失效的舊配置 id」。

## 函式

| 函式 | 作用 |
| -- | -- |
| `splitPeriods(contract)` | 依租期切出期別草稿 |
| `cancelPeriodsAfter(periods, terminationDate)` | 提前終止，終止日之後的期別改 `cancelled` |
| `allocateReceipt(periods, amount, options)` | 一筆租金入帳的配置，超額回傳預收 |
| `applyPrepaid(period, prepaidBalance, amount, options)` | 以預收抵充某一期 |
| `reallocate(allocations, changes, periods)` | 改配置，舊的失效、新的寫入、合計不變 |
| `periodStatus(period, allocations)` | `unpaid`、`partial`、`paid`、`cancelled` |
| `isOverdue(period, allocations, graceDays, today)` | 是否逾期 |
| `shouldConfirmReminder(lastReminderAt, now)` | 24 小時內再按提醒是否要確認 |
| `handoverDelayLabel(agreedDays, handedOverAt, receivedAt, isSocialHousing, today?)` | 代收交付逾期標示鍵 |

另有輔助 `allocatedAmount`、`outstandingAmount`、`toTaipeiDate`。

## 規則

### 期別切分

- 一期等於一個日曆月，期別是該月與租期重疊的部分。起訖日都含。期別鍵是 `YYYY-MM`。
- 到期日是該月付款日。該月沒有那天時取月底。
- 首期的到期日取「該月付款日」與「期別起日」較晚者。這是 spec 字面之外的調整，避免建立當天就逾期。後續期別不受影響。
- 首末期不足一個月時，金額等於月租乘重疊日數除以該月日數。四捨五入到元，半數進位。全程整數運算。
- 按比例是假設，待訪談驗證。

### 提前終止

- 期別起日晚於終止日的期別改 `cancelled`。
- 終止日所在的期別不調整金額，也不取消。

### 配置

- 預設配給到期日最舊的未足額期別，放不下再往下一期。全部配滿後的剩餘是預收。
- 使用者得用 `periodOrder` 指定優先順序，其餘照預設順序補。
- 已取消與已足額的期別跳過。
- 押金不進應收期別。期別與配置的 `kind` 型別固定為 `'rent'`，押金期別編譯不過。執行時再擋一次，回傳 `wrong_kind`。
- 預收抵充由使用者選擇，系統不自動抵充。金額不得超過預收餘額，也不得超過該期未足額金額。
- 改配置全有或全無。新金額合計必須等於原金額。改完後任何期別都不得超過應收金額，也不得配到已取消的期別。

### 狀態與逾期

- 狀態只看有效配置（`active: true`）。失效的配置不計。
- 已取消的期別回傳 `cancelled`。
- 逾期：今天晚於「到期日加寬限天數」，而且期別未足額。寬限最後一天不算逾期，寬限次日才算。
- 已取消與已足額的期別不逾期。
- 寬限天數預設 3 天是假設，預設值由呼叫端的組織設定提供，不寫在這個模組。

### 提醒確認

- 距上次手動提醒不滿 24 小時回傳 `true`。剛好 24 小時回傳 `false`。
- 從沒提醒過回傳 `false`。上次時間晚於現在視為仍在 24 小時內。

### 代收交付標示

- 經過日數是入帳日到交付日的日曆日數。尚未交付時，以 `today` 計算。沒有 `today` 回傳 `null`。
- 社宅代管案件超過 5 日，回傳 `over_social_housing_5_days`。它優先於約定日數。
- 其餘情況超過約定日數，回傳 `over_agreed_days`。`agreedDays` 是約定日數，`elapsedDays` 是實際經過日數。
- 系統顯示的是約定日數，不是法定期限。

## 測試

```
npx vitest run src/lib/receivables
```

- 表格測試涵蓋期別切分、配置、狀態與逾期的邊界。
- 性質測試用自己寫的種子亂數，沒有新增套件。它驗證改配置前後有效配置的合計不變，且沒有期別超配。
- `purity.test.ts` 檢查模組不讀系統時鐘，也不匯入模組外的檔案。
