<!-- ste-lint: off -->
<!-- 交接文件給 agent 讀，內容是指向既有文件的清單，句長規則不適用 -->
# C 線交接：登入與組織、三種身分、經理人驗證、案件

先讀 `README.md`。spec 已發佈，見下方「現況」。

## 範圍與依據

- P0-01 三種身分與合約地位、P0-03 執業主體驗證、P0-04 執業人員驗證與效期、P0-05 專任規則分流、P0-09 案件與案件成員。另加介面換字：`src` 畫面的房東、租客改為出租人、承租人，合約 PDF 的出租方標籤，「甲方（房東）」括號字樣。P0-02 的 AC4、AC6（登入與驗證狀態）歸 C 線。P0-11 的 AC3 到 AC5（連結租賃案件、依委託範圍限制動作、終止後權限結束）由 D 線移給 C 線。
- ADR：0012（`control` 放 orgs、users、parties、org_memberships；`registry` 放執業主體、業別、執業人員、任職、核對紀錄；`operator` 脈絡）、0016（案件七態、委託管理案件、八種成員關係、`withCaseMemberTx`、`checkSendPreconditions`、`decideCaseTransition`、worker 計時器 7 條）、0017（驗證三態、三層狀態、第一版人工核對含商工登記、專任四個判定點、效期與換證、`credentialStatusAt`、核對紀錄 append-only、全域登錄）、0018（當事人簽署人由執業主體指派須為組織成員）、0021（D 線過渡期的 `practitionerDirectory` seam 用 seed 假資料，C 線接手）。
- 決議：MIL-39 依 PRD 假設結案（執業主體由其執業人員簽章、同一人兼任只記錄不阻擋）。MIL-42 逾期提醒手動按鈕。
- 登入：承租人 OTP 依 PRD 保守版本（MIL-51 待法務）；行動自然人憑證 P1-08 不做。商工登記 API 與 resim 自動查詢跳過，全部人工，審核台是 C 線的畫面。
- MIL-47 的發現：現有 `AppShell` 不支援 375px，對代管案件的屋主顯示「建立合約」。屋主端與承租人端可能要自己的殼層。

## 依賴

- `control` 與 `registry` 表依賴 A 線。A 線 Q15 定了「A 線用預設組織銜接，`requestContext()` 回傳環境變數指定的組織，C 線只換這個函式」。A 線的 MIL-82 做 `operator` 脈絡與稽核。
- C 線 tickets 的第一張 blocked-by MIL-82，並在 MIL-82 併進 `integration/line-a` 後從那條分支開工。
- 整合分支 `integration/line-c` 從 `integration/line-a` 分出。
- D 線的 MIL-64 Further Notes 列了 C 線要提供的介面：查可簽章人選、`credentialStatusAt` 的輸入事實、任職與執業主體。

## 規格要涵蓋的題目

登入與帳號（屋主、經理人、承租人 OTP、session、`requestContext()`）；組織建立、成員、角色、`authorize()` 的形狀；三種身分的切換與法定稱謂顯示；執業主體與執業人員登錄、平台營運者審核台；核對紀錄欄位與證據檔（vault）；專任規則四個判定點；效期、換證提醒、每月重查的 worker job（接 ADR-0020）；案件如何從現有合約流程長出來、案件成員指派、案件清單與詳情；委託管理案件與委託範圍限制；接手 `practitionerDirectory`；介面換字集中成標籤對照表；屋主端與承租人端的殼層；與 A 線 MIL-82、D 線 MIL-69 的邊界；測試 seam。

## 現況，2026-11-08

- spec：MIL-100，related MIL-35、MIL-78、MIL-64、MIL-94。tickets 12 張，parent 都是 MIL-100：MIL-103、106、108、109、111、112、113、115、116、119、121、122。第一張 MIL-103 blocked by MIL-82。P1 票 MIL-124（識別字與資料庫欄位改名）不在序列裡。
- ADR：0022（email OTP 與伺服器端 session，身分是可切換的脈絡）、0023（案件從建約流程長出，代操作以委託範圍授權，引用 0024）、0017 補充（證據檔與同意書保留）。GLOSSARY 新增身分、組織角色、審核台、代操作。
- 跨線：MIL-78、MIL-64 已留言告知。F 線 MIL-94 的 7 項介面需求對應的票號已送 F 線主控。`currentOwnerSession()` 由 MIL-103 實作，介面換字 MIL-122 只動 `AppShell` 內容與標籤對照表，不碰 `OwnerShell` 與 `shellFor`。
- 待法務確認的 4 項已補進 MIL-62 第 11 到 14 題。真實寄信服務的選定是上線閘門，由使用者 pilot 前決定。
- seam 名稱以 ADR-0021 的 `practiceRegistry` 為準，本文上方的 `practitionerDirectory` 是舊名。
- 採用的決定清單在共用筆記 `line-c-spec-handover.md`。

## 下一步

1. 等 A 線通知 MIL-82 併進 `integration/line-a`。
2. 從 `integration/line-a` 建 `integration/line-c`，照 MIL-103 起的順序派實作子對話，每張票一個 Opus 子對話、自己的 worktree，流程見 README 第 3 節。
3. 動到畫面的票先載入 `impeccable`。
