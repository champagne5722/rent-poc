# statement-import：對帳檔匯入純函式

MIL-157，母票 MIL-129，涵蓋 MIL-132 的純函式部分。依據是 ADR-0014 決議 3、6、7、8，ADR-0050 決議 6 到 8。

這個模組只匯出純函式與型別。它不建表、不呼叫資料庫、不讀系統時鐘、不讀檔案。inbox 表、worker、匯入畫面、待配對清單畫面留給 MIL-129 與 MIL-132。

## 約定

- ID 一律 `string`。
- 金額一律整數新台幣元，檢查 `Number.isSafeInteger`。
- 日期一律 `YYYY-MM-DD`，代表台灣當地日期。
- 輸入資料不合法（金額不是整數、日期格式、匯款識別格式）丟 `RangeError`。
- 使用者資料造成的失敗（CSV 壞列、配對不成立、拆分金額不符）回傳結果物件，不丟例外。
- 函式不改動輸入。
- 這個模組沒有 import `receivables`。它的型別（`FundKind`、期別、配置）和這裡沒有交集。用途用 `'security_deposit' | 'rent'`，依 ADR-0014 決議 4 的 `ReceiptConfirmed`。

## 函式

| 函式 | 作用 |
| -- | -- |
| `detectEncoding(bytes)` | 回傳 `'utf-8'` 或 `'big5'` |
| `decodeStatement(bytes)` | 偵測編碼並解成文字，去掉 BOM |
| `parseStatementCsv(text, mapping)` | 依欄位對應輸出標準列、略過列數、錯誤 |
| `parseStatementDate(raw)` | 西元或民國年日期轉 `YYYY-MM-DD`，無法解析回傳 `null` |
| `parseStatementAmount(raw)` | 金額儲存格轉帶正負號的整數元 |
| `externalIdFor(row, accountId)` | 去重鍵 `external_id` |
| `matchStatementRow(row, facts, options?)` | 自動配對，回傳案件與用途，或進待配對清單的原因 |
| `validateSplit(rowAmount, parts)` | 拆分金額檢查 |

## 編碼

用 Node 內建的 `TextDecoder`，不加套件。能嚴格解成 UTF-8 就是 UTF-8，否則視為 Big5。純 ASCII、空檔案與帶 BOM 的檔案都是 UTF-8。

## 欄位對應

`ColumnMapping` 的值是 CSV 表頭的欄位名稱。每個收款帳戶存一組，由 MIL-129 儲存。

- 金額欄二選一：`{ deposit, withdrawal? }` 存入與支出兩欄，或 `{ signed }` 單一金額欄，正數是存入，負數是支出。
- `summary`、`counterpartyName`、`counterpartyAccount`、`transactionSerial` 選填，沒對應時值為空字串（序號為 `null`）。
- 表頭之前的說明列會被略過。表頭是第一個含有全部對應欄位的記錄。
- 找不到表頭時回傳 `header_not_found`，`detail` 列出命中最多的那一列缺的欄位，沒有任何成功列。
- 分隔字元預設逗號，得改成 Tab 或分號。

### 日期

年份 4 位是西元，1 到 3 位是民國。接受 `-`、`/`、`.` 分隔、中文「年月日」（得加「民國」）與純數字（8 位西元、7 位民國）。時間部分會被忽略。

### 金額

接受千分位逗號、`+`、`-`、括號負數、`NT$` 與 `$`。小數部分為 0 時接受（`1,000.00`）。零元與空白視為沒有金額。

### 出帳列、空列與錯誤

- 出帳列不進成功列，計入 `skippedCount`（ADR-0014 決議 8）。
- 空列計入 `blankCount`，不是略過也不是錯誤。
- 壞掉的列進 `errors`，不影響其他列。`lineNo` 是檔案行號，從 1 起算。
- 存入與支出兩欄同時有值回傳 `amount_conflict`。存入欄是負數回傳 `invalid_amount`。

### 當日同值序號

`StatementRow.sameDaySeq` 是同一檔案內，交易日、存入金額、摘要都相同的入帳列，依出現順序由 1 起算。沒有交易序號時，`externalIdFor` 用它區分同日同值的兩筆款項。

重疊區間的檔案若從當日中間切開，同值序號會不同，可能把同一筆誤認為新的一筆。這是 ADR-0014 Consequences 已記載的限制。

## external_id

