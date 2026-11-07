# 部署平台評估：Cloudflare 與 GCP

查詢與實測日期：2026-11-07。狀態：已定案，見 [ADR-0011](../adr/0011-cloud-run-with-litestream-for-demo.md)。費用的稽核結果見 [hosting/audit.md](hosting/audit.md)。

## 1. 結論與建議

**建議用 GCP Cloud Run（asia-east1）。demo 環境約 US$0.4（NT$12）每月。** 資料庫維持 SQLite，用 Litestream 複寫到 Cloud Storage。

選 GCP 的原因有 4 個：

1. Cloud Run 不改資料層就能跑現有 Docker 映像。Workers 不能載入 `better-sqlite3`，也沒有持久檔案系統。
2. demo 情境的費用最低：US$0.36，Cloudflare Containers 是 US$5.87。
3. 只有 GCP 能把資料放在台灣（asia-east1）。Cloudflare 無法指定容器地區，R2 只有不保證的 `apac` 提示。
4. 情境 C 需要固定出口 IP 給商工 API。GCP 有 Cloud NAT，Cloudflare 的 Containers 與 Workers 都未查到方案。

這個方案有 3 個已知代價：

- **換版會遺失資料：** 換版時新舊實例短暫並存，並存期間寫入舊實例的資料會遺失。demo 接受這個代價，pilot 不得沿用（見第 6 節）。
- **冷啟動風險：** `min-instances=0` 會冷啟動。點點簽 webhook 的等待秒數未知，因此有投遞失敗的風險。demo 當天用 service 層級的 `--min=1` 保持開機，每天約 US$1.73。
- **費用只是下限：** 這是一人間歇使用的費用。如果每月活動超過 66.7 小時，就開始收 vCPU 費用，每小時約 US$0.065。

pilot 不沿用這個方案。必須先完成架構 v2 M1 到 M2 的 PostgreSQL 遷移，再進 pilot。

## 2. 硬限制對照表

「實測」的環境是本機 macOS arm64、Node v26.5.0，沒有在 Linux 容器內執行，因為本機 Docker daemon 沒有啟動。Linux 容器內的行為必須在第一次部署時確認。

| 硬限制 | 現況與實測 | Cloud Run | Workers 加 OpenNext | Cloudflare Containers |
|---|---|---|---|---|
| 原生模組 `better-sqlite3` | 13.0.1，同步 API，內附 linux prebuild。standalone 追蹤會帶入 `.node`（實測） | 能用。映像必須在 Linux 建置 | 不能用（文件未提原生 addon，`node:sqlite` 是 stub。推論） | 能用（推論，未實測） |
| SQLite 持久化 | `data/rent-poc.db`，WAL | 容器檔案系統在實例停止時消失。必須用 Litestream 複寫。GCS FUSE 與 NFS 不支援鎖定，不得跑 SQLite | 不適用。`/tmp` 每個請求獨立 | 磁碟預設暫存，休眠後消失。必須自行複寫到 R2 |
| 已簽 PDF 的檔案寫入 | `data/contract-files/`。檔案不存在時，`serveContractFile` 會向點點簽補抓，mock 模式會重新產生 | 能寫。重啟後消失，下載時補抓 | 不能持久 | 能寫。休眠後消失，下載時補抓 |
| 字型與 PDF 記憶體 | 字型 7.09 MB。單份 PDF 4.34 MB，約 0.43 秒，CPU 約 550 ms。server 閒置 RSS 121 MB，做完 6 份（其中 5 份並行）後 224 MB（實測） | 1 GiB 足夠 | 128 MB 上限不夠安全。單份 PDF 的 RSS 增量約 74 MB，並行時更高。Free 方案 10 ms CPU 不夠 | basic（1 GiB）足夠（推論） |
| webhook 公開 URL | 空 body ping 必須回 200。單日 10 次投遞失敗會暫停 application 的 webhook | `*.run.app` 是穩定 HTTPS 網址。冷啟動是風險 | `*.workers.dev` 無法關閉 Browser Integrity Check，可能擋 webhook | 同左，建議用自訂網域 |
| Next.js 16 runtime | 16.2.11，Node.js runtime。standalone 58 MB（實測） | 官方文件確認 Docker 支援全部功能 | OpenNext 1.20.16 要求 16.4.5 以上，必須升版。Node Middleware 未支援 | 同 Cloud Run（推論） |
| 系統沒有登入（任務清單外新增） | 公開網址會露出合約內容與簽署連結 | 直連 IAP 無法放行單一路徑，會擋 webhook。必須用應用層 Basic Auth，或加 US$18 的 Load Balancer | Access 免費 50 人，webhook 路徑用 Bypass | 同左 |
| `request.url` 的 origin（任務清單外新增） | `sign-link/route.ts:21` 在 standalone 下得到 `https://0.0.0.0:<port>`（實測）。簽署完成導回網址會錯 | 必須修 | OpenNext 下未實測 | 必須修 |
| 固定出口 IP（情境 C） | 商工 API 有 IP 白名單 | Cloud NAT，約 US$5.92（Cloud Run 實例的計費換算未查到） | 未查到 | 未查到 |
| 資料落地 | 含個資。個資法第 21 條未見不動產業的限制公告，須法務確認 | asia-east1（台灣） | 自動就近，不能指定 | 自動就近，不能指定 |

