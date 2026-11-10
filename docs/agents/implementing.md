# 實作子對話的環境與規則

實作票（`/implement`）的 agent 開工前讀一次。派工單只寫這份文件沒有的值：主幹分支名、快取目錄、`npm_config_cache`、冒煙用的 port、migration 編號區段。

開發機只有 16 GB 記憶體。多個重命令同時執行會讓整台機器停止回應，所以重命令必須經過記憶體排程（下一節）。

## 開工

1. 執行 `git status --short`，確認工作區乾淨。
2. 執行 `git fetch origin && git reset --hard origin/<主幹分支>`。主幹分支名由派工單提供。
3. 派工單說 `main` 已凍結時，不要併 `origin/main`。
4. 執行 `export PATH=/opt/homebrew/bin:$PATH`，並把 `npm_config_cache` 設成派工單提供的目錄。
5. 執行 `ls node_modules/@electric-sql/pglite`。目錄不存在時，執行 `cp -Rc <快取目錄>/node_modules ./node_modules`。

worktree 自帶的 `node_modules` 可能缺套件，特別是 `@electric-sql/pglite` 與 `pglite-socket`。`package.json` 有變動時才用 `npm install`。

## 重命令

重命令有五種：vitest、eslint、tsc、`next dev`、`next build`。直接執行它們會被專案的 PreToolUse hook 擋下（`.claude/settings.json`，判斷邏輯在 `scripts/hooks/guard-heavy.mjs`）。被擋時，訊息會寫出正確的命令。

| 要做的事 | 命令 | 成本 |
|---|---|---|
| 完整測試 | `npm test` | 4 GB |
| 指定檔案或目錄的測試 | `npm test -- <路徑>` | 3 GB |
| eslint | `npm run lint -- --max-warnings=10` | 3 GB |
| 型別檢查 | `npm run typecheck` | 1 GB |
| 三項檢查加被忽略檔案檢查 | `npm run verify` | 4 GB |
| 正式建置 | `npm run build:local` | 3 GB |
| 其他吃記憶體的命令 | `scripts/heavy.sh <標籤> <命令>` | 3 GB |

排程的規則在 `scripts/heavy.sh` 的檔頭註解，那裡也有所有環境變數。重點如下：

- 預算 8 GB。命令的成本加上已佔用的成本超過預算時，命令排隊。
- 回傳 75 代表排隊逾時。稍後再試，不要繞過。
- 回傳 76 代表系統空閒記憶體不足。停下來回報。
- 回傳 124 代表命令超過逾時，整個行程群組已被收掉。
- 排程能重入。`scripts/heavy.sh x npm test` 的內層不會再排隊。
- `CI=true` 時直接放行。
- 名額目錄在所有 worktree 共用的位置。用 `HEAVY_DIR` 覆寫。

使用規則：

- 每個命令在前景跑完，不留背景行程。
- 開發中只跑動到的目錄。
- 完整測試只在回報前跑一次。
- 新增大量 PGlite 測試後，用 `scripts/measure/measure-full-run.sh` 重新量測尖峰。逐檔量測用 `scripts/measure/measure-test-mem.sh`。兩者的用法在檔頭，都要經過 `scripts/heavy.sh`。

## 冒煙：PGlite dev server 與 API

冒煙用 Node 的 `fetch` 腳本打 dev server。不用任何互動式瀏覽器，包括 `mcp__Claude_Browser__*`、`preview_*`、`mcp__claude-in-chrome__*`、`mcp__computer-use__*`。

啟動 dev server、跑冒煙、關閉 dev server 必須寫在同一個腳本，dev server 不留在背景。外殼已經寫好：

```bash
scripts/heavy.sh smoke scripts/smoke/run-smoke.sh <port> <冒煙腳本.mjs> | tee <輸出檔>
```

- `<port>` 由派工單提供，每個子對話不同。
- 冒煙腳本從環境變數 `BASE_URL` 取得 dev server 位址。
- 外殼用 `scripts/smoke/pg-socket-server.mjs` 啟動 PGlite 加 socket，當作 PostgreSQL。它是單一連線，所以外殼設定 `PG_POOL_MAX=1`。
- 這個伺服器需要 `@electric-sql/pglite-socket`。沒有時執行 `npm install --no-save @electric-sql/pglite-socket`。
- 外殼結束時只殺自己 port 的 LISTEN 行程，並刪除自己的 `.next-smoke-<port>`。最後一行 `LISTEN <port>: 0` 代表已清乾淨。

