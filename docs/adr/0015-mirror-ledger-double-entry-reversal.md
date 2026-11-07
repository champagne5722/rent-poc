---
status: accepted
---

# 鏡像帳用 PostgreSQL 雙式分錄，只增不改，更正用沖銷

屋主與代管業者要說明押金與租金的去向。平台不持有款項（ADR-0014），所以要記一份事後不能被改的副本。押金結算還要算清楚扣抵與返還。決議：鏡像帳是 PostgreSQL 內的雙式分錄，只增不改，更正用沖銷分錄。押金台帳是鏡像帳上的業務資料，不存餘額。應收不進鏡像帳。

單式流水帳實作最快，但雙式分錄的一筆分錄能同時回答三件事：欠承租人多少、錢在誰的帳戶、誰的收入。代收交付、持有人變更與沖銷都用得到「錢在誰的帳戶」。單式流水帳要另開欄位記這些。

## 決議內容

1. **鏡像帳的範圍。** 鏡像帳只記款項移動與押金負債的變動。它不是平台的會計帳，也不是出租人或代管業者的會計帳，不得用於報稅（N10）。修繕費不進帳（P0-16）。代管服務費 Phase 1 不單獨入帳。買賣價金不記鏡像帳。

2. **事件與科目。** Phase 1 的 `business_event_type`：

   | 事件 | 借方 | 貸方 |
   |---|---|---|
   | `receipt_confirmed`，押金 | `asset.bank.{payment_account_id}` | `liability.deposit.{case}` |
   | `receipt_confirmed`，租金 | `asset.bank.{payment_account_id}` | `income.rent.{case}` |
   | `receipt_confirmed`，超額部分 | `asset.bank.{payment_account_id}` | `liability.prepaid_rent.{case}` |
   | `prepaid_applied` | `liability.prepaid_rent.{case}` | `income.rent.{case}` |
   | `deposit_deducted` | `liability.deposit.{case}` | `income.deduction.{case}` |
   | `deposit_returned` | `liability.deposit.{case}` | `asset.bank.{payment_account_id}` |
   | `funds_handed_over` | `asset.bank.{屋主帳戶}` | `asset.bank.{代管業者帳戶}` |
   | `deposit_transferred`，同一組織 | `asset.bank.{新帳戶}` | `asset.bank.{舊帳戶}` |
   | `reversal` | 原分錄的貸方 | 原分錄的借方 |

   科目類型是 `asset`、`liability`、`income`。架構的 `rent_due` 與 `receivable` 刪除。科目編碼用收款帳戶 ID，因為同銀行同末四碼的遮罩識別會撞。

3. **資料庫約束。** 延遲約束觸發器與 FORCE RLS 相容，下方有實測結果。架構 4.2 的做法要加下列規則：

   - 觸發器必須掛在 `ledger_journals` 與 `ledger_entries` 兩張表。只掛明細時，沒有明細的分錄會過關。每筆分錄至少 2 列明細，借方合計等於貸方合計。
   - `ledger_journals.posted_txid` 記錄建立分錄的交易。`ledger_entries` 的 BEFORE INSERT 觸發器必須拒絕其他交易的寫入。否則能對已提交分錄追加一對平衡明細。
   - 檢查函式必須比對 `app.org_id` 與該列的 `org_id`。缺少這條時，提交前切換組織脈絡會讓函式讀到 0 筆，不平衡分錄就能提交。
   - UPDATE 與 DELETE 由列層級觸發器禁止，TRUNCATE 由語句層級觸發器禁止。`app_rw` 只有 SELECT 與 INSERT。
   - `ledger_entries` 必須有 `org_id` 與 `case_id`，用複合外鍵 `(org_id, case_id, journal_id)`。業務唯一鍵都含 `org_id`（ADR-0012 陷阱 5、6）。
   - `CHECK`：`debit` 與 `credit` 都不得為負，兩欄恰好一欄大於 0。

