# 部署調研稽核（01 到 04）

稽核日期：2026-11-07。稽核對象：`01-cloudflare.md`、`02-gcp.md`、`03-managed-postgres.md`、`04-cicd.md`。

查證方式：

- Google 定價頁用 `curl` 抓原始 HTML，解析頁面內嵌的 Taiwan 區域表。
- 其他網頁用 WebFetch，內容經摘要模型轉述，引文以此為準。
- 費用表用腳本逐列重算。
- `request.url` 與 standalone 追蹤用實際建置產物測試。

Docker daemon 沒有啟動，所以沒有在 Linux 容器內實測。

## 1. 結論

1. 四份的單價與平台限制大多正確，可以當事實來源。
2. 四份的費用結論不能直接拿來比較，因為 B 與 C 的計算基準不一致。
3. 02 的主推方案定價錯誤：SQLite 加 Litestream 不可用 request-based，pilot 從 $18.44 變成 $53.09（24 小時）或 $19.03（只開上班時段）。
4. 02 低估資料遺失：`max-instances=1` 無法保證單一寫入端，換版時會有兩份各自獨立的 SQLite，遺失範圍會超過「約 1 秒」。
5. 決策前必須改用第 3 節的修正表，並先解決單一寫入端問題，否則 SQLite on Cloud Run 不得進入 pilot。

## 2. 錯誤清單

算式檢查結果：01、02、03 的費用表逐列重算，加總都正確，差異只有四捨五入（B1h 9.54 對 9.55，C3 113.92 對 113.91）。下列錯誤來自假設、漏項與事實，算術錯誤只有 04 的一處。

### 高

**H1. SQLite 加 Litestream 配 request-based 計費**

- 位置：`02:9`、`02:36`、`02:174`、`02:193-209`、`02:215-233`。
- 原文：「pilot 約 $18（SQLite）」；B1 欄標 request-based。`02:174` 寫「預設每秒複寫，崩潰最多失約 1 秒資料」。
- 正確內容：request-based 下 CPU 只在處理請求時配置。Litestream 在請求之間拿不到 CPU，複寫要等下一個請求或 SIGTERM。主推方案必須用 instance-based。B1 $18.44 改為 $53.09。B1h $9.55 改為 $19.03。A2 不能配 Litestream。A1 改用 instance-based 且 `min=0` 時，30 小時費用 $2.16 低於 $5.22 免費額度，總額仍是 $0.36。`02:36` 自己寫了背景同步會被降速，表格卻沒有照做，這是內部矛盾。
- 來源：https://docs.cloud.google.com/run/docs/configuring/billing-settings
- 影響：pilot 排序改變。24 小時常駐時 e2-small VM（約 $26）比 Cloud Run SQLite（$53）便宜。

**H2. `max-instances=1` 無法保證單一寫入端**

- 位置：`02:8`、`02:62`、`02:174`。
- 原文：「Cloud Run 上跑 SQLite 的可行做法只有一種：`max-instances=1`」；風險只寫「造成兩個程序複寫到同一路徑」。
- 正確內容：官方寫這個上限 "can be exceeded for a brief period"。流量切換也不是瞬間完成，進行中的請求可能落在新或舊 revision。每個實例有自己的 ephemeral disk，所以重疊期有兩份 SQLite：新實例從 GCS 還原後，舊實例的寫入不會進入新資料庫。這是腦裂，也會造成複寫路徑損毀。Litestream 設定頁沒有 lease 或防多寫入的設定。
- 來源：https://docs.cloud.google.com/run/docs/configuring/max-instances 、 https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration 、 https://docs.cloud.google.com/run/docs/configuring/services/ephemeral-disk 、 https://litestream.io/tips 、 https://litestream.io/reference/config/
- 影響：合約狀態與已簽檔案紀錄可能在每次部署時遺失。腦裂是依官方行為推論，沒有實測。方案必須加應用層 lease 或部署停機窗。

**H3. 三份費用的基準不同，不能並排比較**

- 位置：`01:99-147`、`02:182-265`、`03:107-134`。
- 原文：`01:11` demo 約 $5.9、pilot 約 $15.3；`02:9` pilot 約 $18、Phase 1 約 $114 到 $269。
- 正確內容：
  - B：01 算 264 小時 4 GiB，02 B1 算 730 小時 1 GiB。01 改 730 小時為 $33.05。
  - C：01 的 $13.19 不含資料庫、PITR、固定出口 IP。加 Neon 後為 $36.44 到 $94.47，仍然沒有固定出口 IP，不符合情境 C。
  - 月份長度：01 與 02 用 730 小時，03 用 720 小時。