## 3. 架構

### 3.1 GCP：Cloud Run（建議）

遷移 PostgreSQL 前（demo）：

```
GitHub Actions ──WIF──► Artifact Registry ──► Cloud Run service `rent-poc-demo`
                                               asia-east1，gen2，1 vCPU，1 GiB
使用者 ──HTTPS，Basic Auth──────────────────►  instance-based，min=0，max=1
點點簽 ──HTTPS，HMAC 驗簽，不經 Basic Auth──►  │
                                               ├─ Next.js standalone
                                               │    data/rent-poc.db（容器內，重啟消失）
                                               │    data/contract-files/（重啟消失，下載時補抓）
                                               └─ Litestream ──每秒──► Cloud Storage（asia-east1）
Secret Manager ──環境變數──► Cloud Run
```

遷移 PostgreSQL 後（pilot 起）：

```
使用者、點點簽 ──HTTPS──► Cloud Run web（request-based，min=1）
                           ├─► Cloud SQL 或 Neon（ADR-0010 決定）
                           └─► Cloud Storage（已簽 PDF、Audit Trail File）
Cloud Run worker pool ──► 同一個 PostgreSQL
                      └─► Cloud NAT 固定 IP ──► 商工 API
```

### 3.2 Cloudflare

遷移 PostgreSQL 前，只能用 Containers：

```
GitHub Actions ──API token──► wrangler deploy（Docker 建置映像）
使用者 ──Access──► Worker ──► Durable Object ──► Container（standard-1，地區自動）
點點簽 ──Bypass──►                               ├─ Next.js standalone
                                                 │    SQLite（暫存，休眠消失）
                                                 └─ Litestream ──► R2（apac 提示，不保證）
```

遷移 PostgreSQL 後：

```
使用者、點點簽 ──► Worker（OpenNext，Next.js 16.4.5 以上）
                   ├─► Hyperdrive（關閉查詢快取）──► Neon 或 Supabase
                   └─► R2
背景 worker 容器 ──► 無固定出口 IP（未查到方案）
```

## 4. 費用

**匯率假設：** US$1 = NT$33。依據是 2026-11-07 的中間價 32.84（<https://open.er-api.com/v6/latest/USD>），再無條件進位。不含信用卡海外手續費。

**計算基準：** 每月 730 小時。A、B、C 的定義見各調研檔案。走 PostgreSQL 的列都需要先完成 M1 非同步化，遷移工時不計入費用。

| 情境 | 假設 |
|---|---|
| A，demo | 2,000 次請求，活動 30 小時，檔案 1 GB，資料庫 1 GB 以下，egress 2 GB |
| B，pilot 300 租賃單位 | 300,000 次請求，資料庫 5 GB，檔案 13 GB，egress 30 GB，上班 12 小時 × 22 天 |
| C，Phase 1 結束 | 1,000,000 次請求，資料庫 10 GB，檔案 30 GB，egress 100 GB，常駐 worker，固定出口 IP，PITR |