4. **沖銷。**

   - 沖銷分錄的明細必須與原分錄借貸相反，由觸發器雙向比對。
   - `UNIQUE (org_id, reverses_journal_id)` 確保一筆分錄最多被沖銷一次。
   - 不得沖銷沖銷分錄。
   - 更正等於沖銷加一筆新的入帳確認，發新的業務事件 ID。`UNIQUE (org_id, business_event_type, business_event_id)` 會擋下用舊 ID 重寫。
   - 一筆分錄只屬於一個案件。一筆匯款付兩個案件時，拆成兩筆入帳確認。
   - 報表月份依 `posted_at`，銀行日看 `effective_date`（P0-19 AC4）。

5. **金額。** 金額是整數新台幣元。資料庫用 `bigint`，應用層轉 `number` 並檢查 `Number.isSafeInteger`。架構的 TS `bigint` 不採用，因為 `JSON.stringify` 遇 BigInt 會丟錯。

6. **押金台帳。** `deposit_ledgers` 只存 `case_id`、`expected_amount`、`status`。`status` 與分錄同交易更新。餘額一律由 `liability.deposit.{case}` 即時加總。架構的 `custody`、`bank_account_ref`、`virtual_account_no` 刪除，持有人來自收款帳戶（ADR-0014）。

   押金餘額不得為負。這項檢查放應用層，先 `SELECT ... FOR UPDATE` 鎖 `deposit_ledgers`，避免兩筆扣抵並行。

   押金進度只投影到畫面，案件狀態不因押金變動（MIL-45）。

7. **約定不寫分錄。** 約定沒有款項移動，雙式分錄寫不出它。約定金額存在 `expected_amount`，台帳畫面第一列仍顯示約定金額。分錄類型實際有四種：收取、扣抵、返還、移交。

8. **扣抵與異議。** `deposit_deductions` 存原因、證據與異議狀態。扣抵登錄時就寫分錄。承租人標示異議時不改分錄（P0-14 AC5）。

9. **移交。**

   - 同一組織內持有人變更：寫 `deposit_transferred`，負債不變。
   - 跨組織：`withTx` 只有一個組織脈絡，所以寫兩筆分錄、兩個交易。舊組織借負債、貸舊帳戶，在生效日寫。新組織借新帳戶、貸負債，在接手時寫。業務事件 ID 都是移交包 ID，靠唯一鍵冪等重試。
   - 分錄不加 hash chain。移交包的「鏡像帳的 hash」（P0-22 規則 3）是帳務快照內容的雜湊。
   - 所有權讓與後案件怎麼接，由 F 線 spec 決定。

10. **押金結算單與鏡像帳的關係。** 押金結算單是獨立的簽署標的（MIL-45）。資料表與簽署由 E 線 spec 決定，本決議只定下列關係：

    - 結算單的金額由押金台帳與 `deposit_deductions` 產出（P0-18 AC1），並記下產出時的餘額快照。
    - 產出與簽署結算單都不寫分錄。扣抵的分錄在登錄時已寫。
    - 送簽後如果餘額變動，系統必須要求撤回後重新產出。
    - 結算單完成後，出租人自行匯款，再由 `recordDepositReturn()` 寫 `deposit_returned`。分錄金額是實際匯款的金額。
    - 餘額為 0 時，押金台帳改為 `settled`，系統產出退還證明（P0-18 AC3）。

11. **應收期別。** 應收只放 `receivable_periods`，配置放 `receipt_allocations`。應收期別在合約全員完成時產生（MIL-45）。

    - 未入帳、部分入帳、已入帳：由配置金額加總算出，不存。
    - 逾期：每日排程寫 `overdue_at`（P0-15），用來避免重複通知。足額後顯示已入帳。
    - 預收：期別沒有這個狀態。預收是 `liability.prepaid_rent.{case}` 的餘額。抵充由使用者選擇（P0-13 AC5），寫 `prepaid_applied` 與配置。
    - 一筆付多期：預設配給最舊的未足額期別，使用者得改。超額記預收。
    - 沖銷時，配置列標記失效，期別狀態重算。
    - 提前終止時，尚未到期的期別改 `cancelled`。

12. **承租人讀取。** `ledger_journals` 與 `ledger_entries` 必須有案件成員的讀取政策，條件依 `case_members` 的 `self_read`（ADR-0012）。view 必須設 `security_invoker = true`。

