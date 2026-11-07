---
status: accepted
---

# 平台不持有款項，入帳確認由轉接層統一

資金一經手，就落入信託業法、電支條例或租賃條例的管制（PRD N1、N3）。Phase 1 的錢在出租人或代管業者的帳戶，平台只記鏡像帳。決議：程式碼沒有任何轉帳或撥款的路徑。入帳確認是系統內唯一的入帳事件，來源由轉接層統一。平台營運者不審核入帳確認，由登錄者負責。Phase 2 加推送來源時，鏡像帳的 schema 不變。

鏡像帳本身的規則見 ADR-0015。

## 決議內容

1. **不持有款項。** 程式碼不得有轉帳、撥款、代收的路徑，也不提供平台名下的收款帳戶（N1）。Phase 1 不提供查帳連結（N5）。平台自己的訂閱費與電子合約費（BRD 第 6 節）不進鏡像帳。金流相關的對外申請在 demo 階段跳過，Phase 2 才做。

2. **平台營運者不審核入帳確認。** 登錄後狀態直接是 `confirmed`，系統記錄登錄者與時間。沒有 `pending_review` 狀態。審核款項會讓平台營運者介入收款認定，與 N3 衝突。登錄者限出租人與委託範圍含收租的代管業者。承租人 Phase 1 不上傳匯款證明。查核靠三件事：

   - 屋主月報標示來源比例，並註明「金額以銀行紀錄為準」（P0-19）。
   - 屋主以案件成員讀帳。
   - 承租人讀押金台帳（P0-21）。

3. **Phase 1 兩種來源。** `source` 是 `manual` 與 `statement_file`，P2 加 `bank_push`、`escrow_push`。對帳檔是使用者上傳自己銀行匯出的檔案。解析用 CSV 加欄位對應，不做逐家銀行的 parser。

4. **轉接層介面。** adapter 是純函式，不碰資料庫。寫入只有一個入口 `confirmReceipt(tx, candidate)`。`ReceiptConfirmed` 是同交易內的函式呼叫，不經訊息佇列。架構 4.1 的 `TrustStatusSource` 不放 Phase 1。

   ```ts
   interface ReceiptSource {
     source: 'manual' | 'statement_file';
     parse(raw: RawInput): ReceiptCandidate[];
   }

   interface ReceiptConfirmed {
     confirmationId: string;
     caseId: string;
     purpose: 'security_deposit' | 'rent';
     amount: number;
     valueDate: string;
     paymentAccountId: string;
     source: 'manual' | 'statement_file';
     trustCaseRefId: string | null; // Phase 1 一律為 null
     evidenceVersionId: string | null;
   }
   ```

5. **識別字不用 `deposit` 表示入帳。** GLOSSARY 的押金是 security deposit，入帳如果也叫 deposit，同一個詞有兩個意思。入帳確認的識別字是 `receipt_confirmations`、`ReceiptConfirmed`，用途是 `security_deposit`、`rent`。`deposit_ledgers` 保留，因為它確實是押金。

6. **inbox 分兩層。** 對帳檔含銀行往來、對方姓名與帳號，不得放在沒有組織 RLS 的表。

   | 表 | 內容 | 隔離 |
   |---|---|---|
   | `control.inbox_messages` | 沒有組織脈絡的推送：點點簽 webhook，P2 的 `bank_push`、`escrow_push` | 權限逐表授予（ADR-0012） |
   | `org.receipt_inbox` | 有組織脈絡的 `manual` 與 `statement_file` 列 | 組織 RLS |

   待配對清單是 `org.receipt_inbox` 的未處理列。P2 推送先寫 `control`，查路由取得組織後，轉進 `org.receipt_inbox`。

7. **去重鍵。** 全部用 `UNIQUE (org_id, source, external_id)`。架構的 `UNIQUE (source, source_ref)` 不含 `org_id`，違反 ADR-0012 的陷阱 6。

   | 來源 | `external_id` |
   |---|---|
   | `statement_file`，有交易序號 | 交易序號 |
   | `statement_file`，沒有交易序號 | 收款帳戶、入帳日、金額、摘要、當日同值序號的 SHA-256 |
   | `manual` | 表單產生的冪等鍵，只防連點 |

   系統另記對帳檔的檔案雜湊。重複匯入時，系統回報重複列數（P0-13 AC3）。重疊區間的檔案靠列的鍵去重。

   `manual` 得不附證據檔。同一證明檔再用時，系統警告並記錄，不阻擋。一張匯款單可能付兩個同額案件，所以不得用證明檔雜湊當唯一鍵。