C 的流量是本評估的保守假設。BRD 的 G1（第 9 月）目標同樣是 300 租賃單位。

下表每格為美元與新臺幣，每月。數字取自稽核修正後的同基準總表（[audit.md 第 3 節](hosting/audit.md)）。

| 方案 | A | B | C | 符合 C |
|---|---|---|---|---|
| **Cloud Run + SQLite + Litestream** | **0.36 / 12** | 19.03 / 628（上班時段）<br>53.09 / 1,752（全天） | 不適用 | 否 |
| Cloud Run + Cloud SQL | 不適用 | 44.86 / 1,480 | 114.94 / 3,793 至 270.70 / 8,933 | 是。只有 HA 版有 SLA |
| Cloud Run + Neon | 1.46 / 48 | 25.99 / 858 至 46.97 / 1,550 | 85.34 / 2,816 至 143.38 / 4,732 | 是。跨雲到新加坡 |
| Cloud Run + Supabase | 25.31 / 835 | 42.04 / 1,387 至 47.04 / 1,552 | 187.35 / 6,183 至 192.35 / 6,348 | 是。跨雲到東京 |
| Compute Engine 自管 | 20.15 / 665 | 26.31 / 868 | 85.19 / 2,811 | 是。單機無 SLA，PITR 自建 |
| Cloudflare Containers + SQLite | 5.87 / 194 | 15.33 / 506（264 小時）<br>33.05 / 1,091（全天） | 不適用 | 否 |
| Cloudflare Workers + Hyperdrive + Neon | 未估 | 未估 | 36.44 / 1,203 至 94.47 / 3,118 | 否。無固定出口 IP |

建議方案的 A 明細如下：

| 計費項 | 算式 | 美元 |
|---|---|---|
| vCPU | 108,000 秒，低於 instance-based 免費額度 240,000 | 0 |
| 記憶體 | 108,000 GiB-秒，低於免費額度 450,000 | 0 |
| ephemeral disk | 2 GiB × 30 小時 × 0.000109589（本方案不使用，保留為上限） | 0.01 |
| Cloud Storage | 3 GB × 0.02 | 0.06 |
| egress | 2 GB × 0.12 | 0.24 |
| Artifact Registry | (1 − 0.5) GiB × 0.10 | 0.05 |
| Secret Manager | 5 個版本，低於免費 6 個 | 0 |
| 合計 | | 0.36 |

敏感度：

- 活動 100 小時：(360,000 − 240,000) × 0.000018 = 多 US$2.16。
- demo 當天保持開機：86,400 秒 ×（0.000018 + 0.000002）= US$1.73 每天，先扣免費額度。
- 整月 `min-instances=1`：US$47.85。
- GCP 新帳號有 US$300 試用額度，效期 90 天。
- CI：repo 是 public，GitHub Actions 標準 runner 免費。如果轉 private，估計每月 US$1.7，低於 Free 方案的 US$12 額度。
- Litestream 的 Cloud Storage 操作費：持續寫入時每月最多約 259 萬次，約 US$13。demo 寫入稀疏，低於 US$0.1（推論）。

## 5. 遷移 PostgreSQL 前後的差異

| 項目 | 遷移前（demo） | 遷移後（pilot 起） |
|---|---|---|
| Cloud Run 計費模式 | instance-based。Litestream 在請求之間需要 CPU | request-based |
| 實例數 | `max-instances=1` | 能水平擴展 |
| 換版資料遺失 | 有。並存期間寫入舊實例的資料會遺失 | 無 |
| PDF 儲存 | 容器內。重啟後向點點簽補抓 | Cloud Storage，`rel_path` 改存物件 key |
| PR preview | 不做。每個 revision 都是獨立的 SQLite 寫入端 | 能用 `--tag` 與 `--no-traffic` |
| 需移除的元件 | | Litestream、entrypoint wrapper、Basic Auth（換成正式登入） |
| CI/CD | 檢查、建置映像、部署 | 相同，另加 migration 步驟與 RLS 滲透測試 |
| 平台選擇是否要改 | | 不用改。Cloud Run 與資料庫選擇互相獨立 |

