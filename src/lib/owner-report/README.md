<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 與票的對照，句長規則不適用 -->
# `src/lib/owner-report/`：屋主月報表彙總與 CSV

純函式模組，沒有 I/O。MIL-160，母票 MIL-134。依據是 MIL-47 結案留言的欄位定案、ADR-0050 決議 14、15、ADR-0015 決議 4、ADR-0014 決議 10、14。

只匯出純函式、常數與型別。不建表、不呼叫資料庫、不 import `src/lib/db.ts`、不讀系統時鐘。ID 一律 `string`，金額一律整數新台幣元（`Number.isSafeInteger`），日期一律 `YYYY-MM-DD`（台灣日期），時間（`generatedAt`、`postedAt`）由呼叫端傳入，必須含時區。

不產 PDF。快照表、PDF 雜湊、產出畫面、依 party 讀取留在 MIL-134，等 A 線 MIL-83。

相鄰模組：型別與常數直接 import，不重複定義，也不修改它們。

| 來源 | 用到的東西 |
|---|---|
| `ledger` | `Journal` 型別、科目編碼函式、`accountTotals`、`naturalBalance`、E1 事件定義的 `type` |
| `receivables` | `ReceivablePeriod`、`Allocation`、`isOverdue`、`outstandingAmount`、`allocatedAmount`、`handoverDelayLabel`、`toTaipeiDate` |
| `deposit-rules` | `BusinessType`、`HolderKind` 型別 |

## 匯出

| 名稱 | 用途 |
|---|---|
| `buildOwnerReport(input, month, options)` | 回傳 `OwnerReport`。`month` 是 `YYYY-MM`。 |
| `reportToCsv(report)` | 長格式 CSV 字串，開頭是 BOM。 |
| `reportToCsvRows(report)` | CSV 展開後的資料列，給測試與預覽用。 |
| `OWNER_REPORT_NOTES`、`IMMUTABLE_STATEMENT`、`CSV_SECTIONS`、`OWNER_REPORT_CSV_COLUMNS`、`CSV_BOM` | 固定文字與欄位常數。 |

```ts
const report = buildOwnerReport(input, '2026-10', {
  ownerId, ownerName, orgId, producerName, producerLegalTitle,
  reportId, generatedAt, graceDays,
  varianceNotes: { [handoverId]: '扣代管服務費 500' }, // 產出畫面填的差額說明
});
const csv = reportToCsv(report);
```

## 範圍

報表單位是屋主乘產出組織乘月份。`buildOwnerReport` 只取 `ownerId` 與 `orgId` 都符合的單位，其他屋主、其他組織的資料即使混在輸入裡也不計入（範圍測試與性質測試驗證）。

呼叫端要給的分錄，是這些案件到月底為止的全部分錄，含更早月份。餘額靠它加總。沖銷分錄的原分錄不在輸入內時丟 `RangeError`，不默默算錯。

## 區段與規則

| 區段 | 規則 |
|---|---|
| 抬頭 | 屋主、期間、產出者法定稱謂與名稱、報表編號、產生時間、不可變聲明。 |
| 摘要 | 應收租金、已入帳、月底累計逾期、預收餘額、押金餘額，由各單位的列加總。 |
| 租金 | 應收是本月期別的金額。**已入帳是月底當時配置到本月期別的金額**，補繳上月不算本月已入帳。**逾期是月底累計未足額**，全部已逾期期別的未足額金額，上月欠租不會消失。預收是 `liability.prepaid_rent.{case}` 月底餘額。 |
| 押金 | 約定（台帳）、已收、本月扣抵、本月返還、月底餘額、收款帳戶持有人、備註（確認者與約定日數）、扣抵明細。已收與本月欄位是淨額：沖銷會抵銷原分錄的影響。 |
| 修繕 | 月底仍未完成的紀錄（含沒有費用的），加本月完成或取消的紀錄。費用只記錄。 |
| 代收代付與交付 | 代收日、代收金額、交付日、交付金額、交付天數、約定日數、標示、差額、差額說明。Phase 1 沒有代付事件，不列代付。 |
| 需要留意 | 由其他區段推導。順序是逾期、押金未交付、代收交付逾期。 |
| 入帳與沖銷明細 | 本月登錄的入帳（一筆含押金、租金、預收時拆列）與沖銷列。沖銷列金額是負數。 |
| 來源比例 | 依金額列出手動、對帳檔、現金收取。 |
| 註記 | 四條固定文字。 |

### 報表月份依 `posted_at`

月份看分錄 `posted_at` 轉成台灣日期（`toTaipeiDate`），銀行日 `effectiveDate` 只是顯示欄位。上月分錄在本月被沖銷時，本月出現沖銷列，上月報表用同一份輸入重算，結果不變。

