<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## 語言

在此 repo 中，一律使用**繁體中文**：包括對使用者的回覆、commit 訊息、issue 內容，以及所有文件撰寫。程式碼識別字、工具名稱、標籤字串（如 `needs-triage`）維持英文。

## Agent skills

### Issue tracker

Issue 追蹤在 Linear（team **Miles-rent-poc**，前綴 `MIL`，此 repo 專用），透過 Linear MCP 工具操作。詳見 `docs/agents/issue-tracker.md`。

### Triage labels

使用預設詞彙：五個標準標籤原樣使用。詳見 `docs/agents/triage-labels.md`。

### Domain docs

單一 context：repo 根目錄放一份 `CONTEXT.md` 與 `docs/adr/`。詳見 `docs/agents/domain.md`。

### DottedSign API 文件

查點點簽 API 規格一律用 `dottedsign-api` MCP server（已設定在 `.mcp.json`）：先 `search-endpoints` 或 `list-endpoints` 找目標，再用 `get-endpoint` 取得完整定義。不要憑記憶或舊文件寫 API 呼叫。`execute-request` 只用來查文件範例，不要帶真實 token 呼叫正式 API。