ADR-0010 必須決定 Cloud SQL 或 Neon。兩者的決策依據：

- Cloud SQL 的資料在台灣，費用較高。shared core 沒有 SLA。
- Neon 的費用較低，但最近區域是新加坡。跨雲延遲未實測，Cloud NAT 會加收 US$0.045 /GiB。
- 資料放境外是否可行，須法務確認。
- 兩家都要實測 pooler 下的 `SET LOCAL`。Neon 要用 SQL 建立沒有 BYPASSRLS 的角色。Hyperdrive 查詢快取預設開啟，走 Hyperdrive 時必須關閉。

## 6. 風險

| 風險 | 影響 | 對策 | 狀態 |
|---|---|---|---|
| 換版時新舊實例並存（`max-instances` 能短暫超過）。官方行為推論，未實測 | 並存期間寫入舊實例的合約狀態遺失 | 每次實例啟動都複寫到新路徑，避免損毀複寫資料。demo 接受遺失。部署時不做 demo | demo 接受，pilot 不得沿用 |
| 實例閒置最多 15 分鐘後關閉，崩潰時最多遺失約 1 秒資料 | SIGTERM 有 10 秒能同步。崩潰時遺失最後一次同步之後的寫入 | demo 接受 | demo 接受 |
| 冷啟動與 webhook。點點簽的等待秒數未查到 | 冷啟動逾時算投遞失敗，會重試 3 次。單日 10 次失敗會暫停 webhook | 第一次部署後實測冷啟動秒數。demo 當天用 `--min=1` 保持開機。demo 用獨立的 Application，隔離影響 | 須實測 |
| Basic Auth 強度低 | 密碼外洩就能看到全部資料 | 不得輸入真實個資。密碼放 Secret Manager。sandbox 的已簽 PDF 有浮水印 | 接受 |
| 簽署完成導回網址會跳出 Basic Auth 對話框 | 承租人簽完後看到登入視窗 | 用 sandbox 測試帳號 demo。pilot 前換正式登入 | 接受 |
| Litestream 在 Cloud Run 容器內只有社群範例 | 還原失敗時 demo 資料清空 | 還原失敗時用空資料庫啟動並記錄錯誤 | 須實測 |
| 預算失控 | 一般預算只發警示。spend cap 生效不是即時，超額照收 | 設 US$5 預算警示，`max-instances=1` 限制費用上限 | 使用者設定 |
| Compute Engine 價格只有第三方來源 | 只影響對照組 | 不選此方案就不用核對 | 不影響建議 |
| Cloud Run 免費額度能否跨 service 與 worker pool 疊加未確認 | C 最多增加 US$5.07 | C 前再核對 | 低 |

## 7. 定案與取捨

使用者已定案（2026-11-07），4 項都照建議：

1. **平台：** Cloud Run 加 Litestream。
2. **點點簽 Application：** 另建一個 sandbox Application 給 demo。原 Application 的 webhook 維持 ngrok，本機開發不受影響。兩邊的金鑰與失敗計數互相獨立。
3. **存取保護：** `src/proxy.ts` 做 Basic Auth，放行 `/api/webhooks/dottedsign` 與 `/api/health`。
4. **資料遺失：** 接受換版時遺失最多數十秒的寫入。demo 資料一律用測試資料。

### SQLite 持久化的取捨

| 資料 | 做法 | 代價 |
|---|---|---|
| SQLite | 放在容器內，Litestream 每秒複寫到 Cloud Storage。每次啟動都寫到新路徑，新路徑確定能還原後才移動 `CURRENT` | 換版時並存期間的寫入遺失。崩潰時遺失最後一次同步之後的寫入 |
| 已簽 PDF 與 Audit Trail File | 留在容器內，重啟後消失。下載時由 `serveContractFile` 向點點簽補抓 | 重啟後第一次下載較慢 |

