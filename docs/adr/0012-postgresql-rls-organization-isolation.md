---
status: accepted
---

# PostgreSQL 與 RLS 組織隔離，直接切換不做 SQLite 非同步過渡

> 2026-11-10：決議 8 第 4 項已由 ADR-0028 修訂。回應不得說明建號已在平台登錄。

現有資料庫是 SQLite 單檔，沒有 RLS。P0-02 要求每張組織表以 RLS 隔離並設定 FORCE。決議：資料庫換成 PostgreSQL，採共用資料庫加 RLS，應用程式完全沒有 `BYPASSRLS`。呼叫點量測不改變這個選項，因為否決 SQLite 的原因是沒有 RLS，與工作量無關。遷移時不做 SQLite 的非同步過渡，直接寫 PostgreSQL 版 repository。其他 P0 線也要等 PostgreSQL，所以過渡狀態沒有使用者。

本決議取代 ADR-0002 的「儲存用 SQLite（單檔、零安裝、schema 可讀）」一段。ADR-0002 的 Next.js 單一專案決議不變。

## 決議內容

1. **隔離模型。** 所有組織共用一個資料庫。每張組織表有 `org_id`，設定 `ENABLE` 與 `FORCE ROW LEVEL SECURITY`。組織脈絡只用 `set_config('app.org_id', $1, true)` 設定，禁止 session 層級的 `SET`。

2. **託管。** pilot 起用 Cloud SQL asia-east1。實際開機前，必須依當時的費用與資料量再確認一次。demo 與 preview 用 Neon，只放測試資料。理由見下方「託管費用」。2026-11-08 修訂：demo 改用 Cloud SQL 最小規格，見 Consequences 的修訂段。

3. **schema 分五區。** `tenant` 這個字在程式碼表示承租人，不得再當 schema 名稱，所以組織資料區改名 `org`。

   | schema | 內容 | 存取 |
   |---|---|---|
   | `org` | 物件、案件、合約、帳本、outbox | 掛組織 RLS |
   | `registry` | 全域登錄的產權錨點、租賃單位、執業主體、執業人員 | 只經 `SECURITY DEFINER` 函式 |
   | `audit` | 稽核事件 | 只經函式寫入 |
   | `vault` | 特種個資與證件影像的中繼資料 | 只經函式讀取 |
   | `control` | `orgs`、`users`、`parties`、`org_memberships`、inbox、`sign_task_routes`、任務認領表 | 不掛組織 RLS，權限逐表授予 |

4. **角色。** 應用程式與 worker 用 `app_rw`，migration 用 `app_owner`。維運事故用 break-glass 角色。`audit`、`vault` 的函式由各自的 NOLOGIN 角色擁有。這些角色都不得有 `BYPASSRLS`，break-glass 除外，且每次使用都必須寫稽核紀錄。

5. **沒有組織脈絡的入口。** 下列入口在設定 `app.org_id` 前就要讀資料：

   | 入口 | 做法 |
   |---|---|
   | 點點簽 webhook | 寫入 `control` 的 inbox，再查 `sign_task_routes` 取得組織。路由列與簽署任務同交易寫入 |
   | 登入 | 查 `control` 的 `users` 與 `org_memberships`，再決定組織脈絡 |
   | worker | 從 `control` 的任務認領表取得 `org_id`，再逐組織 `set_config` |
   | 平台營運者 | 經審核佇列或支援工單，對目標組織 `set_config`，同交易寫稽核紀錄 |

   webhook 不能改用定義者函式查 `sign_tasks`。FORCE 讓函式 owner 也受 RLS 限制，查詢結果是空值。

6. **六個陷阱。** 架構 4.4 列 4 個，本決議加第 5、6 個。CI 必須檢查第 1、2、4 個，滲透測試必須涵蓋第 3、5、6 個。

   | 陷阱 | 對策 |
   |---|---|
   | 1. 超級使用者與 `BYPASSRLS` 角色不受 RLS 限制 | 應用程式不得用這類角色 |
   | 2. 表擁有者預設不受 RLS 限制 | 每張表設定 FORCE，`app_rw` 不是擁有者 |
   | 3. 連線池讓 session 狀態外洩 | 只用交易範圍的 `set_config` |
   | 4. view 預設以擁有者權限執行 | 所有 view 設 `security_invoker = true` |
   | 5. 外鍵穿透 RLS | 組織表之間用 `(org_id, x_id)` 複合外鍵 |
   | 6. 唯一鍵穿透 RLS，撞號會洩漏資料存在 | 業務唯一鍵必須含 `org_id`。跨組織唯一只留給 `registry` 與主要出租權源 |