8. **跨來源重複。** 手動登錄與對帳檔的鍵不同，同一筆款項會入帳兩次。匯入對帳檔時，系統必須比對既有的 `manual` 入帳確認，條件是同收款帳戶、同金額、入帳日相差 3 天內。3 天是假設值。

   命中的列進待配對清單，標示「可能已登錄」，由使用者選同一筆或不同筆。選同一筆時不寫分錄，入帳確認記下佐證的列。P0-19 的來源比例把這筆算成對帳檔。

   無法確定案件與用途的列不得寫分錄。對帳檔的出帳列略過，並回報略過的列數。匯款識別怎麼設定由 E 線 spec 決定。

9. **收款帳戶取代 `custody`。** 架構的 `custody` 混了兩件事：誰持有、帳戶性質。代管業者收款時，`landlord_account` 這個值就是錯的。所有表刪除 `custody`，新增 `org.payment_accounts`：

   | 欄位 | 值 |
   |---|---|
   | `holder_kind` | `lessor`、`owner`、`manager`、`other` |
   | `holder_party_id` | 收款帳戶持有人 |
   | `account_kind` | `general`、`cash`。P2 加 `escrow`、`trust`。用 `text` 加 CHECK |
   | `bank_code`、`account_last4` | 只存遮罩 |

   使用者不選 `account_kind`，介面不顯示，押金帳戶規則不讀。這同時滿足 P0-13 的欄位要求與 MIL-42 的「現在不加帳戶性質欄位」。押金專戶的值等修法草案公布才加。`trust` 只是內部識別字，介面與文件不得用「信託」稱呼收款帳戶（P0-13 規則 2）。

   `trust_case_ref_id` 只留在 `receipt_confirmations`（P2-01），不加在 `cases`。

10. **現金收款。** `account_kind` 的 `cash` 用於現金收取。介面標示「現金收取」，報表單獨列出，不參與對帳檔比對。押金帳戶規則照常適用。沒有這個值時，收現金的出租人登不了帳，或要虛構帳戶。

11. **撥款指示 Phase 1 不建表。** 下列欄位草案只寫在本 ADR，P2 才以 migration 建表。保留方式有兩個：簽署標的的 `subject_type` 能擴充（ADR-0010），事件列舉 P2 加 `disbursement_executed`。

    | 欄位 | 草案 |
    |---|---|
    | `id`、`org_id`、`case_id` | 主鍵與所屬 |
    | `kind` | `sale_release` |
    | `lines` | 每列：收款方、金額、事由 |
    | `total_amount` | 整數新台幣元 |
    | `executor` | `escrow`、`bank` |
    | `required_identity_level` | 簽署人最低驗證等級 |
    | `status` | `draft`、`awaiting_signatures`、`signed`、`submitted`、`executed`、`rejected`、`failed` |
    | `submitted_at`、`executed_at`、`execution_ref` | 執行紀錄 |

    架構 3.18 的 `esign_task_id` 不需要，因為 ADR-0010 以簽署標的連接。同一案件同一時間最多一筆非終態的指示。

    押金結算單是獨立的簽署標的，撥款指示的 `kind` 不含它。押金返還由 `recordDepositReturn()` 直接寫分錄，不走轉接層，因為它是出帳。

12. **`fund_statuses` Phase 1 不建表。** 保留 `fundStatus(caseId, purpose)` 函式當 seam，Phase 1 直接由鏡像帳計算。Phase 1 只有一個來源，另存一份只會增加不一致的機會。P2 才建表並改函式內部，呼叫端不變。

13. **押金帳戶規則。** 規則放在 `control.deposit_holder_rules`，由 migration 寫入，`app_rw` 只能讀。規則屬平台層級，組織不得覆寫，Phase 1 沒有管理畫面。判斷用純函式 `evaluateHolderRule(rules, ctx)`。

    | 業務類型 | 社宅代管案件 | `holder_kind` | 委託範圍含押金 | 動作 | 通知委託人 |
    |---|---|---|---|---|---|
    | 代管 | 是 | `manager` | 不限 | `block` | 否 |
    | 代管 | 否 | `manager` | 是 | `warn` | 是 |
    | 代管 | 否 | `manager` | 否 | `warn_fix_mandate` | 是 |
    | 包租 | 否 | `lessor` | 不適用 | `allow` | 否 |
    | 其他組合 | | | | `allow` | 否 |

    規則的依據與文字限制見 MIL-42 的決議。

    - 登錄持有人與押金用途的入帳確認都必須檢查，對帳檔也一樣。`block` 的列留在待配對清單，不寫分錄。
    - 規則表缺列、沒有命中時視為 `warn`，避免設定錯誤時擋住登錄。
    - `org.deposit_holder_acknowledgments` 記錄規則 ID、版本、確認者與時間。通知委託人走 outbox，與確認紀錄同交易。
    - 警告文字用訊息鍵，不得寫「合法」或「違法」。
    - 修法時改規則列。既有案件不自動變更，用確認紀錄列出受影響案件。

