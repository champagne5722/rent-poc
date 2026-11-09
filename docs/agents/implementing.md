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

## 真實 PostgreSQL 測試

`*.pg.test.ts` 在沒有 `TEST_DATABASE_URL` 時會靜默跳過，結果仍是綠燈。實作子對話不啟動 Docker，不跑這些測試。新增的 `*.pg.test.ts` 列在回報裡，由驗證者執行。

驗證者的做法：

```bash
docker run --name rentpoc-pg-verify -d -p 54329:5432 -e POSTGRES_PASSWORD=pw postgres:18
```

```bash
TEST_DATABASE_URL=postgres://postgres:pw@localhost:54329/postgres npm run verify
```

```bash
docker stop rentpoc-pg-verify
```

## commit 前

1. 執行 `git status --short --ignored src db scripts docs`。
2. 看到 `!!` 開頭的檔案時，確認測試沒有依賴它們。被 `.gitignore` 排除的檔案不會進版控，測試在別處會失敗（例如 `*.pem`）。
3. 小步 commit。每完成一個階段就 commit，不留未提交的檔案。

## 回報前

1. 執行 `git fetch origin && git merge origin/<主幹分支>`。
2. 執行 `npm run verify`。它依序跑 typecheck、test、lint（`--max-warnings=10`），三項都必須通過。
3. 單一步驟卡住超過 10 分鐘時，放棄那一步並寫進回報。

## 新增東西時的登記位置

這裡只放指標。登記的細節看各 README，檔案搬動後以 README 為準。

- 新的 org 表或 registry 表：登記到 `src/lib/pg/rls-cases.ts`。檔頭說明有清單名稱。缺登記時 `rls-penetration.test.ts` 會失敗。
- 新的動作：加進 `src/lib/access/` 的動作表與矩陣測試。見 `src/lib/access/README.md`。
- 新的 route：在 `inOrgTx` 開頭呼叫 `authorize()`。見 `src/lib/authorize/README.md`。
- 案件範圍的寫入：用 `withCaseMemberTx`。見 `src/lib/cases/README.md`。
- 新的 migration：用派工單指定的編號區段，不改已存在的 migration 檔。