7. **案件成員讀取。** `case_members` 除了組織政策，必須另有 `self_read` 政策，條件是 `party_id = current_setting('app.party_id', true)`。缺少這條時，沒有組織的承租人讀不到任何資料。

8. **`registry` 例外。** 接受 `registry` 不掛組織 RLS，條件如下：

   - 每個函式固定 `search_path`，並 `REVOKE ... FROM PUBLIC`。
   - 函式 owner 不得有 `BYPASSRLS`。
   - 回應不得透露另一個組織的名稱、統編或人員。
   - 依 P0-07 AC1，回應得說明該建號已在平台登錄。所以使用者能探測建號是否已登錄。本決議接受這項風險，並加頻率限制與稽核紀錄。

9. **主鍵。** 主鍵用 ULID，存 `text`，由應用程式產生。既有資料的舊 `id` 暫存於 `legacy_id`，只供遷移對照。切換穩定 2 週後，以 migration 移除 `legacy_id`，因為舊 ID 沒有對外引用。

10. **`withTx`。** `withTx(ctx, async (tx) => ...)` 是取得資料庫的唯一入口。`ctx` 帶組織脈絡，`tx` 是 repository 方法的必填參數。讀取也走 `withTx`，因為交易範圍的 `set_config` 需要交易。callback 內不得有外部 API 呼叫、`fs` 非同步操作與計時器。`BEGIN` 與 `set_config` 必須併成一次往返。

11. **遷移路徑。** 開工條件是 MIL-60 完成後，先重跑呼叫點量測再估工時。MIL-53 到 MIL-60 改的 `transitions.ts`、`send`、`void`、`webhooks`，正是遷移要改的檔案。架構 6.2 的步驟改為：

    | 架構 6.2 | 本決議 |
    |---|---|
    | 1 以 SQLite 實作 repository | 直接寫 PostgreSQL 版，介面一開始就帶組織脈絡，測試改用 PGlite。不做序列化佇列 |
    | 2 呼叫端改 async | 同一輪改 ID（number 改 ULID）與 `jsonOk`。完成條件加 response body 測試 |
    | 3 第一版 schema，5 張表 | 7 張表，加簽署模組的 2 張。遷移工具用純 SQL |
    | 4 兩個實作雙跑 | 刪除 |
    | 5、6 RLS、角色、其他 schema | 保留，加 `control` |
    | 7 搬資料 | 保留。依 P0-06 AC5，每個物件都建租賃單位與待驗證錨點，刪除架構 3.9 的「遷移期允許空值」 |
    | 8 檔案搬到物件儲存 | 保留 |
    | 9 切換正式環境 | A 線合併當天 demo 切到 Cloud SQL，Litestream 退場。2026-11-08 修訂前寫 Neon |
    | 10 `SignerRole` 改名 | 刪除，ADR-0010 已提前執行 |
    | 11 移除 SQLite | 併入 A 線合併 |

12. **與部署的銜接。** demo 在 A 線完成前，維持 Cloud Run 加 SQLite 與 Litestream（ADR-0011）。A 線合併當天 demo 切到 Cloud SQL 最小規格，Litestream 退場。pilot 把同一個執行個體升到 pilot 規格。2026-11-08 修訂前，demo 寫 Neon。

13. **測試。** vitest 預設用 PGlite，每個測試用 `clone()` 隔離。不用架構 6.4 的交易回滾，因為它會蓋掉 `withTx` 本身的行為。測試必須 `SET ROLE app_rw`，否則 RLS 測試全部假通過。CI 另開真實 PostgreSQL 容器，跑滲透測試、併發與角色檢查。

