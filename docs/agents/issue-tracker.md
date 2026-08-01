# Issue tracker：Linear

此 repo 的 issue 與 PRD 都放在 Linear 的 **Miles-rent-poc** team。這個 team 是此 repo 專用的——**不要**把此 repo 的 issue 建到其他 team（例如 IDPS，那是另一個 repo 在用的）。所有操作一律透過此 repo 專屬的 Linear MCP server **`linear-rentpoc`**（工具名為 `mcp__linear-rentpoc__*`，OAuth 授權到 rent-poc 的 workspace）；若工具尚未載入，先用 ToolSearch 載入。若 session 中出現其他 Linear 連接器（例如授權到 IDPS workspace 的），不要使用。

Issue 編號格式為 `MIL-<n>`。若 `list_teams` 查不到 Miles-rent-poc，代表 Linear 連接器的授權範圍不含這個 team，請提醒使用者重新授權，不要改建到其他 team。

## 慣例

- **建立 issue**：用 `save_issue`，指定 Miles-rent-poc team、標題與 markdown 描述。已知標籤時在建立當下一併套用。
- **讀取 issue**：用 `get_issue` 以編號查詢（例如 `MIL-12`），再用 `list_comments` 讀取討論串。
- **列出 issue**：用 `list_issues`，以 Miles-rent-poc team、狀態與標籤篩選。
- **在 issue 留言**：用 `save_comment`。
- **套用／移除標籤**：透過 `save_issue` 更新 issue 的標籤。若需要的標籤還不存在，用 `create_issue_label` 建立，不要拿近似的標籤充數。
- **結案**：透過 `save_issue` 把 issue 移到該 team 的 Done 狀態（wontfix 則移到 Canceled），並留下結案留言。

在文字與 commit 訊息中一律以編號（`MIL-<n>`）稱呼 issue，不要用內部 UUID。

## PR 是否作為 triage 來源

**PR 作為需求來源：否。** 此 repo 的 GitHub PR 不納入 triage 佇列；triage 只處理 Linear issue。

## 當 skill 說「發佈到 issue tracker」

在 Miles-rent-poc team 建立一個 Linear issue。

## 當 skill 說「取得相關 ticket」

用 `get_issue` 以 `MIL-<n>` 編號查詢，再用 `list_comments` 讀取討論。

## Wayfinding 操作

供 `/wayfinder` 使用。**地圖（map）**是一個 issue，其**子 issue** 就是各個 ticket。

- **地圖**：一個帶有 `wayfinder:map` 標籤的 issue，內容包含 Notes／Decisions-so-far／Fog。
- **子 ticket**：地圖的 Linear 子 issue（建立時設定 `parentId`）。標籤：`wayfinder:<type>`（`research`／`prototype`／`grilling`／`task`）。被認領後，指派給負責的開發者。
- **阻擋關係**：優先使用 Linear 原生的「blocked by」關聯（若工具支援）；否則在子 issue 描述最上方寫一行 `Blocked by: MIL-<n>`。所有阻擋者都 Done 之後，該 ticket 即解除阻擋。
- **前緣查詢（frontier）**：列出地圖尚未完成的子 issue，排除仍有未結案阻擋者或已有指派人的項目；依地圖順序取第一個。
- **認領**：把 issue 指派給自己——這是該 session 的第一個寫入動作。
- **結案**：留言寫下答案，把 issue 移到 Done，再把 context 指標補到地圖的 Decisions-so-far。