- 來源：https://developers.cloudflare.com/containers/pricing/ 、 https://developers.cloudflare.com/containers/platform-details/limits/
- 影響：直接比表會得到 Cloudflare 便宜 10 倍的錯誤結論。

### 中

**M1. 點點簽簽章寫成未查到**

- 位置：`02:139`、`02:10`。
- 原文：「點點簽是否支援簽章或自訂標頭……未查到」。
- 正確內容：專案已實作驗簽。`src/app/api/webhooks/dottedsign/route.ts:17-19` 讀 `signature` header 做 HMAC 驗證。`docs/research/dottedsign-signing-history.md:56` 也有記載。空 body 的驗證 ping 無簽章且須回 200（`route.ts:14`）。
- 來源：repo 內檔案。
- 影響：webhook 端的應用層驗證已經完成，只缺後台登入。「拆 service 或加 LB」不是唯一低成本路線。

**M2. IAP 漏掉 organization 限制**

- 位置：`02:129-138`。
- 正確內容：Google-managed OAuth client 只能管理組織內部使用者。專案不在 Google Cloud organization 內時，必須建立自訂 OAuth client。「一鍵」不適用個人帳號。此專案的 GCP 帳號型態未知。
- 來源：https://docs.cloud.google.com/iap/docs/custom-oauth-configuration
- 影響：demo 前的登入保護多一段 OAuth 設定。

**M3. 「VM 最便宜」只在 24 小時常駐時成立**

- 位置：`02:11`。
- 原文：「Compute Engine 小型 VM（e2-small，約 $20 到 $25 加 pilot 起）最便宜也最單純」。
- 正確內容：同一份表的 A1 $0.36 更低；修正後 B1h $19.03 也低於 VM $26.31。只有 B 必須 24 小時常駐時，VM 才低於 Cloud Run。
- 來源：本稽核第 3 節重算。

**M4. Cloud SQL 儲存量低於可行值**

- 位置：`02:222`、`02:253`。
- 原文：「Cloud SQL SSD 5 GB」；C 的 10 GB 資料配 10 GB SSD。
- 正確內容：磁碟下限 10 GB。自動擴容門檻是 `MIN(5 + 容量/25, 25)`，因此 5 GB 資料要配 11 GB，10 GB 資料要配 16 GB 才不會觸發擴容（容量推算為推論）。B2 +$1.02；C1、C3 +$1.02；C2 +$2.04。
- 來源：https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances 、 https://docs.cloud.google.com/sql/docs/postgres/instance-settings

**M5. 免費額度疊加未確認**

- 位置：`02:186`、`02:247-251`。
- 原文：Web 用 180,000 vCPU-秒免費額度，Worker pool 另外再扣 $5.22。
- 正確內容：定價頁寫 "The free tier is applied as a spending based discount using Tier 1 pricing"。三組額度換算金額都是 $5.22（$4.32 + $0.90），頁面沒有說明能否疊加，也沒有說明閒置項能否抵扣。若共用一份，C 增加 $5.07。若閒置可抵，A2 減少約 $0.63。
- 來源：https://cloud.google.com/run/pricing

**M6. 01 把 FUSE 列為 SQLite 持久化做法**

- 位置：`01:9`。
- 原文：「必須自己把 SQLite 與 PDF 同步到 R2（FUSE 或自寫備份）」。
- 正確內容：02 已依官方文件排除物件儲存 FUSE 跑資料庫，01 卻把它列為選項，兩份標準不一致。Cloudflare 頁面只警告效能，沒有說明鎖定語意。SQLite 應走 Litestream 類複寫（推論），FUSE 只適合整檔寫入的 PDF。結論也漏了同頁提到的 `durable_object` 排程快照。
- 來源：https://developers.cloudflare.com/containers/platform-details/architecture/ 、 https://docs.cloud.google.com/storage/docs/cloud-storage-fuse/overview

**M7. Hyperdrive 查詢快取預設開啟，與 RLS 有風險**

- 位置：`01:75-79`、`03:77`。
- 正確內容：官方寫 "Query caching is enabled by default"（`max_age` 60 秒），且寫入不會讓快取失效。01 沒提。03 只寫「交易型資料不要開」，沒說預設開啟。頁面沒有說明快取 key 是否含 session 變數，也沒有說明交易內查詢是否快取。官方建議必須即時的讀取改用停用快取的設定。
- 來源：https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
- 影響：多租戶下有跨租戶讀取的可能（推論）。走 Hyperdrive 時 RLS 連線必須用關閉快取的設定，並寫跨租戶整合測試。

**M8. 04 與 01、02 互相矛盾**

