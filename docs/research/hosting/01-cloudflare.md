# Cloudflare 部署調研

查詢日期：2026-11-07。所有數字來自這次實際抓取的官方頁面。信心欄：高 = 官方頁面，中 = 官方 GitHub 或第三方，低 = 推論。「推論」都寫出依據。

## 結論

1. 現況（`better-sqlite3` 加本機檔案）不能用 Workers 或 Pages 跑。Workers 沒有原生模組，`node:fs` 是記憶體虛擬檔案系統，`/tmp` 每個請求獨立，不會保留。
2. 現況能上 Cloudflare 的唯一路徑是 Cloudflare Containers（2026-04-13 起 GA，需 Workers Paid）。但容器磁碟預設是暫存的，休眠後從映像重來，SQLite 檔會遺失。
3. 要在容器內留住資料，必須自己把 SQLite 與 PDF 同步到 R2（FUSE 或自寫備份），官方警告效能不像 SSD。這是額外工程，且 RPO 5 分鐘需自己做。
4. 長期路徑是 Workers 加 OpenNext、Hyperdrive 接 PostgreSQL、R2 存檔，與架構 v2 方向一致。前提是先完成 M1 非同步化。OpenNext 目前要求 Next.js 16.4.5 以上，專案現在是 16.2.11，需升版。
5. demo 費用約 US$5.9 每月，pilot 約 US$15.3 每月（皆為 Cloudflare 端）。固定出口 IP 對 Containers 與 Workers 皆未查到官方方案，這是 Phase 1 結尾的風險。

## 1. Workers 加 OpenNext 與 Pages

- `@opennextjs/cloudflare` 支援 Next.js 16 全部 minor 與 patch，也支援 Node.js runtime（不是 Edge）。信心：高。來源 [S1]。
- Node Middleware（15.2 起）尚未支援。信心：高。[S1]
- 最新版 1.20.16（Nov 3）。該版把最低 Next.js 版本提高到 15.5.29 與 16.4.5。1.20.12 加入 Next.js 16.4 支援。信心：中（GitHub release 頁，經摘要工具轉述，建議升版前直接讀 release note）。[S2]
- 推論：專案 Next.js 16.2.11 低於 16.4.5，用最新 adapter 需先升 Next.js。依據：上一條的最低版本規定。
- Cloudflare 官方 Next.js 指南把 vinext（Vite plugin，beta）列為預設建議，OpenNext 列為已有 OpenNext 應用、無法遷到 vinext 時的選項。信心：高。[S3]
- Pages：官方 Pages 遷移頁沒有宣告棄用，但建議框架專案改用 Workers adapter。Next.js 指南只把 Pages 留給靜態匯出。`@cloudflare/next-on-pages` 只支援 Edge runtime。本專案全是 Node.js runtime route handler，所以 Pages 不是可行路徑。信心：高（無棄用公告為「未查到棄用宣告」）。[S3][S4][S1]

## 2. Workers 限制

| 項目 | Free | Paid | 信心 |
|---|---|---|---|
| Worker 大小 | 64 MiB（未壓縮） | 64 MiB（未壓縮） | 高 [S5] |
| 壓縮後大小 | 無限制（該頁寫法） | 無限制 | 高 [S5] |
| 記憶體 | 128 MB 每 isolate | 128 MB | 高 [S5] |
| CPU time 每 HTTP 請求 | 10 ms | 預設 30 秒，最高 5 分鐘 | 高 [S5] |
| Subrequest | 50 | 10,000 | 高 [S5] |
| 啟動時間 | 1 秒 | 1 秒 | 高 [S5] |

