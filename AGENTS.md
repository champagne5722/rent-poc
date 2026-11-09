<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## 語言

在此 repo 中，一律使用**繁體中文**：包括對使用者的回覆、commit 訊息、issue 內容，以及所有文件撰寫。程式碼識別字、工具名稱、標籤字串（如 `needs-triage`）維持英文。

### 需求文字的用詞

Spec、ticket 與需求描述的義務詞固定：義務用「必須」，禁止用「不得」，許可用「得」，建議用「建議」並附條件。「應」只用在合約條文。領域詞以 `GLOSSARY.md` 為準：用定義欄的詞，避開 `_Avoid_` 欄的詞。

## Agent skills

### Issue tracker

Issue 追蹤在 Linear（team **Miles-rent-poc**，前綴 `MIL`，此 repo 專用），透過 Linear MCP 工具操作。詳見 `docs/agents/issue-tracker.md`。

### Triage labels

使用預設詞彙：五個標準標籤原樣使用。詳見 `docs/agents/triage-labels.md`。

### Domain docs

單一 context：repo 根目錄放一份 `GLOSSARY.md` 與 `docs/adr/`。詳見 `docs/agents/domain.md`。

### 實作環境

實作前讀 `docs/agents/implementing.md`：worktree 設定、重命令必須經記憶體排程、冒煙、真實 PostgreSQL 測試、commit 前檢查。

### UI/UX skills

實作或修改任何前端畫面（頁面、元件、表單、空狀態、PDF 以外的視覺）時，必須先用 Skill tool 載入專案 `.claude/skills/impeccable`，照它的流程做，並以 `DESIGN.md` 為 token 單一來源（ADR-0009）。需要查設計決策（配色、字體配對、UX 準則、圖表類型）時用 `ui-ux-pro-max`。`design-taste-frontend` 只用於行銷網站，後台不用。純後端、資料層、測試的工作不受此限。

UI 重構（MIL-167、ADR-0090）另外用兩個 skill：

- `antd`：寫 antd 程式碼前，查 props、semantic 欄位與 token。改完後用 `antd lint` 掃已棄用的 API。CLI 由主控安裝，agent 不得自行安裝或升級。
- `react-best-practices`：資料改在 server component 載入，client component 只管互動。

#### 參考 repo

重構任何一頁前，必須先讀下表對應的參考頁。只取資訊元件的選用與組合，不搬框架與套件，不加入依賴。外觀一律來自 `DESIGN.md`。

參考 repo 放在專案外：`/Users/miles_jian/Side-project/GitHub/ui-refs/`。三個都是淺層 clone，antd v6，MIT 授權。

| 本專案的頁面 | ant-design-pro | 補充參考 |
| -- | -- | -- |
| 建約精靈 | `src/pages/form/step-form` | colony `src/pages/form/StepForm.tsx` |
| 合約、案件、移交的詳情 | `src/pages/profile/advanced` | colony `src/pages/profile/Advanced.tsx` |
| 合約、物件、案件的列表 | `src/pages/table-list`、`src/pages/list/search` | antd-admin `apps/basic/src/routes/_auth/users` |
| 工作台 | `src/pages/dashboard/workplace` | colony `src/pages/dashboard/Workplace.tsx` |
| 審核台項目詳情 | `src/pages/profile/basic` | colony `src/pages/profile/Basic.tsx` |
| 操作結果 | `src/pages/result` | 無 |
| 登入頁 | `src/pages/user/login` | antd-admin `apps/basic/src/routes/login` |

- ant-design-pro 用 Umi 與 pro-components。只讀版面與資訊架構，用 antd 原生元件重寫（ADR-0090）。
- colony 的使用者少，只當輔助參考。
- 參考 repo 不存在時，執行 `git clone --depth 1 https://github.com/<owner>/<repo>.git` 補回。三個 repo 是 `ant-design/ant-design-pro`、`zuiidea/antd-admin`、`ColorlibHQ/colony`。

### DottedSign API 文件

查點點簽 API 規格一律用 `dottedsign-api` MCP server（已設定在 `.mcp.json`）：先 `search-endpoints` 或 `list-endpoints` 找目標，再用 `get-endpoint` 取得完整定義。不要憑記憶或舊文件寫 API 呼叫。`execute-request` 只用來查文件範例，不要帶真實 token 呼叫正式 API。