- 位置：`04:192`、`04:376`、`04:9`、`04:185`、`04:11`、`04:383`。
- 原文：「磁碟是否持久：未查到」；「SQLite 在 Cloud Run 的持久化方案：未調研」。
- 正確內容：官方寫 "All disk is ephemeral by default"，01 已正確記載。02 已調研持久化方案。讀 04 必須以 01 與 02 的結論為準。
- 來源：https://developers.cloudflare.com/containers/faq/

**M9. Preview 用 tag revision 會多出一個寫入端**

- 位置：`04:199-209`。
- 原文：「tag revision 跟正式共用同一個 service 的環境變數與 SQLite 實例檔案系統；每個 revision 實例各有獨立記憶體內檔案系統」。
- 正確內容：句子前後矛盾，每個實例的檔案系統各自獨立。Tag revision 啟動後只有在流量分配內才計入上限，所以它不受 `max-instances=1` 約束。它共用環境變數，若設定 Litestream 會寫入同一個 GCS 路徑，官方警告可能無法還原。
- 來源：https://docs.cloud.google.com/run/docs/configuring/max-instances 、 https://litestream.io/tips
- 影響：SQLite 階段的 preview 必須關閉 Litestream 或用獨立路徑與 mock 資料。

**M10. `node:24-slim` 的理由不成立，建議本身在 amd64 上成立**

- 位置：`04:287`。
- 原文：「sharp 與其他套件在 musl 上常有記憶體配置問題」。
- 正確內容：`self-hosting.md:25` 只提到 glibc 上的 sharp 要額外設定，沒有提到 musl 問題。專案的 `package.json` 沒有直接依賴 sharp，`src` 也沒有用 `next/image`。

  核對結果：

  - `engines >=22`，Node 24 仍是 LTS，所以 Node 版本可行。
  - `linux-x64.node` 需要 `GLIBC_2.34`，`node:24-slim` 預設 bookworm（glibc 2.36），可以載入（glibc 版本號為已知值，未實測）。
  - `linux-arm64.node`（13.0.1）需要 `GLIBC_2.38`，Apple Silicon 本機建置 bookworm 映像會無法載入（推論）。
  - Node 26 已是最新 LTS（v26.13.0），預設 trixie，本機也是 v26.5.0。`node:26-slim` 能同時解決 arm64 與版本差異，建議比較。
- 來源：https://nodejs.org/en/about/previous-releases 、 https://raw.githubusercontent.com/nodejs/docker-node/main/versions.json 、本機 `strings node_modules/better-sqlite3/prebuilds/*.node`

### 低

| 編號 | 位置 | 原文 | 正確內容 | 來源 |
|---|---|---|---|---|
| L1 | `04:33`、`04:58`、`04:81` | `actions/checkout` v6 | 最新 v7.0.1（2026-07-20），auth README 範例也用 v7 | `gh api repos/actions/checkout/releases/latest`；https://github.com/google-github-actions/auth |
| L2 | `04:252` | 高估情境「仍約 USD 5」 | 100×4.5 + 60×12 = 1,170 分鐘，$7.02。結論（低於 $12）不變 | https://docs.github.com/en/billing/reference/actions-runner-pricing |
| L3 | `01:99` | 「1 月以 30 天計；整月 730 小時」 | 30 天是 720 小時，算式實際用 730 | 算術 |
| L4 | `03:109`、`03:118-119` | 720 小時 | 統一 730 小時後，Neon C 為 $23.24、$81.28 | https://neon.com/pricing |
| L5 | `03:77` | Supabase 的 Hyperdrive 步驟未查到 | 官方有專頁，要用 direct connection，不用 pooler | https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/ |
| L6 | `03:9`、`03:55` | `SET LOCAL` 未明載，風險待定 | PostgreSQL 定義它只到交易結束，語意與 transaction pooling 相符。PoC 仍要做，但不確定性比原文小 | https://www.postgresql.org/docs/current/sql-set.html |
| L7 | `02:50` | ephemeral disk 發布階段未查到 | 2026-04-20 Preview，2026-11-04 GA，GA 才 3 天 | https://docs.cloud.google.com/run/docs/release-notes |
| L8 | `02:140` | spend cap 達 100% 暫停 | 2026-10-12 GA。官方寫生效不是即時，超額照收，不能當硬上限 | https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps |
| L9 | `02:121-125` | 只列 LB 與 domain mapping | 官方還列 Firebase Hosting | https://docs.cloud.google.com/run/docs/mapping-custom-domains |
| L10 | `02:239`、`02:270` | 快照費用未查到 | asia-east1 standard snapshot $0.05 /GiB-月 | https://cloud.google.com/compute/disks-image-pricing |
| L11 | `02:187` | B 的 GCS 操作 $0.50（低信心） | Litestream 官方：持續寫入每月約 259 萬次請求。以 $0.005/千次，上班時段上限 $4.75，全月上限 $12.96。$0.50 只在寫入稀疏時成立 | https://litestream.io/reference/config/ |
| L12 | `04:136` | Artifact Registry 無已知限制 | 該列 Other 欄寫 Container Registry 不支援 identity federation。Artifact Registry 本身未見限制 | https://docs.cloud.google.com/iam/docs/federated-identity-supported-services |
| L13 | `03:57` | CLI 建的角色都是 `neon_superuser` 成員 | 加 `--access read_only` 或 `read_write` 時例外 | https://neon.com/docs/manage/roles |