## E2E 安全網（Playwright）

E2E 是 UI 重構的安全網（MIL-167、ADR-0090）。它驗證使用者看得到的行為，重構前後都必須通過。E2E 不在 CI 的 `check` 工作裡，也不在 `npm run verify` 裡。

### 內容

- 3 條流程（`e2e/flows/`）：建約精靈建立草稿、合約送簽進入簽署中、物件列表建立物件。
- 截圖基準（`e2e/visual/`）：合約列表、合約詳情、建約精靈的第一、二、四步、物件列表。基準圖在 `e2e/screenshots/`。
- 流程測試與截圖比對是兩個 npm script。重構票改外觀時，流程測試必須通過，截圖比對失敗是預期的。

### 執行

1. 確認 `node_modules/@playwright/test` 存在。不存在時執行 `npm install`。
2. 確認 chromium 已安裝。沒有時執行 `npx playwright install chromium`。
3. 跑流程測試：

```bash
npm run e2e
```

4. 跑截圖比對：

```bash
npm run e2e:visual
```

- 兩個指令都經過 `scripts/heavy.sh`，成本 6 GB（實測尖峰 5.3 GB）。每次約 70 秒。
- 外殼 `scripts/e2e/run-e2e.sh` 把 PGlite、`next dev` 與瀏覽器包在同一個腳本。dev server port 是 3410，PGlite port 是 54410。
- 結束時外殼只清自己的 port 與 `.next-e2e-3410`。最後一行 `LISTEN 3410: 0` 代表已清乾淨。
- 外殼啟動前，如果 port 3410 或 54410 已被占用，會直接停止（結束碼 65）。
- 資料庫每次都是全新的記憶體 PGlite，不依賴既有資料，也不需要 Docker。
- 簽署走 mock 模式。外殼清掉 `DOTTEDSIGN_CLIENT_ID` 與 `DOTTEDSIGN_CLIENT_SECRET`，不呼叫點點簽。
- 登入走 email 驗證碼流程。Mailer 用 log adapter，測試從 `/demo/otp` 取碼。應用程式碼沒有為測試開後門。
- 失敗時的 trace 與截圖在 `e2e-results/`。用 `npx playwright show-trace <trace.zip>` 查看。
- 執行 `next dev` 會讓 Next 改寫 `tsconfig.json` 的 `include`。跑完 E2E 後，執行 `git checkout tsconfig.json`，不要把這個變動 commit。

### 更新截圖基準

只有主控在階段驗收時更新基準。重構票不更新。

1. 先跑 `npm run e2e:visual`，確認差異都是預期的外觀變動。
2. 執行下列指令更新基準：

```bash
npm run e2e:visual -- --update-snapshots
```

3. 檢查 `e2e/screenshots/` 的新圖，再 commit。

### 讓截圖能重現的做法

- 視窗 1440x900、台北時區、繁體中文、亮色，設定在 `playwright.config.ts`。
- 瀏覽器端的時間固定在 2026-11-10 10:00（台北）。
- 截圖前等字型載入完成，並關閉動畫與游標。
- 伺服器端產生的合約 ID 與時間戳每次不同。截圖前把這些文字換成固定樣本（`normalizeVolatileText`）。
- 截圖時隱藏 Next 的開發工具浮動按鈕（`e2e/visual/screenshot.css`）。
- 基準圖在 macOS 上產生。換作業系統或字型後，需要重建基準。

### 寫新測試的規則

- 只用角色、文字與 label 找元素。不用 class 名稱或 DOM 結構。UI 重構會大改 DOM。
- 測試資料在測試內建立（`e2e/helpers/api.ts`），名稱帶隨機尾碼。測試不得依賴執行順序。
- dev server 剛編譯完時，頁面可能還沒 hydrate。第一下點擊用 `clickUntil`（`e2e/helpers/ui.ts`）重試，不用固定等待。
- antd Select 的選項用 `chooseOption`。下拉是虛擬清單，`role=option` 的節點是隱藏的。
- 重構票改了畫面文字或版面時，同一張票必須更新對應的流程測試。流程測試通過是重構票的完成條件之一。

### 現況基準（baseline）

`docs/ui/baseline/` 是 UI 重構前的基準：每頁截圖、6 項評分、impeccable audit、靜態統計，以及積欠票的畫面驗收（MIL-170）。階段驗收時重跑，與這份基準比較。