14. **代收交付追蹤。** 約定日數放委託管理合約的欄位。實際交付日是 `funds_handed_over` 分錄的 `effective_date`，押金與代收租金共用這個事件。超過約定日數時，屋主月報必須標示，寫法比照 P0-19 的「逾 5 日」。系統顯示「約定日數」，不得寫成法定期限。

15. **交易範圍。** 所有寫入都走 ADR-0012 的 `withTx`，callback 內不得有外部 API 呼叫。

    - `manual` 在 request handler 內同步完成，不經 worker（P0-13 AC1）。
    - `statement_file` 的解析與存證據檔在交易外。一個交易寫入全部 inbox 列與 `control` 的任務認領列。worker 每列一個交易，一列失敗不影響其他列。
    - 單筆交易的步驟：寫入入帳確認、`postJournal()`、配置應收期別、outbox、稽核事件、inbox 完成。任一步失敗就整筆回滾。重試 5 次仍失敗時，轉人工處理佇列。
    - 入帳確認不推進案件，也不寫案件事件。租賃案件沒有等待押金的狀態，押金進度由押金台帳投影到畫面（MIL-45）。

16. **測試 seam。** `ReceiptSource.parse()` 是純函式，用 fixture 測試。假 adapter 只放測試，用來滿足 P2-01 AC。`evaluateHolderRule()` 是純函式，規則表必須窮舉測試。環境照 ADR-0012，鏡像帳的測試見 ADR-0015。

## Considered Options

- **只接單一銀行 API：** 自動化程度高，但企業專戶的入帳通知 API 未查到，換銀行要重寫。
- **開放銀行：** 標準化，但第三方服務提供者資格受限。
- **平台自己收款再撥付：** 體驗最好，但直接落入牌照管制，與 N1 衝突。
- **平台營運者審核入帳確認（架構 4.1）：** 有第三方查核，但平台營運者介入款項認定，也要人力。
- **Phase 1 只有手動登錄（架構 4.1）：** 少一個來源，但 PE-9 與 P0-13 AC3、AC6 都需要對帳檔。
- **單一 `control` inbox 加欄位加密：** 少一張表，但對帳檔的組織隔離只剩應用層，與 P0-02 相反。
- **證明檔雜湊當 `manual` 的唯一鍵（架構 4.1）：** 能防重用單據，但沒有證明檔時算不出，一張單據付兩個同額案件時也會被擋。
- **押金帳戶規則放 TypeScript 常數：** 同樣能測試，但修法後要改程式碼。放組織層級則會讓組織自行放寬阻擋規則。
- **Phase 1 建撥款指示空表（架構 5.3）：** P2 少一個 migration，但這張沒有寫入者的表要配 RLS 與測試。P0-18 也已確定 Phase 1 不產生撥款指示。
- **Phase 1 建 `fund_statuses`（架構 5.3）：** P2 不用加表，但資料與鏡像帳重複。

## Consequences

- 沒有第三方查核。代管業者少報時，要靠屋主自己發現。**重審條件：** pilot 出現 1 件登錄不實的指控。
- 屋主月報註明「金額以銀行紀錄為準」必須列為 P0-19 的 AC。待改項目記在 MIL-61。
- 匯入對帳檔時，使用者可能多一個判定步驟。`statement_file` 的分錄不會立即全部出現，因為 worker 逐列處理。
- 對帳檔只含當日部分交易時，當日同值序號可能把不同款項誤判為重複。
- 代管業者要把屋主帳戶也登錄為收款帳戶，才記得到代收交付。
- 現金沒有銀行紀錄能比對。GLOSSARY 的鏡像帳定義已加註，報表必須單獨列出。
- 社宅代管案件的押金如果實際進了代管業者帳戶，鏡像帳記不到。這是阻擋規則的既有後果。社宅屬性由誰標記、標錯如何處理，由 E 線 spec 決定。
- 改押金帳戶規則要跑 migration，平台營運者不能自己改。
- P2 要加兩個 migration（撥款指示、款項狀態）。這偏離架構 5.3 的「Phase 2 不改 schema」，但新增表不影響既有表。
- 延伸 ADR-0012：`org` schema 新增轉接層的表，`control` 新增規則表。inbox 的「在 `control`」只適用沒有組織脈絡的推送。

## Action Items

1. E 線 spec 決定匯款識別、對帳檔的欄位對應畫面、社宅屬性的標記方式。
2. pilot 實測跨來源比對的 3 天假設。
3. 架構文件與 PRD 的待改項目記在 MIL-61。

## 編號對應

本 ADR 對應架構文件第 8 節的候選 ADR-0011。正式編號 0011 是部署，0012 是 PostgreSQL 與 RLS，所以本 ADR 取 0014。本 ADR 修訂架構 3.15、3.17、3.18、3.22、4.1、5.3，以及 7.2 決策 2。