- 有交易序號：直接用序號（去掉前後空白）。
- 沒有：SHA-256（十六進位小寫），內容是 `JSON.stringify([收款帳戶 ID, 入帳日, 金額, 摘要, 當日同值序號])`。對方戶名與行號不參與，讓重疊區間的檔案得到同一把鍵。

**已知風險：** 去重鍵是 `UNIQUE (org_id, source, external_id)`，不含收款帳戶。不同收款帳戶的交易序號相同時，會被誤判為重複。本函式照 ADR-0014 決議 7 的字面實作。MIL-129 實作資料層時必須決定是否在序號前加帳戶前綴，並修訂 ADR-0014。

## 自動配對

`matchStatementRow(row, facts)` 的 `facts` 由呼叫端查好，函式不查資料。

| 條件 | 原因鍵 | 判斷方式 |
| -- | -- | -- |
| 1 收款帳戶相同 | `payment_account_mismatch` | 案件的 `paymentAccountIds` 必須含匯入帳戶。清單是空的算不成立 |
| 2 匯款識別命中恰好一個案件 | `no_remitter_match`、`ambiguous_remitter` | 見下 |
| 3 用途能判定 | `purpose_undeterminable` | 押金未收足且金額等於差額是押金。押金已收足是租金，金額不限。其餘無法判定 |
| 4 押金帳戶規則不是 `block` | `deposit_rule_blocked` | 只在押金用途檢查。租金不受影響 |
| 5 沒有跨來源重複 | `possible_duplicate_manual` | 同收款帳戶、同金額、入帳日相差 3 天內（含）的 `manual` 入帳確認 |
| 6 合約已完成 | `contract_incomplete` | 案件的 `contractCompleted` |
| 現金收取帳戶不參與比對 | `cash_account` | 匯入帳戶的 `kind` 是 `cash` |

### 結果

成功回傳 `{ ok: true, caseId, purpose, holderRuleAction }`。失敗回傳 `{ ok: false, reason, reasons, ... }`。

- `reasons` 列出所有「能判斷且不成立」的條件，依上表條件順序。`reason` 是第一個。
- 沒有命中案件時，帳戶、用途、規則、合約都無從判斷。合約未完成時沒有押金台帳，用途與規則無從判斷。用途無法判定時，規則無從判斷。
- 跨來源重複只看列本身，所以沒有命中案件時也會回報，並附 `duplicateCandidateIds` 給「可能已登錄」的畫面用。
- `cash_account` 直接回傳，不判斷其他條件。

### 匯款識別

- 戶名：兩邊都做 NFKC 正規化、去掉所有空白、轉小寫後必須完全相同。空戶名不命中。
- 帳號末五碼：取列的對方帳號中所有數字的最後五碼。不足五碼不命中。遮罩帳號（`***43210`）能命中。
- 一個案件有任一識別命中就算命中該案件。兩個以上案件命中回傳 `ambiguous_remitter`，不挑一個，並列出 `ambiguousCaseIds`。

### 呼叫端的責任

- `depositHolderRuleAction` 由呼叫端用 `evaluateHolderRule`（MIL-156）算好再傳入。本函式只擋 `block`。`warn` 與 `warn_fix_mandate` 照樣配對成功，並在 `holderRuleAction` 回傳，由呼叫端決定是否通知委託人。
- `manualReceipts` 必須排除已被標示為「同一筆」佐證的入帳確認，否則同一筆手動登錄會擋住之後所有同額的列。
- `receivedAmount` 必須是扣除沖銷後的已收押金。
- 3 天是假設值，待訪談驗證。常數 `CROSS_SOURCE_DUPLICATE_WINDOW_DAYS`，得用 `options.duplicateWindowDays` 覆寫。

## 拆分

`validateSplit(rowAmount, parts)` 檢查待配對清單的「拆給多個案件」。

- 每筆金額必須是正整數元，否則 `invalid_part_amount`。
- 同一案件同一用途不得出現兩次，否則 `duplicate_case_purpose`。同一案件的押金與租金得分成兩筆。
- 合計必須等於該列，否則 `sum_mismatch`。
- 沒有任何拆分回傳 `no_parts`。

## 測試

- fixture 放在 `fixtures/`，全部是虛構資料。`basic-big5.csv` 由 `basic-utf8.csv` 以 `iconv -t BIG5` 轉出。
- `purity.test.ts` 檢查模組不用系統時鐘、亂數，只 import 同目錄檔案與 `node:crypto`。