## 3. 重算後的費用表

單位：美元每月。修正值的計算腳本結果已逐項核對。

### 逐方案

| 方案 | 情境 | 原值 | 修正值 | 差額 | 原因 |
|---|---|---|---|---|---|
| CF Containers + SQLite，standard-1 | A | 5.87 | 5.87 | 0 | DO 用量在含量內，$0 |
| 同上，264 小時 | B | 15.33 | 15.33 | 0 | 休眠後要從 R2 還原 |
| 同上，730 小時 | B | 無 | 33.05 | 新增 | 與 02 B1 同基準 |
| 同上，standard-2，264 小時 | B | 21.25 | 21.25 | 0 | |
| CF Workers + R2 + worker 容器，不含 DB | C | 13.19 | 13.19 | 0 | 不符合 C：無 DB、無固定 IP |
| 同上 + Neon 0.25 / 1 CU | C | 無 | 36.44 / 94.47 | 新增 | 仍無固定 IP |
| A1 Cloud Run min=0 + Litestream | A | 0.36 | 0.36 | 0 | 須改 instance-based |
| A2 min=1 request-based + Litestream | A | 13.11 | 不適用 | | 複寫拿不到 CPU |
| A3 min=1 instance-based | A | 47.85 | 47.85 | 0 | |
| A4 e2-small | A | 20.05 | 20.15 | +0.10 | 加快照；Standard Tier 為 19.91 |
| B1 min=1 + SQLite | B | 18.44 | 53.09 | +34.65 | 改 instance-based |
| B1h 上班時段 + SQLite | B | 9.55 | 19.03 | +9.48 | 改 instance-based |
| B2 Cloud Run + `db-g1-small` | B | 43.84 | 44.86 | +1.02 | SSD 11 GB |
| B3 e2-small | B | 25.41 | 26.31 | +0.90 | 加快照；Standard Tier 為 22.71 |
| C1 Cloud SQL 2 vCPU / 8 GiB | C | 165.78 | 166.80 | +1.02 | SSD 16 GB；額度共用時 171.87 |
| C2 同上 HA | C | 268.66 | 270.70 | +2.04 | 額度共用時 275.77 |
| C3 Cloud SQL 1 vCPU / 3.75 GiB | C | 113.91 | 114.94 | +1.03 | 額度共用時 120.01 |
| C4 e2-standard-2 自管 | C | 83.19 | 85.19 | +2.00 | 加快照；Standard Tier 為 73.19 |
| Neon Launch，僅 DB | A | 1.15 | 1.15 | 0 | |
| Neon 0.25 / 1 CU，僅 DB | B | 8.95 / 29.93 | 8.95 / 29.93 | 0 | |
| Neon 0.25 / 1 CU，僅 DB | C | 22.98 / 80.22 | 23.24 / 81.28 | +0.26 / +1.06 | 730 小時 |
| Supabase Pro，僅 DB | A | 25.00 | 25.00 | 0 | |
| Supabase Micro / Small，僅 DB | B | 25 / 30 | 25 / 30 | 0 | |
| Supabase Micro / Small + PITR，僅 DB | C | 125.25 / 130.25 | 125.25 / 130.25 | 0 | |

快照用「已用資料量 × $0.05」估一份完整快照，是推論。

### 同基準總表（可比較）

Cloud Run 走 PostgreSQL 時用 request-based，A 為 `min=0`，B 與 C 為 `min=1`。C 含 worker pool、Cloud NAT、固定 IP。走 PostgreSQL 的方案都要先完成 M1 非同步化與資料層遷移，表內沒有計入。