14. **漏 `await` 的防護。** MIL-37 量到 24 處漏 `await` 時 `tsc` 不報錯，其中 9 處 lint 也抓不到。這 9 處的原因是 `Response.json` 的參數型別是 `any`。對策有三項：

    - 加 `jsonOk<T>`，以型別深層拒絕 Promise。
    - ESLint 禁止 `src/app/api` 直接用 `Response.json`。
    - 開 `no-floating-promises` 與 `no-misused-promises`。

    `src/app` 目前沒有測試，所以仍必須補驗 response body 的測試。

15. **資料存取方式。** 驅動用 `pg`，migration 用純 SQL，不用 ORM。RLS 政策與定義者函式都要手寫 SQL。具體的 migration 工具由 A 線 spec 決定。

## 託管費用

費用是每月估算，來源是 `docs/research/hosting-evaluation.md` 第 4 節，查詢日期 2026-11-07。該文件在分支 `claude/cloud-deploy-cicd-93f0f7`。每格含 Cloud Run。

| 方案 | demo | pilot（300 租賃單位） | Phase 1 結束 |
|---|---|---|---|
| Cloud Run 加 Cloud SQL | NT$324（2026-11-08 修訂補估，見 Consequences） | NT$1,480 | NT$3,793 至 8,933 |
| Cloud Run 加 Neon | NT$48 | NT$858 至 1,550 | NT$2,816 至 4,732 |

選 Cloud SQL 的理由有兩個。第一，資料在台灣，不用等法務確認境外傳輸。第二，`withTx` 每次至少 N+3 次往返，新加坡的 RTT 推估 50 至 80 ms，跨雲延遲沒有實測。代價是 Phase 1 結束時費用較高。

## 實測結果

環境是 PGlite 0.5.15，回報 PostgreSQL 18.6，日期 2026-11-07。結果沒有在 Cloud SQL 或 Neon 重跑。

| 情境 | 結果 |
|---|---|
| `app_rw` 未設定 `app.org_id` | 0 筆 |
| 同一連線上一個交易結束後再查 | 0 筆 |
| 用過 `set_config` 後的未設定值 | 空字串。架構 4.4 寫 NULL，與實測不同 |
| 架構 4.4 的 `case_member_read` 原樣，沒有組織的承租人 | 0 筆 |
| 加 `self_read` 後 | 讀得到該案件的合約 |
| A 組織的事件以單欄外鍵引用 B 組織的合約 | 寫入成功 |
| `app_rw` 直接讀 `registry` 的表 | `permission denied` |
| 表設 FORCE，owner 是 `app_owner` 的定義者函式查別的組織 | 空值 |
| PGlite 預設的 `postgres` 身分查組織表 | 繞過 RLS |
| `clone()` 與新建實例 | 117 ms 與 440 ms |

`jsonOk<T>` 只用 `tsc --strict` 驗證過型別：三種漏 `await` 的寫法都報錯，`Response.json` 的對照組不報錯。還沒有套到實際 route。

## Considered Options

- **每組織一個 schema：** 隔離直觀，但 migration 要對每個 schema 執行。
- **組織專屬資料庫：** 隔離最強，第一版成本與維運都不划算。本決議只記錄升級路徑（架構 4.4），`plan`、`db_locator` 欄位 Phase 1 不建。
- **SQLite 加應用層過濾：** 不用遷移，但沒有 RLS，不符合 P0-02。
- **照架構 6.2 先做 SQLite 非同步過渡：** main 每個階段都能部署。代價是序列化佇列與雙跑都會丟棄，測試的 SQL 方言要改兩次。其他 P0 線也要等 PostgreSQL，過渡狀態沒有使用者。
- **Neon 當 pilot 資料庫：** 費用較低，但資料在新加坡，要等法務確認。
- **UUIDv7 主鍵：** 省 10 位元組，但遇空字串轉型會丟錯，簽署模組的 `subject_id` 也已是文字。
- **ORM：** 型別方便，但 RLS 與定義者函式仍要手寫 SQL。

## Consequences

- A 線合併當下就是切換，中間不能部分上線。A 線必須等簽署抽象層收尾。
- MIL-37 的 6.5 至 10 人日只能當基準，它不含 ID 改寫，也不含步驟 3 到 5。ID 改寫涉及 production 約 51 行、20 個檔案。這是 grep 計數，沒有逐行核對。
- 每次讀取都是一個交易，所以往返次數比直接查詢多。
- Neon 專案的初始 owner 有 `BYPASSRLS`。`app_rw` 必須用 SQL 建立，不得用 Console 建立。這條規則在 Cloud SQL 同樣適用，見下方修訂段。
- 延伸 ADR-0010：A 線承接它留給遷移線的 inbox 與 outbox。簽署進度的同交易改由 `withTx` 提供。