- 矛盾：OpenNext 文件寫「壓縮後 Free 3 MiB、Paid 10 MiB」。Workers 限制頁寫 64 MiB 且無壓縮上限。兩頁不一致，OpenNext 頁可能過時。以 Workers 限制頁為準，部署時實測。信心：中。[S1][S5]
- 原生模組：`nodejs_compat` 頁沒有提到 `.node` 或 `better-sqlite3`，`node:sqlite` 也只是不能用的 stub。結論：`better-sqlite3` 不可用。信心：中（官方頁未明說，依「無原生 addon 支援」的缺漏與 stub 清單推論）。[S6]
- `fs`：`nodejs_compat` 加 compat date 2025-09-01 以後預設有 `node:fs`，是記憶體虛擬檔案系統。`/bundle` 唯讀，`/tmp` 是「每個請求獨立、不持久」，單檔最大 128 MB，暫存檔計入記憶體限制。所以 `data/rent-poc.db` 與 `data/contract-files/` 的寫法不能用。信心：高。[S7]
- 7 MB 字型三種放法：
  1. 靜態資產：單檔上限 25 MiB（Free 與 Paid），檔案數 20,000（Free）或 100,000（Paid）。靜態資產請求免費。信心：高 [S8][S9]。Worker 需用 assets binding 取回再讀入記憶體（推論，依據：binding 回傳 Response）。
  2. 打包進 Worker：計入 64 MiB，從 `/bundle` 用 `fs` 讀。信心：高 [S7]。
  3. R2：每次讀取付 Class B 操作費（見第 6 節），啟動時要先抓。
- 128 MB 記憶體內 pdf-lib 內嵌 7 MB 字型：未查到實測。搜尋只找到一般性的緩衝與 1102 錯誤說明。推論：字型 7 MB、PDF 4.3 MB、base64 5.8 MB 加 Next.js 本身，總量應在 128 MB 內，但同一 isolate 可併發多請求，且「記憶體尖峰未量測」是原始限制，需部署前量測。信心：低。

## 3. Cloudflare Containers

- 狀態：2026-04-13 GA，同時發布 Sandbox SDK。信心：高。[S10] 此前自 2025-06 起為 beta（二手報導，中）。
- 方案：需要 Workers Paid。Free 不可用。[S11]
- 計價（Workers Paid）。信心：高。[S11]

| 資源 | 每月含 | 超出單價 |
|---|---|---|
| 記憶體 | 25 GiB-hours | $0.0000025 / GiB-s |
| CPU | 375 vCPU-minutes | $0.000020 / vCPU-s（只計實際用量） |
| 磁碟 | 200 GB-hours | $0.00000007 / GB-s |
| 出口流量 北美與歐洲 | 1 TB | $0.025 / GB |
| 出口流量 大洋洲、韓國、台灣 | 500 GB | $0.05 / GB |
| 出口流量 其他 | 500 GB | $0.04 / GB |

- 記憶體與磁碟依「佈建量」計，CPU 依「使用量」計。每 10 ms 一個計費單位，從收到請求或手動啟動起算，休眠後停止。Durable Object 與 Workers 請求另計。[S11]
- 規格：lite 1/16 vCPU 256 MiB 2 GB；basic 1/4 vCPU 1 GiB 4 GB；standard-1 1/2 vCPU 4 GiB 8 GB；standard-2 1 vCPU 6 GiB 12 GB；standard-3 2 vCPU 8 GiB 16 GB；standard-4 4 vCPU 12 GiB 20 GB。自訂最大磁碟 20 GB。[S11][S12]
- 磁碟：「預設全是暫存」。休眠後下次啟動用映像的全新磁碟。`durable_object` 排程策略可建立與還原快照。FUSE 可掛 R2，但官方警告別預期 SSD 效能。信心：高。[S13][S14]
- 能否跑原映像與 `better-sqlite3`：映像需 `linux/amd64`，限制很少，每個實例是 Firecracker microVM。推論：標準 Linux 容器能載入 `better-sqlite3` 原生模組。依據：完整 Linux 環境與 amd64 要求。信心：低到中。但部署時 Docker 必須在本機執行（`wrangler deploy` 建置並推送映像）。[S15]
- 縮到零：`Container` 類別 `sleepAfter` 預設 10 分鐘，可改。關閉時先 SIGTERM，最多等 15 分鐘再 SIGKILL。官方說冷啟動約 1 到 3 秒（依映像與進入點而定）。Next.js 啟動時間未查到。[S13]
- 地區：由 Cloudflare 依就近與可用性自動選，沒有使用者可設的區域參數。是否有台灣節點：未查到。[S14]
- 上限：總 vCPU 1,500、記憶體 6 TiB、磁碟 30 TB（帳號層）；映像總儲存 50 GB 每帳號；映像大小不得超過實例磁碟。[S12]
- 固定出口 IP：Containers 文件未查到。搜尋只找到 Gateway 專屬出口 IP 與 BYOIP，二者皆為 Enterprise 且針對 Zero Trust 與 CDN，不是 Containers。信心：中。[S16]

