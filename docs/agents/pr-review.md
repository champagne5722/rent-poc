# PR 自動審查

每張 PR 由 CI 呼叫一次 Claude，審查 Standards、Spec、安全三面，結果貼成 PR 上的一則留言。主控讀這則留言，決定合併或退回。

這個工作取代主控收票時由子代理做的兩面審查閱讀。子代理的用量扣訂閱額度。CI 用 API 金鑰呼叫，扣的是 Max 方案附的 API 額度（MIL-215）。

## 檔案

| 檔 | 用途 |
|---|---|
| `.github/workflows/pr-review.yml` | 觸發條件、權限、上限值、模型。 |
| `.github/pr-review-prompt.md` | 給模型的審查指示。主控能直接改。 |
| `scripts/ci/pr-review.mjs` | 流程：讀 PR、量長度、呼叫 API、貼留言。 |
| `scripts/ci/pr-review-core.mjs` | 純函式：判斷、截斷、結構化輸出、錯誤分類、留言格式。 |
| `scripts/ci/pr-review.test.mjs` | 單元測試，用假的 client，不連網路。 |
| `scripts/ci/review-deps/` | 官方 SDK 的版本與雜湊。與根目錄的 `package.json` 分開。 |

## 它做什麼

1. PR 開啟、推送、重新開啟或標為 ready for review 時觸發。draft PR 也審查。
2. 只審 base 是 `integration/line-c` 或 `dev` 的 PR。來自 fork 的 PR 不執行。
3. 工作取出兩份程式碼。base 分支放腳本、提示詞與依據文件，PR 的合併 commit 只用來取 diff。
4. 腳本用 `git diff -U20` 取 PR 的變更，連同標題與本文送給模型。
5. 腳本先用免費的 `count_tokens` 量輸入。超過上限時縮小 diff，最多量 3 次。
6. 腳本呼叫一次 Messages API。模型回結構化 JSON，腳本把它排成固定格式的留言。
7. 同一張 PR 只有一則審查留言。重跑時更新它。

## 為什麼用自己的腳本，不用 `claude-code-action`

Max 方案附的 API 額度涵蓋 Claude API、Managed Agents 與 Claude Agent SDK，不涵蓋 Claude Code。官方原文列「Claude Code：No」。`claude-code-action` 在 CI 裡執行 Claude Code，用量可能不扣這筆額度。

自己的腳本直接呼叫 Messages API，確定扣這筆額度。它也能做到上限、用量回報、額度用完時改寫留言這幾件事，這些在 action 上做不到或要補很多步驟。

## 金鑰

- 名稱固定為 `ANTHROPIC_API_KEY`，放在 GitHub 的 repository secret。
- 路徑：repo 的 Settings，Secrets and variables，Actions，New repository secret。
- 金鑰在 `platform.claude.com/settings/keys` 建立。Max 方案的額度要先把一個 Console 組織連到方案才會入帳。
- 建議：建一個專用 workspace，並在 Workspaces 頁設花費上限。Default Workspace 不能設上限。金鑰限定在那個 workspace。
- 金鑰只有使用者能放。agent 不得取得、要求或寫入金鑰。
- 沒有金鑰時，工作印「沒有設定金鑰，略過審查」後成功結束。

## 什麼時候不審查

| 條件 | 結果 |
|---|---|
| 沒有 `ANTHROPIC_API_KEY` | 印一行訊息，後面的步驟全部略過，工作是綠的。 |
| PR 有標籤 `skip-ai-review` | 整個工作略過。 |
| 來自 fork | 整個工作略過。 |
| base 不是 `integration/line-c` 或 `dev` | 不觸發。 |
| base 分支還沒有審查腳本 | 印一行訊息後略過。引入這個工作的那張 PR 就是這種情況。 |
| PR 沒有 diff | 略過。 |

## 停用

選一種：

1. 單張 PR：加標籤 `skip-ai-review`。
2. 全部 PR：刪除 repository secret `ANTHROPIC_API_KEY`。工作會印訊息後略過。
3. 完全停用：在 Actions 頁面選 `pr-review` 工作流程，選 Disable workflow。

## 額度用完、金鑰失效或其他錯誤

工作不會變紅，也不會影響 `ci-deploy` 的 `check`。腳本改貼一則「這次沒有審查」的留言，寫明原因、HTTP 狀態碼、錯誤型別與 request id。留言不含金鑰與完整回應。