| 方案 | A | B | C | 符合 C？ |
|---|---|---|---|---|
| Cloud Run + SQLite + Litestream | 0.36 | 19.03（上班時段）/ 53.09（24 小時） | 不適用 | 否 |
| Cloud Run + Cloud SQL | 不適用 | 44.86 | 114.94 到 270.70 | 是，HA 才有 SLA |
| Cloud Run + Neon | 1.46 | 25.99 到 46.97 | 85.34 到 143.38 | 是，跨雲到新加坡 |
| Cloud Run + Supabase | 25.31 | 42.04 到 47.04 | 187.35 到 192.35 | 是，跨雲到東京 |
| e2-small / e2-standard-2 自管 | 20.15 | 26.31 | 85.19 | 是，單機無 SLA，PITR 自建 |
| CF Containers + SQLite | 5.87 | 15.33（264 小時）/ 33.05（730 小時） | 不適用 | 否 |
| CF Workers + Hyperdrive + Neon | 未估 | 未估 | 36.44 到 94.47 | 否，無固定 IP |

Cloud Run 跨雲方案若額度不能疊加，C 再加 $5.07。Cloud NAT 的 5 GiB 假設對跨雲不成立，見漏項 9。

## 4. 無法核實的項目

- Compute Engine 官方定價頁（https://cloud.google.com/compute/vm-instance-pricing）的價格是動態載入，無法回查。e2-micro $7.08、e2-small $14.16、e2-standard-2 $56.64 只由第三方資料確認：https://gcloud-compute.com/e2-small.html 與 https://raw.githubusercontent.com/Cyclenerd/google-cloud-pricing-cost-calculator/master/pricing.yml（同一作者，非獨立來源）。搜尋摘要另有 Holori 的 e2-medium $46.76，與此來源 $28.32 不符。Holori 頁面未開啟。開通帳號後必須用 Pricing Calculator 再核對。
- Cloud Run 免費額度能否跨 service 與 worker pool 疊加、能否抵扣閒置項。
- Cloud NAT 如何計算 Cloud Run 實例的「VM 數」。Worker pool 文件列出 Direct VPC，但沒有提固定出口 IP。
- Cloud SQL PITR 的 RPO 與日誌是否另計。PITR 頁只寫日誌存 Cloud Storage。
- Neon 的 RPO。還原粒度到毫秒，但頁面沒有寫 RPO。
- Cloud Run 實例回收頻率。官方只說閒置實例可隨時關閉，底層重啟時會替換，沒有數字。
- Cloud Run 前端是否固定送 `X-Forwarded-Proto`、`X-Forwarded-Host`。Container contract 頁沒有提。
- Litestream 從 GCS 還原 5 GB 的時間、Next.js 加 better-sqlite3 在 Cloud Run 的冷啟動秒數。
- 點點簽 webhook 的 client timeout 與 User-Agent。
- Hyperdrive 快取 key 是否含 session 變數、交易內查詢是否快取。
- Durable Object 在容器運行時是否持續計 duration。若持續計，24 小時為 328,500 GB-s，仍低於 400,000 GB-s 含量，費用不變。
- `pdf-lib` 在 128 MB Workers 內的記憶體尖峰。
- better-sqlite3 13.0.3 的 arm64 glibc 需求，只看到 release note（改用 Ubuntu 22.04-arm），沒有檢查二進位檔。
- Supabase 磁碟自動擴容規則，`compute-and-disk` 頁沒有寫。

本次沒有回查、影響較低的項目：`03` 第 7 節 Render、Railway、Fly；`03` 第 4 節 AWS 延遲；`01` R2 位置提示與 D1 定價；`02` Cloud SQL 啟停與版本；`04` 的 fork PR、`type=gha`、rollback 文件；`03` [G2] 函釋。

## 5. 漏項清單