## 4. D1

- 非同步 API，查詢經 binding 或 REST。與同步的 `better-sqlite3` 差距：所有呼叫必須 `await`，交易靠 `db.batch()`，沒有互動式 BEGIN 到 COMMIT 的同步程式碼寫法。每個資料庫單執行緒，一次一個查詢。信心：高（單執行緒與 batch）；交易語意細節未查到。[S17]
- 大小：單庫 10 GB（Paid，不可再提高），Free 500 MB。每筆 row 或 BLOB 上限 2 MB。每次 Worker 呼叫最多 1,000 次查詢（Paid）、50（Free）。[S17]
- 價格（Paid）：讀取前 250 億列每月含，之後 $0.001 / 百萬列；寫入前 5,000 萬列含，之後 $1.00 / 百萬列；儲存前 5 GB 含，之後 $0.75 / GB-月。D1 不收出口流量費。Free：5 GB 總儲存，每日 500 萬讀、10 萬寫。[S18]
- Durable Objects SQLite 可行性：SQLite 後端的 DO 免費方案也能用（每日 10 萬請求），單物件容量上限未查到；每個 DO 是獨立實例，不適合多租戶跨表查詢。信心：低到中。[S19]

## 5. Hyperdrive 接 PostgreSQL

- 價格：沒有獨立單價。連線池與查詢快取在 Free 與 Paid 都含。Free 每日 100,000 次查詢；Paid 不限查詢。不收出口流量費。信心：高。[S20]
- 限制：Free 10 組設定、約 20 條源庫連線；Paid 25 組設定、約 100 條。單一陳述最長 60 秒。[S21]
- 模式：transaction pooling。官方明說：明確 `BEGIN` 到 `COMMIT` 內的 `SET` 有效；連線歸還時重置，`SET` 不跨查詢保留。不要為了保留 `SET` 狀態把多個操作包成一個長交易。信心：高。[S22]
- `SET LOCAL`：該頁未提。推論：`SET LOCAL` 只在當前交易內有效，行為與 transaction pooling 一致，所以「每筆交易內 `SET LOCAL app.org_id`」可行。依據：上一條的 `BEGIN`/`COMMIT` 內 `SET` 有效，以及連線歸還重置。信心：低，需實測。
- RLS：該頁與連線設定頁都沒有提到 RLS 或 session 變數，也未查到「會讓 RLS 失效的已知限制」。風險推論：若任何一個查詢漏掉 `SET LOCAL`，連線可能帶著上一個租戶的設定嗎？答案：官方說歸還時重置，所以不會殘留，但需用整合測試驗證。信心：低。[S22][S23]
- Session 級 advisory lock 不支援，交易級支援。Postgres.js 不要用 `prepare: false`。[S22][S23]
- 前提：Hyperdrive 只能從 Workers 使用，Containers 內的程式要走一般 TCP。推論，依據：文件說明用 Workers TCP socket。

## 6. R2

- Standard：$0.015 / GB-月；Class A $4.50 / 百萬；Class B $0.36 / 百萬。Infrequent Access：$0.01 / GB-月，30 天最短保存，取回 $0.01 / GB。信心：高。[S24]
- 每月免費（Standard）：10 GB-月、100 萬次 Class A、1,000 萬次 Class B。出口到網際網路免費。[S24]
- 地區：位置提示（best effort，只在建立時有效）有 `wnam`、`enam`、`weur`、`eeur`、`apac`、`oc`。保證性 jurisdiction 只有 `eu`、`fedramp`、`us`。沒有台灣專屬選項，`apac` 是最近選項，且不保證。信心：高。[S25]

## 7. 月費、資料落地、Access、網域