| 情況 | 判斷 | 留言的原因 |
|---|---|---|
| 額度用完 | 訊息含 `credit balance`、`spend limit`、`billing`，或 HTTP 402 | API 額度用完，或帳務、花費上限有問題 |
| 金鑰失效 | HTTP 401、403 | API 金鑰失效，或沒有權限 |
| 限流 | HTTP 429 | 請求被限流，或達到花費上限 |
| 請求太大 | HTTP 413，或縮小後仍超過輸入上限 | 請求太大 |
| API 暫時故障 | HTTP 5xx、529 | API 暫時無法使用 |
| 連線失敗 | 逾時、連線錯誤 | 連線失敗或逾時 |
| 模型拒絕、輸出被截斷、回覆不是 JSON | `stop_reason` 或解析失敗 | 對應的原因 |
| 腳本內部錯誤 | 其他例外 | 審查腳本發生內部錯誤 |

官方文件沒有寫明額度用完的 HTTP 狀態碼。所以判斷看訊息文字，不只看狀態碼。額度用完的訊息是 `Your credit balance is too low to access the Anthropic API`。花費上限用完時，API 回 HTTP 400。

看到「這次沒有審查」時，主控改用子代理審查那張 PR。下一次推送成功審查後，同一則留言會更新成審查結果。

## 上限值與模型

全部在 `.github/workflows/pr-review.yml` 開頭的 `env`。

| 變數 | 預設 | 意思 |
|---|---|---|
| `REVIEW_MODEL` | `claude-sonnet-5-5` | 模型 id。也能設 repo variable `PR_REVIEW_MODEL` 覆寫，不用改檔。 |
| `REVIEW_EFFORT` | `medium` | 思考深度，`low`、`medium`、`high`。 |
| `REVIEW_MAX_INPUT_TOKENS` | `120000` | 輸入上限。超過時縮小 diff。 |
| `REVIEW_MAX_OUTPUT_TOKENS` | `16000` | 輸出上限，含思考。 |
| `REVIEW_MAX_COST_USD` | `0.5` | 單次花費上限。最壞情況是輸入全價加輸出用滿，超過時壓低輸入上限。 |
| `REVIEW_MAX_DIFF_CHARS` | `300000` | 送出的 diff 字元上限。 |
| `REVIEW_MAX_FILE_DIFF_CHARS` | `40000` | 單一檔案的 diff 字元上限。 |

回合數固定為 1。腳本只呼叫一次模型，不給工具，不迴圈。

截斷時的順序：lockfile、快照、圖片與字型先排除。其餘依優先序送出：migration 與 route 與登記檔最先，一般程式碼次之，測試再次之，文件最後。放不下的檔列在留言的「未送審」。

改模型時，價格表在 `scripts/ci/pr-review-core.mjs` 的 `PRICES`。表上沒有的模型仍能跑，留言的費用寫「未知」，而且花費上限不生效，只剩 token 上限。

## 手動重跑

- 最簡單：在 PR 的 Checks 頁面，對 `pr-review` 選 Re-run all jobs。
- 或推一個空 commit，或把 PR 關閉再開啟。
- `workflow_dispatch` 已寫好，輸入 PR 編號。GitHub 只在工作流程檔位於預設分支時顯示這個入口。目前預設分支是 `main`，所以這個入口要等檔案進了預設分支才能用。

## 主控怎麼讀留言

第一行是結論，只有兩種：`沒有退回項`、`有 N 個退回項`。N 是 Standards 與 Spec 的問題、未達成與部分達成的驗收條件、安全面失敗的檢查點加總。

接著依序是：

1. Standards 面：違反 `AGENTS.md`、`docs/agents/implementing.md`、`GLOSSARY.md` 的 `_Avoid_` 欄，以及程式碼壞味道的問題。
2. Spec 面：逐條驗收條件的對照表，加上超出範圍的行為。
3. 安全面的檢查點：只在 diff 動到 migration 或 route 時出現。
4. 用量：模型、token、估計費用、送審與未送審的檔。

每一面最多 10 項。只列模型有把握的問題。

注意：

- Spec 面的依據是 PR 本文的「驗收條件對照」一節。CI 不讀 Linear。本文沒有這一節時，留言會寫明，Spec 面只能對照標題與 diff。
- 安全相關的票仍由主控自己讀 migration。留言的安全面不取代那一步。
- 模型只看到 diff 和依據文件，沒有讀整個 repo，也沒有跑測試。留言沒有問題不代表程式碼正確。`check` 才驗證程式碼能不能跑。

## 安全設計