1. 跑量測與截圖，約 8 分鐘：

```bash
HEAVY_COST=6 scripts/heavy.sh e2e-baseline scripts/e2e/run-e2e.sh baseline
```

2. 重跑靜態統計、評分與報告：

```bash
node e2e/baseline/static-stats.mjs && node e2e/baseline/score.mjs && node e2e/baseline/build-report.mjs
```

- 腳本在 `e2e/baseline/`。它沒有斷言，不在 `npm run e2e` 與 `npm run e2e:visual` 裡。
- 外殼替 dev server 設 `PLATFORM_OPERATOR_EMAILS`，所以測試能登入平台營運者。只有 `baseline` 會設。
- 測試自己啟動 Chromium 並開 CDP port 9333，給 `impeccable detect --cdp` 掃渲染後的頁面。
- 重跑後要看新截圖，更新 `e2e/baseline/score.mjs` 裡手填的「一致」「狀態」「回饋」。
- 只重跑資料準備與驗收，加參數 `--grep "準備資料|前置|驗收|承租人端截圖"`。

### 量記憶體

```bash
HEAVY_COST=6 scripts/heavy.sh measure-e2e scripts/measure/measure-e2e.sh flows
```

它每秒取一次整棵行程樹的 RSS 總和，結束時印出尖峰與耗時。

## 真實 PostgreSQL 測試

`*.pg.test.ts` 在沒有 `TEST_DATABASE_URL` 時會靜默跳過，結果仍是綠燈。實作子對話預設不啟動 Docker，不跑這些測試。新增的 `*.pg.test.ts` 列在回報裡，由驗證者執行。派工單明說這張票得用真實 PostgreSQL 時，才啟動派工單指定的容器。

### 本機一條指令

前提是本機有 Docker。在 worktree 根目錄執行：

```bash
npm run test:pg
```

- 它啟動自己的容器 `rentpoc-pg-test`（PostgreSQL 18，port 54399），跑所有 `*.pg.test.ts`，跑完刪除容器。
- 它不碰 `rentpoc-pg-verify`（port 54329），那是驗證者共用的。
- 它用 `scripts/ci/check-pg-tests-ran.mjs` 確認每個 pg 測試檔都有執行，沒有被跳過，通過數量不低於 100。
- 它經過 `scripts/heavy.sh` 排程，成本 4 GB。整組約 15 秒。
- 已設定 `TEST_DATABASE_URL` 時，它直接用該資料庫，不啟動容器。
- 設定 `PG_TEST_KEEP=1` 時，它保留容器，下次執行重用。
- 找不到可用的 Docker 時，它回傳 69，並說明原因。

CI 的 `check` 工作跑同一組測試，並用同一個檢查腳本。變數沒設、某個 pg 測試檔沒有執行或有測試被跳過時，`check` 失敗。

### 只跑一個檔案

```bash
docker run --name rentpoc-pg-verify -d -p 54329:5432 -e POSTGRES_PASSWORD=pw postgres:18
```

```bash
TEST_DATABASE_URL=postgres://postgres:pw@localhost:54329/postgres npm test -- <路徑>
```

```bash
docker stop rentpoc-pg-verify
```

### 系統目錄檢查與滲透測試

組織隔離由三組檢查把關（MIL-89，ADR-0012 決議 6）。它們自己從系統目錄找出所有表、view 與定義者函式，不靠手寫的表名清單。

| 檢查 | 檔案 | 跑在 |
|---|---|---|
| 系統目錄檢查 | `src/lib/pg/rls-catalog-kit.ts`（查詢）、`rls-catalog-suite.ts`（測試本體） | PGlite（`rls-catalog.test.ts`）與真實 PostgreSQL（`rls-catalog.pg.test.ts`） |
| 跨組織滲透探測 | `src/lib/pg/rls-penetration-suite.ts` | PGlite（`rls-penetration.test.ts`）與真實 PostgreSQL（`rls-penetration.pg.test.ts`） |
| 案件成員入口的滲透 | `src/lib/case-store/member-tx.pg.test.ts` | 真實 PostgreSQL |

系統目錄檢查涵蓋的項目：