- Workers Paid：$5 每月。含 1,000 萬請求與 3,000 萬 CPU ms；超出 $0.30 / 百萬請求、$0.02 / 百萬 CPU ms。Free：每日 10 萬請求，每請求 10 ms CPU。[S26]
- 資料落地：Workers 與 Containers 由 Cloudflare 自動就近放置，沒有查到可指定台灣的選項。R2 `apac` 不保證。個資落地台灣目前未查到可保證的做法。信心：高（缺漏本身）。
- Cloudflare Access 免費版：Zero Trust Free 上限 50 位使用者，$0，含 ZTNA。付費 $7 每使用者每月。信心：高（官方 plans 頁的 markdown 版）。[S27]
- 在 demo 前加登入並放行 webhook：Access 支援對 `workers.dev` 的正式與預覽 URL 要求驗證。放行 webhook 路徑要用 Access 的 Bypass 或 Service Auth 策略，這點官方頁這次未讀到，標「推論」，需在設定時確認。信心：低。[S28]
- `*.workers.dev`：免費，可直接用。官方稱它適合「個人或興趣專案，非關鍵業務」，建議正式用自訂網域。重要限制：`workers.dev` 無法關閉 Browser Integrity Check，部分預設函式庫的 User-Agent（如 Python urllib）會在到達 Worker 前收到 error 1010，且不會出現在 Worker 日誌。點點簽 webhook 的 User-Agent 未查到，若被擋，單日 10 次失敗會停掉整個 application 的 webhook。建議改用自訂網域並建立跳過 BIC 的規則。信心：高（BIC 事實）；是否影響點點簽為未查到。[S28]

## 費用情境

共同假設：美元，每月。Workers Paid $5 基本費。容器用 standard-1（1/2 vCPU，4 GiB，8 GB），因為 4.3 MB PDF 加 5.8 MB base64 加 Next.js 在 1 GiB 內是否夠用未量測（推論）。請求 CPU 取 300 ms 全程滿載（上限估計）。容器出口流量走台灣價 $0.05 / GB。1 月以 30 天計；整月 730 小時 = 2,628,000 秒。Access 免費版 $0。

### A. demo（容器路徑，SQLite 在容器內）

| 計費項 | 算式 | 金額 |
|---|---|---|
| Workers Paid | 基本費；2,000 請求遠低於 1,000 萬 | 5.000 |
| 記憶體 | 4 GiB × 108,000 s（30 h）= 432,000 GiB-s；扣含量 90,000；342,000 × 0.0000025 | 0.855 |
| 磁碟 | 8 GB × 108,000 = 864,000 GB-s；扣含量 720,000；144,000 × 0.00000007 | 0.010 |
| CPU | 2,000 × 0.3 s × 0.5 vCPU = 300 vCPU-s，低於含量 22,500 | 0 |
| R2 | 1 GB 低於 10 GB 免費 | 0 |
| 出口 | 2 GB 低於 500 GB | 0 |
| 合計 | | 約 5.87 |

注意：SQLite 在暫存磁碟，休眠即遺失，demo 資料需備份到 R2。

### B. pilot 300 單位（容器路徑）

活動時間 12 h × 22 d = 264 h = 950,400 s。

| 計費項 | 算式 | 金額 |
|---|---|---|
| Workers Paid | 300,000 請求遠低於 1,000 萬 | 5.000 |
| 記憶體 | 4 × 950,400 = 3,801,600；扣 90,000；3,711,600 × 0.0000025 | 9.279 |
| 磁碟 | 8 × 950,400 = 7,603,200；扣 720,000；6,883,200 × 0.00000007 | 0.482 |
| CPU | 300,000 × 0.3 s × 0.5 = 45,000 vCPU-s；扣 22,500；22,500 × 0.00002 | 0.450 |
| R2 | 檔案 13 GB 加 DB 備份 5 GB = 18 GB；扣 10；8 × 0.015 | 0.120 |
| 出口 | 30 GB 低於 500 GB | 0 |
| 合計 | | 約 15.33 |

備註：5 GB 資料庫放在 8 GB 暫存磁碟，空間緊。改 standard-2（1 vCPU，6 GiB，12 GB）時：記憶體 14.031、磁碟 0.748、CPU 1.350、其餘不變，合計約 21.25（推論式，同一算法）。

### C. Phase 1 結束（Workers 加 Hyperdrive 加 R2，加常駐 worker 容器）