1. **換版期間的雙寫**：見 H2。四份都沒有寫出解法。可行方向是應用層 lease（GCS 條件寫入）或部署停機窗，都需要實作。
2. **實例回收造成的資料遺失窗口**：官方寫 "Idle instances, including those kept warm using minimum instances, can be shut down at any time"，底層更新時也會替換實例。`min=1` 不代表磁碟常在，每次回收都要完整還原。來源：https://docs.cloud.google.com/run/docs/configuring/billing-settings 、 https://docs.cloud.google.com/run/docs/container-contract
3. **SIGTERM 只有 10 秒**：官方建議不要完全依賴這段時間，要逐步複製到持久儲存。來源：https://docs.cloud.google.com/run/docs/configuring/services/ephemeral-disk
4. **還原與啟動上限**：實例必須在 4 分鐘內開始監聽；預設 TCP probe 240 秒；自訂 probe 上限 600 秒。04 的範例 probe 是 5 × 6 = 30 秒，配 5 GB 還原會失敗（推論）。ephemeral disk 文件建議大量下載走 Direct VPC，02 沒有列入。來源：https://docs.cloud.google.com/run/docs/configuring/healthchecks
5. **Webhook 與冷啟動**：Cloud Run 請求逾時預設 300 秒，足夠 `completed` 事件在 request 內下載兩份 PDF（`route.ts:51`）。風險在發送端：`min=0` 或 B1h 下班時段，冷啟動加還原可能超過點點簽的等待時間，回應非 2xx 會重試 3 次，單日 10 次失敗會暫停整個 application 的 webhook。來源：https://docs.cloud.google.com/run/docs/configuring/request-timeout 、`docs/research/dottedsign-signing-history.md:57`
6. **單實例的併發**：`better-sqlite3` 是同步 API，PDF 產生也佔事件迴圈。`max-instances=1` 達上限時官方會回 "No available container instances"。這類錯誤打到 webhook 就算投遞失敗（推論）。
7. **PDF 的落地路徑**：`DATA_DIR` 寫死 `process.cwd()/data`（`src/lib/db.ts:20`），DB 與 `contract-files` 在同一層。02 算了 GCS 費用，但沒有設計掛載：要巢狀掛 `/app/data/contract-files` 或改程式。`serveContractFile` 會在檔案不存在時向點點簽補抓，mock 模式則重新產生。來源：`src/lib/contract-files.ts:172-187`、`:218-231`
8. **第 2 代環境**：與第 1 代同價，至少 512 MiB，部分服務冷啟動較長，沒有另外的計費下限，計費進位到 100 ms。小於 1 vCPU 只能用第 1 代，所以 ephemeral disk 不能配 0.5 vCPU。預設環境是 unspecified，由功能決定。來源：https://docs.cloud.google.com/run/docs/configuring/execution-environments 、 https://docs.cloud.google.com/run/docs/configuring/services/cpu
9. **跨雲費用**：`--vpc-egress=all-traffic` 下，Cloud Run 到 Neon 或 Supabase 的所有 DB 流量都走 Cloud NAT，$0.045 /GiB，出站再加網際網路 egress。02 的 NAT 5 GiB 假設只適用 Cloud SQL。來源：https://cloud.google.com/nat/pricing
10. **VM 的 Standard Tier**：VM 可用 Standard Tier，asia-east1 可用，每月前 200 GiB 免費。A、B、C 的 egress 都在額度內，比 02 的 Premium 算法各省 $0.24、$3.60、$12。Cloud Run 不適用（推論，未查到可設定 Standard Tier 的文件）。來源：https://cloud.google.com/vpc/network-pricing 、 https://docs.cloud.google.com/network-tiers/docs/overview
11. **04 的骨架無法跑 02 的方案**：Dockerfile 沒有 Litestream wrapper。workflow 沒有 `--execution-environment=gen2`、`--no-cpu-throttling`、`--max-instances=1`、volume 掛載。
12. **沒有 `.dockerignore`**：repo 目前沒有這個檔案。本機 `COPY . .` 會帶入 `.env*`、`data/`、本機 `node_modules`，並覆蓋 deps 階段的 Linux 版相依。CI 的乾淨 checkout 沒有這個問題。
13. **原生模組只追蹤建置平台**：macOS 建置的 standalone 只有 `prebuilds/darwin-arm64.node`。映像必須在目標平台建置，不能交叉複製。
14. **Cloud SQL 連線數**：Cloud Run 走內建連線方式時，每個實例對每個資料庫上限 100 條；Auth Proxy、Language Connector、直連 IP 不受此限。`db-g1-small` 的 `max_connections` 官方沒有列。來源：https://docs.cloud.google.com/sql/docs/postgres/quotas
15. **Cloudflare 容器位置會變**：官方寫重啟後請求可能導向不同地點，也可能與 DO 不同地點。對延遲與資料落地都有影響。Containers 的 outbound 攔截只涵蓋 80 與 443。來源：https://developers.cloudflare.com/containers/platform-details/architecture/ 、 https://developers.cloudflare.com/containers/platform-details/outbound-traffic/
16. **Access Bypass 的代價**：webhook 只能用 Bypass，因為點點簽無法帶 service token（推論）。官方寫 Bypass 的請求不留 Access 紀錄。01 的「推論」可升為確認。來源：https://developers.cloudflare.com/cloudflare-one/access-controls/policies/

## 6. 已回查且確認正確的重點

**Cloud Run 與 GCP**