1. 每張表都登記在所屬 schema 的清單。不認得的 schema 有表就失敗。
2. `org` 的每張表：`org_id` 不為空、`ENABLE` 與 `FORCE` RLS、至少一條政策。
3. `audit` 的每張表：歸 `audit_owner`、`FORCE` RLS、`app_rw` 的權限與登記一致。
4. `app_owner`、`app_rw`、`audit_owner`、`vault_owner` 不是 superuser，沒有 `BYPASSRLS`。`app_rw` 不擁有任何物件。
5. 所有 view 設 `security_invoker = true`，`app_rw` 對 view 只有 `SELECT`，不用 materialized view。
6. 參照 `org` 表的外鍵都含成對的 `org_id`。
7. `org` 表的唯一鍵都含 `org_id`，主鍵是 `(id)` 或含 `org_id`。
8. 所有定義者函式固定 `search_path`，PUBLIC 不能執行，擁有者不繞過 RLS。

## commit 前

1. 執行 `git status --short --ignored src db scripts docs`。
2. 看到 `!!` 開頭的檔案時，確認測試沒有依賴它們。被 `.gitignore` 排除的檔案不會進版控，測試在別處會失敗（例如 `*.pem`）。
3. 小步 commit。每完成一個階段就 commit，不留未提交的檔案。

## 回報前

1. 執行 `git fetch origin && git merge origin/<主幹分支>`。
2. 執行 `npm run verify`。它依序跑 typecheck、test、lint（`--max-warnings=10`），三項都必須通過。
3. PR 本文必須有「驗收條件對照」一節：把票上的驗收條件逐條列出，每條寫做到了沒有與對應的檔或測試。CI 的自動審查靠這一節對照 Spec（MIL-215，見 `docs/agents/pr-review.md`）。
4. 單一步驟卡住超過 10 分鐘時，放棄那一步並寫進回報。

## 新增東西時的登記位置

這裡只放指標。步驟寫在各彙總檔的檔頭，以檔頭為準。

登記檔已拆成每個模組一個檔。新增自己模組的檔，再在彙總檔加一行 import 與一行清單。既有模組的內容改自己模組的檔，不用動彙總檔。

- 新的 org 表或 registry 表：新增 `src/lib/pg/rls-cases/<模組>.ts`，在彙總檔 `src/lib/pg/rls-cases.ts` 登記。缺登記時 `rls-penetration.test.ts` 與 `rls-catalog.test.ts` 會失敗。
- 新的 `control` 表：在自己模組檔的 `controlTables` 登記，寫明理由與 `app_rw` 的直接 DML 權限。新的 `audit` 表用 `auditTables`，新的 `registry` 或 `vault` 表用 `definerOnlyTables`。
- 新的 schema：先在 `src/lib/pg/rls-catalog-kit.ts` 的 `SCHEMA_REGISTRIES` 加一列。沒有加時，有表就失敗。
- 新的 view：必須用 `WITH (security_invoker = true)`，並只 `GRANT SELECT` 給 `app_rw`。`org` schema 有預設權限會自動給 `app_rw` 四種 DML，所以建 view 後要 `REVOKE INSERT, UPDATE, DELETE`。
- 新的定義者函式（`SECURITY DEFINER`）：必須 `SET search_path = pg_catalog, <自己的 schema>, pg_temp`（`pg_temp` 排最後），並 `REVOKE EXECUTE ... FROM PUBLIC`。只授予需要的角色。
- 新的外鍵參照 `org` 表：用 `(org_id, x_id)` 複合外鍵。
- 新的 `org` 表唯一鍵：必須含 `org_id`。需要跨組織唯一時（只有 registry 與主要出租權源），把索引登記在 `rls-cases.ts` 的 `CROSS_ORG_UNIQUE_KEY_EXCEPTIONS`，並寫一句理由。
- 新的動作：新增 `src/lib/access/actions/<模組>.ts`，在彙總檔 `src/lib/access/actions.ts` 登記，再在 `decide-access.test.ts` 加預期列。細節見 `src/lib/access/README.md`。
- 新的選單項目：新增 `src/lib/nav/<模組>.ts`，在彙總檔 `src/lib/nav.ts` 登記。新的 key 要在 `src/components/AppShell.tsx` 的 `NAV_ICONS` 補 icon。
- 新的 route：在 `inOrgTx` 開頭呼叫 `authorize()`。見 `src/lib/authorize/README.md`。
- 案件範圍的寫入：用 `withCaseMemberTx`。見 `src/lib/cases/README.md`。
- 新的 migration：用派工單指定的編號區段，不改已存在的 migration 檔。