- 權限只有 `contents: read` 與 `pull-requests: write`。`contents: read` 供 checkout。`pull-requests: write` 供新增與更新 PR 留言。工作不能推 commit，也不能改檔。
- 腳本、提示詞與依據文件來自 base 分支，不執行 PR 裡的腳本。PR 的合併 commit 只用 `git diff` 讀取。
- 標題、本文與 diff 是不可信的資料。它們放在帶隨機字尾的標籤裡，提示詞寫明裡面的指示一律當作資料。
- 模型輸出進留言前，會中和 `@名稱`、HTML 註解與金鑰樣式的字串。
- 官方 SDK 固定版本，`npm ci --ignore-scripts` 依 `package-lock.json` 的雜湊安裝。
- 第三方 action 固定到完整的 commit SHA。
- 已知限制：`pull_request` 事件使用 PR 自己的工作流程檔。有寫入權限的人能在自己的分支改這個檔並讀到金鑰。這與 repo 內任何其他工作流程相同。要擋這一點，必須改用 `pull_request_target`，代價是引入這個工作的那張 PR 看不到執行結果。

## 費用估算

單價（2026-11-10，`platform.claude.com/docs/en/about-claude/pricing`）：

| 模型 | 輸入 | 快取讀取 | 輸出 |
|---|---|---|---|
| `claude-sonnet-5-5` | US$2 / 百萬 token | US$0.10 | US$10 |
| `claude-haiku-5-5`（提示詞 100K 以內） | US$0.10 | US$0.01 | US$0.50 |

假設：

- 這個 repo 最近 30 張合併的 PR，中位數約新增 1600 行、28 個檔。
- 加上前後各 20 行的上下文，估計 diff 約 14 萬字元，約 5.5 萬 token。
- 依據文件與提示詞約 1.4 萬 token。
- 輸出含思考，估計 6000 token。

| 情況 | 輸入 | 輸出 | Sonnet 5.5 | Haiku 5.5 |
|---|---|---|---|---|
| 小 PR（新增 300 行） | 3 萬 | 3000 | 約 US$0.09 | 約 US$0.005 |
| 中位數 PR | 7 萬 | 6000 | 約 US$0.17 到 0.21 | 約 US$0.010 |
| 上限（預設值） | 12 萬 | 16000 | 約 US$0.40 | 不適用（超過 100K 單價較高） |

Max 方案每月 US$100。以中位數 US$0.21 計，每月約 470 次。以上限 US$0.40 計，每月約 250 次。每次推送都會重新審查，所以次數算的是推送，不是 PR 張數。

實測（MIL-215 自己的 PR，2026-11-10，3 次真實呼叫）：

| 項目 | 數值 |
|---|---|
| 送審 | 9 個檔，新增約 1500 行（程式碼、文件、測試各占一部分） |
| 輸入 | 約 4.4 萬 token，另有約 1.7 萬 token 的依據文件寫入快取 |
| 輸出 | 1555 到 2000 token |
| 費用 | US$0.145 到 0.149 |

依據文件加提示詞約 1.7 萬 token，是每次的固定成本。5 分鐘內連續審查時，這一段改收快取讀取價（0.1 倍），每次省約 US$0.03。

以實測值 US$0.15 計，每月約 650 次。輸出只用到上限的一成，因為留言限制每面 10 項。其餘估計值仍是估計，以留言的「用量」一節為準。

## 金鑰放入後的實測步驟

使用者：

1. 在 `platform.claude.com` 把 Console 組織連到 Max 方案，確認 Promotional credits 有餘額。
2. 建專用 workspace，設花費上限。
3. 在該 workspace 建 API 金鑰。
4. 在 repo 建 secret `ANTHROPIC_API_KEY`。

主控：

MIL-215 的實作者已用暫時的設定（讓 base 的 checkout 改用 PR 自己的腳本，之後已還原）做過 3 次真實呼叫。結果：留言出現、格式正確、第二次起更新同一則、用量一節有 token 與費用。

這個工作合併進主幹之後，腳本才來自 base 分支，以下步驟在那時做：

1. 對主幹開一張小 PR，本文寫「驗收條件對照」一節。確認留言出現。
2. 再推一個 commit，確認同一則留言被更新，沒有新增第二則。
3. 開一張故意違規的 PR（例如用了 `_Avoid_` 欄的詞，或漏了 `org_id`），確認留言抓得到。
4. 暫時把 secret 改成無效的值，確認留言變成「這次沒有審查」，工作仍是綠的。測完改回。
5. 與子代理審查同一張 PR 的結果比較品質。

已知的品質特性：模型偶爾會列出項目，又在內文自己否定。腳本會丟掉這類項目，提示詞也有對應的規則。