### 修訂 2026-11-08：demo 改用 Cloud SQL 最小規格

使用者決定 demo 一開始就用 Cloud SQL asia-east1，不用 Neon。理由有三個。第一，少一家供應商。第二，資料從第一天就在台灣。第三，pilot 不必再從 Neon 搬到 Cloud SQL。本段取代決議 2、11 的步驟 9 與 12 裡的 Neon 字樣。

demo 規格與每月費用如下。價格取自官方定價頁，區域切到 Taiwan (asia-east1)，查詢日期 2026-11-08。來源：<https://cloud.google.com/sql/pricing>。

| 計費項 | 規格 | 算式 | 美元 |
|---|---|---|---|
| 執行個體 | `db-f1-micro`，Enterprise 版，shared core，0.6 GiB，單區 | US$0.0105 × 730 小時 | 7.67 |
| SSD 儲存 | 10 GiB，Cloud SQL 的磁碟下限 | 10 × US$0.000232877 × 730 | 1.70 |
| 備份 | 1 GiB，demo 資料量估計 | 1 × US$0.000109589 × 730 | 0.08 |
| Cloud Run 與其他 | 沿用 `hosting-evaluation.md` 情境 A | | 0.36 |
| 合計 | | | 9.81 |

換算台幣約 NT$324，匯率沿用 `hosting-evaluation.md` 的 33。Neon 方案是 NT$48，差額每月約 NT$276。GCP 新帳號有 US$300 試用額度，效期 90 天，足以涵蓋 demo 期間。

這個規格的限制與對策：

- shared core 機型不在 Cloud SQL SLA 範圍內。demo 接受。pilot 前升到 `db-g1-small` 或 Enterprise 版 1 vCPU，費用見上表的 pilot 欄。
- 記憶體只有 0.6 GiB，連線數上限低。Cloud Run 的 `max-instances` 與 `pg.Pool` 的連線數必須相乘後低於上限。具體數字在 MIL-92 實測後記錄。
- 建立時必須明確指定 Enterprise 版。用 gcloud 或 API 建立時，PostgreSQL 16 以上預設是 Enterprise Plus，而 Enterprise Plus 沒有 shared core。
- 連線走 Cloud Run 內建的 Cloud SQL 連線器，掛 Unix socket `/cloudsql/<project>:asia-east1:<instance>`。執行個體用公開 IP 即可，不建 VPC 連接器，也不加收網路費。
- 沒有外部連線池，`pg.Pool` 直連。交易範圍的 `set_config(..., true)` 行為與 PGlite 實測相同，仍須在 MIL-92 實測一次。
- Cloud SQL 的 `postgres` 使用者屬於 `cloudsqlsuperuser`，不是真正的 superuser。`app_rw` 仍必須用 SQL 建立，並用系統目錄確認沒有 `BYPASSRLS`。
- 測試不變：本機與 vitest 用 PGlite，CI 用真實 PostgreSQL 容器。

## Action Items

1. 在 Cloud SQL 實測 `pg.Pool` 下的 `set_config(..., true)`。Neon 已不在範圍內（2026-11-08 修訂）。
2. 確認 Cloud SQL 支援的 PostgreSQL 主版本，並與 PGlite 對齊。
3. CI 加 RLS 與 FORCE 檢查、view 的 `security_invoker` 檢查、跨組織滲透測試。
4. A 線 spec 決定 migration 工具。
5. 測試 harness 必須在每次 `clone()` 後重新 `SET ROLE app_rw`。實測 `clone()` 之後 `current_user` 回到 `postgres`，RLS 測試會全部假通過（2026-11-08，PGlite 0.5.15）。

## 編號對應

本 ADR 對應架構文件第 8 節的候選 ADR-0010。正式編號 0010 是簽署模組，0011 是部署（`0011-cloud-run-with-litestream-for-demo.md`，由部署工作落檔），所以本 ADR 取 0012。部署評估寫的「ADR-0010 決定 Cloud SQL 或 Neon」指本 ADR。