### 月底當時的配置

`ReportAllocation` 比 `Allocation` 多 `postedAt` 與 `deactivatedAt`。月底後才寫入的配置不計，月底後才失效的配置，月底當時仍算有效。這樣同一份輸入重算上月報表不會被本月的改配置影響。期別的 `state: 'cancelled'` 沒有時間欄位，以輸入當下為準。

### 需要留意

- 逾期：月底累計未足額大於 0 的單位。
- 押金未交付：代收的押金（`fundKind: 'deposit'`）交付日為空，或交付日晚於月底。交付後離開。
- 代收交付逾期：社宅代管案件代收租金超過 5 日標示「逾 5 日」，優先於約定日數。超過約定日數標示「逾約定 N 日」。邏輯直接用 `handoverDelayLabel`。社宅的 5 日規定只套用代收租金，代收押金只看約定日數。
- 代收押金既未交付又逾期時只出一項，標示用逾期文字。

約定日數取自單位的 `agreedHandoverDays`（委託管理合約，ADR-0014 決議 14）。系統顯示的是約定日數，不是法定期限。

### 差額與差額說明

差額 = 代收金額 − 交付金額，尚未交付為 `null`。說明由 `options.varianceNotes[handoverId]` 提供，前後空白會去掉。已交付、差額不為 0、卻沒有說明的 `handoverId` 列在 `pendingVarianceNotes`，產出畫面據此要求填寫。

### 來源比例

來源由入帳確認的 `source`（`manual`、`statement_file`）決定。收款帳戶是現金帳戶（`isCash`）時，一律算「現金收取」。

- `totalAmount` 是本月全部入帳金額，不扣沖銷，等於入帳明細中入帳列的合計。沖銷另列在明細，比例不為負。
- `basisPoints` 是百分比乘 100 的整數，用最大餘數法，合計一定是 10000。沒有入帳時全是 0。

## CSV

ADR-0050 決議 15。UTF-8 加 BOM，行尾 CRLF，欄位依 RFC 4180 加引號。標題列九欄：區段、租賃單位 ID、門牌、項目、日期、金額、來源、標示、說明。

- 欄位型區段（抬頭、摘要、租金、押金、代收代付與交付）每個欄位一行。紀錄型區段（需要留意、修繕、入帳與沖銷明細、來源比例、註記）每筆紀錄一行。
- 比 ADR 列的區段多一個「抬頭」，讓 CSV 單獨拿出來也知道屬於哪位屋主、哪個月、哪份報表。
- 來源欄用 `manual`、`statement_file`、現金收取。標示欄用「逾期」「逾 5 日」「逾約定 N 日」「已被沖銷」，另有「押金未交付」。
- 金額欄是整數，沖銷列是負數，沒有金額的列留空。
- 文字欄位以 `=`、`+`、`-`、`@` 開頭時前面加單引號，避免試算表當公式執行。金額欄不加。

## 假設（待訪談驗證，照 MIL-47 定案做）

- 修繕區段要不要列「未完成且沒有費用」的紀錄：目前列。
- 押金扣抵與返還每月都列。
- 來源比例依金額，不依筆數。
- 逾期的寬限天數由呼叫端傳入（組織設定，預設 3 天是假設）。

## 測試

```
npx vitest run src/lib/owner-report
```

- `rent.test.ts`：屋主與組織範圍、已入帳、補繳上月、累計逾期跨月、月底當時的配置、預收。
- `deposit.test.ts`：押金各欄、沖銷上月扣抵、持有人與備註。
- `handover.test.ts`：逾 5 日、逾約定 N 日、押金未交付進出需要留意、差額與說明。
- `ledger-detail.test.ts`：入帳拆列、`posted_at` 切月、上月沖銷出現在本月、來源比例。
- `repairs.test.ts`：修繕納入規則、抬頭與註記。
- `csv.test.ts`：BOM、九欄、每個區段都有行、引號與換行、公式防護。
- `property.test.ts`：種子亂數（mulberry32，不新增套件）驗證來源比例合計、屋主隔離、CSV 行數。
- `purity.test.ts`：不讀系統時鐘，只 import 同模組與三個相鄰純函式模組。
- `fixtures.ts` 只給測試用，分錄經 `ledger` 的 `buildJournal` 與 `buildReversal` 產生。

## 之後 MIL-134 要接的

- 依 party 讀取，把資料庫資料轉成 `OwnerReportInput`，再呼叫 `buildOwnerReport`。
- 產出時把 `OwnerReport` 整份存成快照，連同 PDF 雜湊。快照不得修改。
- PDF 版面讀 `OwnerReport`，不重算。