前提：資料庫已遷到 PostgreSQL（資料庫本身費用不在 Cloudflare，未計，需另案調研）。App 跑 Workers。常駐背景 worker 用 basic 容器（1/4 vCPU，1 GiB，4 GB）24 小時運行，CPU 平均使用率取 10%（假設）。

| 計費項 | 算式 | 金額 |
|---|---|---|
| Workers Paid | 基本費；1,000,000 請求低於 1,000 萬 | 5.000 |
| Workers CPU | 假設每請求 20 ms（推論，無實測）= 2,000 萬 ms，低於含量 3,000 萬 | 0 |
| Hyperdrive | 無獨立費用 | 0 |
| 容器記憶體 | 1 × 2,628,000 = 2,628,000；扣 90,000；2,538,000 × 0.0000025 | 6.345 |
| 容器磁碟 | 4 × 2,628,000 = 10,512,000；扣 720,000；9,792,000 × 0.00000007 | 0.685 |
| 容器 CPU | 0.25 × 10% × 2,628,000 = 65,700 vCPU-s；扣 22,500；43,200 × 0.00002 | 0.864 |
| R2 | 檔案 30 GB；扣 10；20 × 0.015 | 0.300 |
| 出口 | 100 GB 低於含量，R2 出口免費 | 0 |
| 合計（Cloudflare 端） | | 約 13.19 |

C 未計：PostgreSQL 主機與 RPO 5 分鐘還原（PITR）、固定出口 IP（Containers 與 Workers 皆未查到方案）。

## 來源

[S1] https://opennext.js.org/cloudflare （2026-11-07）
[S2] https://github.com/opennextjs/opennextjs-cloudflare/releases （2026-11-07）
[S3] https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/ （2026-11-07）
[S4] https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/ （2026-11-07）
[S5] https://developers.cloudflare.com/workers/platform/limits/ （2026-11-07）
[S6] https://developers.cloudflare.com/workers/runtime-apis/nodejs/ （2026-11-07）
[S7] https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/ （2026-11-07）
[S8] https://developers.cloudflare.com/workers/platform/limits/#static-assets （2026-11-07）
[S9] https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ （2026-11-07）
[S10] https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/ （2026-11-07）
[S11] https://developers.cloudflare.com/containers/pricing/ （2026-11-07）
[S12] https://developers.cloudflare.com/containers/platform-details/limits/ （2026-11-07）
[S13] https://developers.cloudflare.com/containers/platform-details/ （2026-11-07）
[S14] https://developers.cloudflare.com/containers/faq/ （2026-11-07）
[S15] https://developers.cloudflare.com/containers/get-started/ （2026-11-07）
[S16] https://developers.cloudflare.com/cloudflare-one/traffic-policies/egress-policies/dedicated-egress-ips/ （搜尋結果摘要，2026-11-07）
[S17] https://developers.cloudflare.com/d1/platform/limits/ （2026-11-07）
[S18] https://developers.cloudflare.com/d1/platform/pricing/ （2026-11-07）
[S19] https://developers.cloudflare.com/durable-objects/platform/pricing/ （2026-11-07）
[S20] https://developers.cloudflare.com/hyperdrive/platform/pricing/ （2026-11-07）
[S21] https://developers.cloudflare.com/hyperdrive/platform/limits/ （2026-11-07）
[S22] https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/ （2026-11-07）
[S23] https://developers.cloudflare.com/hyperdrive/configuration/connect-to-postgres/ （2026-11-07）
[S24] https://developers.cloudflare.com/r2/pricing/ （2026-11-07）
[S25] https://developers.cloudflare.com/r2/reference/data-location/ （2026-11-07）
[S26] https://developers.cloudflare.com/workers/platform/pricing/ （2026-11-07）
[S27] https://www.cloudflare.com/plans/sase-zero-trust.md （2026-11-07）
[S28] https://developers.cloudflare.com/workers/configuration/routing/workers-dev/ （2026-11-07）

## 限制說明

頁面內容經抓取工具的摘要模型轉述，非逐字原文。S2、S16 信心較低。D1 交易語意、DO SQLite 單物件上限、Containers 台灣節點、Next.js 在容器的啟動時間、點點簽 webhook User-Agent、pdf-lib 實測記憶體，皆為「未查到」。