本方案不使用 ephemeral disk。demo 資料庫小於 1 MB，容器內檔案系統就夠用，也少一項費用。如果第一次部署發現 WAL 在這個檔案系統上有問題，再加 ephemeral disk。

### 實作時改了什麼

相對於第 2 節的硬限制，實作時的決定如下：

- 映像用 `node:26-slim`，與本機開發同版。稽核查到 better-sqlite3 13.0.1 的 arm64 prebuild 需要 `GLIBC_2.38`，bookworm 不夠。Node 26 預設 trixie，兩個架構都能載入（glibc 版本是依文件推論，未實測）。
- 字型與 `DESIGN.md` 不需要 `outputFileTracingIncludes`，實測 standalone 已帶入。`linux-x64.node` 明確帶入，因為 macOS 建置只追蹤到 `darwin-arm64.node`，Linux 上無法在本機驗證。
- 映像用 `npm ci --ignore-scripts`。better-sqlite3 有 `binding.gyp`，npm 會隱含執行 node-gyp，slim 映像沒有 Python 會失敗。
- `src/` 以外的改動：`eslint.config.mjs` 忽略 `.claude/**` 與 `public/pdf.worker.min.mjs`，並把 3 個 UI 檔案的 5 個既有錯誤降為 warning。否則 CI 的 ESLint 永遠失敗。

### 驗證狀態

| 項目 | 狀態 |
|---|---|
| vitest、tsc、ESLint | 本機通過 |
| Basic Auth、webhook 放行、PDF 產出（standalone） | 本機實測通過 |
| entrypoint 流程：`CURRENT` 移動、SIGTERM 順序、重啟還原 | 本機用 stub Litestream 實測通過 |
| Dockerfile、真正的 Litestream、Linux 上的原生模組 | 未實測。本機 Docker daemon 沒有啟動。`image` job 第一次執行時會驗證 |
| GCP 設定、Cloud Run 上的冷啟動與 WAL | 未實測。需要使用者完成 `deploy/first-deploy-wizard.sh` |

## 8. 調研附件與來源

調研全文：

- [hosting/01-cloudflare.md](hosting/01-cloudflare.md)
- [hosting/02-gcp.md](hosting/02-gcp.md)
- [hosting/03-managed-postgres.md](hosting/03-managed-postgres.md)
- [hosting/04-cicd.md](hosting/04-cicd.md)
- [hosting/audit.md](hosting/audit.md)（讀 01 到 04 時，衝突處以此檔為準）

主要費用來源，查詢日期皆為 2026-11-07：

- Cloud Run：<https://cloud.google.com/run/pricing>、<https://docs.cloud.google.com/run/docs/configuring/billing-settings>、<https://docs.cloud.google.com/run/docs/about-instance-autoscaling>
- Cloud SQL：<https://cloud.google.com/sql/pricing>
- Cloud Storage：<https://cloud.google.com/storage/pricing>
- 網路與 Cloud NAT：<https://cloud.google.com/vpc/network-pricing>、<https://cloud.google.com/nat/pricing>
- Artifact Registry：<https://cloud.google.com/artifact-registry/pricing>
- Secret Manager：<https://cloud.google.com/secret-manager/pricing>
- Cloudflare：<https://developers.cloudflare.com/containers/pricing/>、<https://developers.cloudflare.com/workers/platform/pricing/>、<https://developers.cloudflare.com/r2/pricing/>、<https://developers.cloudflare.com/hyperdrive/platform/pricing/>
- Neon：<https://neon.com/pricing>
- Supabase：<https://supabase.com/pricing>
- GitHub Actions：<https://docs.github.com/en/billing/reference/actions-runner-pricing>
- Compute Engine（第三方，信心低）：<https://gcloud-compute.com/e2-small.html>

上線前必須用 Pricing Calculator 核對一次 GCP 費用。Google 定價頁預設顯示 Iowa 價格，Taiwan 價格取自頁面內嵌資料。

## 9. ADR

定稿見 [ADR-0011](../adr/0011-cloud-run-with-litestream-for-demo.md)。編號與架構文件第 8 節的候選 ADR-0011 不同，ADR 內有註明。