- asia-east1 為 Tier 1；request-based 使用中 vCPU $0.000024、記憶體 $0.0000025、閒置各 $0.0000025、請求 $0.40/百萬；instance-based $0.000018、$0.000002；worker pool $0.000011244、$0.000001235；ephemeral disk $0.000109589/GiB-小時；免費額度數字。https://cloud.google.com/run/pricing
- Cloud SQL Taiwan：`db-f1-micro` $7.665、`db-g1-small` $25.55、vCPU $30.149、記憶體 $5.11、SSD $0.17、HA 2 倍、備份 $0.08、閒置 IPv4 $7.30。https://cloud.google.com/sql/pricing
- shared-core 與單區不在 SLA 內。https://cloud.google.com/sql/sla
- 免費 e2-micro 只限美國三區，asia-east1 不適用；Cloud Storage 免費額度同樣只限美國區。https://docs.cloud.google.com/free/docs/free-cloud-features
- 外部 IP $0.005/小時、未使用 $7.30/月、到亞洲 egress $0.12/GiB、轉發規則 $18.25/月。https://cloud.google.com/vpc/network-pricing
- Cloud NAT $0.0014 × VM/小時、$0.045/GiB、IP $0.005/小時。https://cloud.google.com/nat/pricing
- pd-balanced $0.10、pd-standard $0.04。https://cloud.google.com/compute/disks-image-pricing
- GCS asia-east1 $0.02/GiB-月、Class A $0.005/千次、Class B $0.0004/千次。https://cloud.google.com/storage/pricing
- Artifact Registry 與 Secret Manager 單價。https://cloud.google.com/artifact-registry/pricing 、 https://cloud.google.com/secret-manager/pricing
- GCS FUSE "does not support file locking or file patching"、"shouldn't be used as the backend for storing a database"。https://docs.cloud.google.com/storage/docs/cloud-storage-fuse/overview
- last write wins。https://docs.cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts
- NFS 不支援鎖定，no-lock 掛載。https://docs.cloud.google.com/run/docs/configuring/services/nfs-volume-mounts
- ephemeral disk 存在，1 到 100 GiB，每實例預設 10 GiB，第 2 代，全區域，依佈建量與實例存活時間計費，實例關閉即刪除。https://docs.cloud.google.com/run/docs/configuring/services/ephemeral-disk
- Worker pools GA（2026-04-14）。https://docs.cloud.google.com/run/docs/release-notes
- 直連 IAP GA（2026-03-14）、不收費；保護所有入口；文件沒有路徑放行；不能同時在 LB 與 Cloud Run 啟用。https://cloud.google.com/blog/products/serverless/iap-integration-with-cloud-run 、 https://docs.cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run
- domain mapping 支援 asia-east1，仍是 Preview，官方不建議正式環境。https://docs.cloud.google.com/run/docs/mapping-custom-domains
- Cloud Run 不支援 WIF direct resource access。https://docs.cloud.google.com/iam/docs/federated-identity-supported-services

**Litestream**

- v0.5.18（2026-11-03），GCS 為支援的 replica，預設每秒同步。https://github.com/benbjohnson/litestream/releases/tag/v0.5.18 、 https://litestream.io/guides/gcs/ 、 https://litestream.io/reference/config/

**Cloudflare**

- Containers GA 2026-04-13。https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/
- Containers 定價與規格表、磁碟預設暫存、休眠後全新磁碟、未提供指定區域。https://developers.cloudflare.com/containers/pricing/ 、 https://developers.cloudflare.com/containers/platform-details/limits/ 、 https://developers.cloudflare.com/containers/faq/
- Workers bundle 矛盾裁決：01 正確，以 Workers 限制頁為準。壓縮後 3 MB、10 MB 上限已於 2026-09-04 移除，只剩未壓縮 64 MiB。OpenNext 頁過時。記憶體 128 MB 不變。https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/ 、 https://developers.cloudflare.com/workers/platform/limits/ 、 https://opennext.js.org/cloudflare
- OpenNext 1.20.16「require Next.js 15.5.29 or 16.4.5」屬實。https://github.com/opennextjs/opennextjs-cloudflare/releases
- `*.workers.dev` 無法關閉 Browser Integrity Check，error 1010 發生在 Worker 之前。https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Workers `/tmp` 每請求獨立、`/bundle` 唯讀；`node:sqlite` 是 stub；文件沒有提原生 addon。https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/ 、 https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- vinext 為預設建議且仍在 beta。https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/
- R2、Workers、DO 含量與單價；Hyperdrive 計價與限制、transaction 模式、SET 語意；Access 50 人免費。https://developers.cloudflare.com/r2/pricing/ 、 https://developers.cloudflare.com/workers/platform/pricing/ 、 https://developers.cloudflare.com/hyperdrive/platform/limits/ 、 https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/ 、 https://www.cloudflare.com/plans/sase-zero-trust.md
- Containers 固定出口 IP：outbound 文件沒有提到。搜尋只找到 Enterprise 的 Gateway dedicated egress 與 BYOIP，這兩項只看過搜尋摘要，沒有開頁。https://developers.cloudflare.com/containers/platform-details/outbound-traffic/