13. **模組邊界與測試。** 只有 `ledger` 模組能呼叫 `postJournal()`、`reverseJournal()`，其他模組呼叫 `recordDepositDeduction()` 這類業務函式。期別狀態計算是純函式。

    - 環境照 ADR-0012：PGlite、`clone()`、`SET ROLE app_rw`。
    - 下方的實測情境必須轉成 migration 測試。
    - 性質測試：隨機事件序列後，每筆分錄平衡，餘額等於手算結果。
    - 真實 PostgreSQL 容器測併發：同一 inbox 列、同一押金並行扣抵。

## 實測結果

環境是 PGlite 0.5.15，回報 PostgreSQL 18.6，日期 2026-11-07。結果沒有在 Cloud SQL 或 Neon 重跑。併發沒有測，因為 PGlite 只有單一連線。測試時的沖銷比對只有單向，正式版必須雙向。

| 情境 | 結果 |
|---|---|
| `app_rw` 寫平衡分錄，表設 FORCE | 成功 |
| 不平衡分錄 | 提交時被擋 |
| 沒有明細的分錄 | 被擋。檢查只看平衡的控制組會提交成功 |
| 對已提交分錄追加一對平衡明細 | 被擋 |
| `app_rw` 的 UPDATE、DELETE、TRUNCATE | `permission denied` |
| `app_owner` 的 UPDATE、TRUNCATE | 觸發器擋下 |
| 同一筆分錄第二次沖銷 | 唯一鍵擋下 |
| 金額不對映的沖銷 | 觸發器擋下 |
| 沖銷後用同一業務事件 ID 再寫分錄 | 唯一鍵擋下 |
| A 組織脈絡寫 B 組織的分錄 | RLS 擋下 |
| A 組織的明細引用 B 組織的科目 | 複合外鍵擋下 |
| 明細的案件與分錄的案件不同 | 複合外鍵擋下 |
| 不平衡分錄，提交前切換 `app.org_id` | 被擋。沒有這項檢查的控制組會提交成功 |
| 別的組織用相同業務事件鍵 | 成功 |
| 沒有組織脈絡的承租人讀明細 | 只讀到自己案件的列 |

## Considered Options

- **外部帳本服務：** 帳本能力完整，但與案件資料無法同交易，要另一套 outbox 與對帳，也多一個供應商。
- **單式流水帳：** 實作最快，但無法證明借貸平衡，也無法表達沖銷與資金位置。
- **可更新的餘額表：** 寫得快，但歷史被覆寫。
- **應收進鏡像帳（架構 3.16 的 `rent_due`）：** 能只靠分錄算應收，但應收沒有款項移動，提前終止或減免時還要寫沖銷。
- **約定寫成分錄（PRD P0-14）：** 五種類型放同一張表，但約定沒有對應的借貸。
- **架構 4.2 的約束原案：** 較簡單，但實測會放行沒有明細的分錄，也會放行提交前切換組織脈絡的不平衡分錄。
- **分錄加 hash chain：** 防竄改較強，但稽核紀錄已有 hash chain，移交包只需要快照雜湊。

## Consequences

- 任何金額更正都要兩筆分錄與一筆新的入帳確認。使用者要重新登錄一筆。
- 使用者看不懂借貸，介面只顯示收取、扣抵、返還。
- 報表的「應收」讀應收期別，「已入帳」讀配置與分錄，無法只靠分錄加總。
- 有異議時，餘額已先扣。
- 跨組織移交有短暫的中間狀態，移交包必須顯示完成與否。
- 期別清單要加總配置。300 個租賃單位的量不構成問題，Phase 1 結束前要依實際量再確認。
- 觸發器只在 PGlite 實測。實際開機前，必須在 Cloud SQL 重跑。
- 每日分錄超過 1 萬筆或需要多幣別時，重新評估外部帳本服務。

## Action Items

1. 在 Cloud SQL 重跑實測情境。
2. E 線 spec 定 `ledger` 模組介面、結算單資料表、押金台帳的建立時點。
3. Phase 2 前實作每日對帳與 `recon_exceptions`。

## 編號對應

本 ADR 對應架構文件第 8 節的候選 ADR-0012。正式編號 0012 是 PostgreSQL 與 RLS，所以本 ADR 取 0015。本 ADR 修訂架構 3.15、3.16、4.2，以及 PRD P0-14 的分錄類型。