**Neon 與 Supabase**

- Neon Launch 無最低月費、$0.106/CU-小時、$0.35/GB-月、history $0.20/GB-月。https://neon.com/pricing
- AWS 區域有新加坡，沒有東京。https://neon.com/docs/introduction/regions
- `neon_superuser` 含 BYPASSRLS；Console、API 建的角色是成員，SQL `CREATE ROLE` 建的不是。https://neon.com/docs/manage/roles
- Supabase Pro $25、$10 credits、8 GB、PITR $100/7 天、所有 compute 可用、RPO 最壞 2 分鐘、啟用後不再做每日備份、`service_role` 與 `postgres` 有 bypassrls、沒有台灣區。https://supabase.com/pricing 、 https://supabase.com/docs/guides/platform/backups 、 https://supabase.com/docs/guides/database/postgres/row-level-security 、 https://supabase.com/docs/guides/platform/regions
- 個資法第 21 條、第 20-1 條、第 27 條已刪除。https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?pcode=I0050021

**GitHub Actions 與套件**

- Repo 為 public。Public repo 標準 runner 免費。Private 額度以金額表示：Free $12、Pro $18、Team $18；Linux 2-core $0.006/分鐘。public `ubuntu-latest` 4 vCPU、16 GB。https://docs.github.com/en/billing/concepts/product-billing/github-actions 、 https://docs.github.com/en/billing/reference/actions-runner-pricing 、 https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- 主版本（`gh api` 查最新 release）：`auth` v3、`deploy-cloudrun` v3、`setup-gcloud` v3.0.1、`docker/build-push-action` v7.4.0、`docker/login-action` v4.8.0、`setup-buildx-action` v4.4.1、`setup-node` v7.1.0、`wrangler-action` v4.1.3。
- better-sqlite3：13.0.1 `engines >=22`；13.0.0 改 N-API，prebuild 隨套件發布；最新 13.0.3；12.10.0 加 Node 26 移除 20、23。https://github.com/WiseLibs/better-sqlite3/releases

**程式碼相關（04）**

- `serverExternalPackages.md:47` 列 `better-sqlite3`，`lib/server-external-packages.jsonc:33` 也有。
- `pdf.ts:35`、`design-theme-loader.ts:12`、`db.ts:20`、`sign-link/route.ts:21` 行號正確。全 `src` 只有 `sign-link` 用 `request.url` 取 origin。
- **`request.url` 實測確認**：用 standalone 建置以 `HOSTNAME=0.0.0.0` 啟動，送 `Host: rent-poc-demo-123.asia-east1.run.app` 與 `X-Forwarded-Proto: https`。`request.url` 與 `nextUrl` 都回 `https://0.0.0.0:39907/...`。加 `X-Forwarded-Host` 也不變。`x-forwarded-host` 在缺少時會由 `Host` 補上。所以 `sign-link` 的 `redirectUrl` 在所有反向代理部署都是錯的，任何平台上線前都必須修。
- **檔案追蹤實測**：沒有設定 `outputFileTracingIncludes` 的建置，`.next/standalone` 已含 `DESIGN.md`、`assets/fonts/NotoSansTC-Regular.ttf`、`better-sqlite3/prebuilds/*.node`。04 列為「須實測」的項目在 macOS 上已通過。04 建議的 `outputFileTracingIncludes` 無害但目前非必要，`'/*'` 寫法符合 `output.md`，`contains: true` 讓它能比對巢狀路由。
- `output.md` 確實要手動複製 `public` 與 `.next/static`。

測試用的建置產物來自另一個工作階段（當時工作樹有未提交的 `output: 'standalone'` 與 `src/app/api/tmp-origin/`，之後已清除）。稽核時把產物複製到 scratchpad 執行，沒有改動 repo 內容。

## 7. 網頁內容中要求 AI 執行動作的紀錄

下列 Neon 文件頁含有針對 AI 助理的文字，要求安裝 agent skills（`npx neon@latest skills -y`）、依 `neon.com/prompts/agent-setup.md` 代為操作，以及向 `https://feedback.neon.tech/` 發送 POST。本次一律忽略，沒有執行。

- https://neon.com/docs/introduction/regions
- https://neon.com/docs/manage/roles
- https://neon.com/docs/connect/connection-pooling
- https://neon.com/docs/introduction/branch-restore

`03` 的 [N8] 頁也有同類文字，原作者已註記忽略。
