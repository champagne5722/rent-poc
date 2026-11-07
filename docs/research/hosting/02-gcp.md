# 調研 02：GCP（Cloud Run asia-east1）部署 rent-poc

查詢日期：2026-11-07。幣別：美元。信心標記：高 = 官方頁面，中 = 官方頁面內嵌資料解析或第三方，低 = 推論。

## 結論

1. asia-east1（台灣）屬 Cloud Run 的 Tier 1 區域，與 us-central1 同價，免費額度可直接用（高）。
2. Cloud Run 上跑 SQLite 的可行做法只有一種：`max-instances=1`，資料庫放第 2 代執行環境的臨時磁碟（ephemeral disk），用 Litestream 備份到 Cloud Storage，啟動時還原。GCS FUSE 與 NFS 的官方文件都說不支援檔案鎖，不可跑 SQLite。
3. 月費（同一組假設）：demo `min-instances=0` 約 $0.36，`min-instances=1` 約 $13；pilot 約 $18（SQLite）或 $44（Cloud SQL `db-g1-small`，無 SLA）；Phase 1 結束約 $114 到 $269，主要差在 Cloud SQL 規格與 HA。
4. Cloud Run 直連 IAP 已 GA 且不收費，但整個 service 一起擋，文件沒有放行單一路徑的設定，點點簽 webhook 會被擋。要放行 webhook 必須拆兩個 service、加 Load Balancer，或改成應用層驗證。
5. Compute Engine 小型 VM（e2-small，約 $20 到 $25 加 pilot 起）最便宜也最單純，但 asia-east1 沒有免費 e2-micro，且備份、更新、監控都要自管。

## 各問題的答案

### 1. Cloud Run 定價（asia-east1）

- 定價層級：asia-east1 列在 Tier 1。Tier 2 包含 Hong Kong、Seoul、Singapore、Jakarta 等。來源 [S1]（高）。
- 免費額度套用 Tier 1 價格，以帳單帳戶彙總（高）[S1]。

| 項目 | request-based（預設） | instance-based | 來源 |
|---|---|---|---|
| vCPU | 使用中 $0.000024 /vCPU-秒；min instance 閒置 $0.0000025 | $0.000018 /vCPU-秒 | S1 |
| 記憶體 | 使用中 $0.0000025 /GiB-秒；閒置 $0.0000025 | $0.000002 /GiB-秒 | S1 |
| 請求 | $0.40 /百萬次 | 無請求費 | S1 |
| 免費額度 / 月 | 180,000 vCPU-秒、360,000 GiB-秒、200 萬次請求 | 240,000 vCPU-秒、450,000 GiB-秒 | S1 |
| Worker pool | $0.000011244 /vCPU-秒、$0.000001235 /GiB-秒；免費 384,204 vCPU-秒、728,744 GiB-秒 | 同左（獨立 SKU） | S1 |

以上全部為高信心。

- request-based 與 instance-based 的差異 [S2]（高）：
  - request-based 只在處理請求、啟動、關閉時計費，CPU 只在請求期間配置。
  - instance-based 從容器啟動到結束全程計費，CPU 全程配置，最少 512 MiB 記憶體。
  - 官方建議：流量零星、突發用 request-based；流量穩定用 instance-based。
- CPU throttling 對 route handler 的影響（推論，依據 S2）：
  - 請求處理期間 CPU 完整配置，route handler 本身不受影響。
  - 回應送出後的背景工作（沒有 `await` 的 Promise、Litestream 同步）在 request-based 下會被降速。
  - 點點簽 `completed` 事件目前在 request 內 `await` 下載 PDF，這個寫法在 request-based 下是安全的。若改成「先回 200 再背景下載」，必須改用 instance-based。
- `min-instances=0` 冷啟動：官方只說首次請求回應時間會增加，取決於容器多快就緒（高）[S3]。官方沒給數字，Next.js 加 better-sqlite3 的冷啟動秒數未查到。推論約數秒（低），若再加 Litestream 還原，時間隨資料庫大小增加。
- `min-instances=1` 月費（730 小時 = 2,628,000 秒，1 vCPU、1 GiB，request-based）：
  - 閒置 = 2,628,000 秒 ×（$0.0000025 + $0.0000025）≈ $13.14，扣掉實際使用時間後見情境表。
  - 若改 instance-based：2,628,000 ×（$0.000018 + $0.000002）= $52.56，扣免費額度 $5.22 = $47.34。
- 規格建議：1 vCPU、1 GiB（低，推論）。依據：PDF 產生會載入 7.09 MB 字型，Next.js 加 SQLite 頁快取，512 MiB 餘裕小。每 GiB 差距在 min=1 下每月約 $6.57。Cloud Run 對 1 vCPU 的記憶體上限是 4 GiB，小於 1 vCPU 時 512 MiB 以上需 0.5 vCPU 以上 [S4]（高）。

### 2. Cloud Run 上 SQLite 的持久化

見下方比較表。重點事實：

- 容器檔案系統是記憶體檔案系統，寫入會吃實例記憶體，實例停止後資料消失，且無法限制大小（高）[S5]。DB 放這裡等於 DB 大小加進記憶體用量。
- 專用 in-memory volume 可設大小上限，一樣占用容器記憶體（高）[S6]。
- ephemeral disk：ext4，1 到 100 GiB 每個 volume，每實例預設上限 10 GiB，實例停止即刪除（含當機、縮容、換版），僅第 2 代執行環境，支援所有 Cloud Run 區域（高）[S7]。價格 $0.000109589 /GiB-小時（≈ $0.08 /GiB-月），依佈建大小與實例存活時間計費 [S1][S7]（中：價格表標題需人工對應）。發布階段（GA 或 Preview）在該文件頁未標示，未查到。
- GCS FUSE 官方限制 [S8]（高）：
  - 「不支援檔案鎖定與檔案 patch」。
  - 「延遲遠高於本機檔案系統，不應作為資料庫的後端」。
  - 只能整個物件重寫。
  - 多寫入端同時寫同一檔案：Cloud Run 文件說 last write wins，先前的寫入遺失 [S9]。
- NFS 掛載：Cloud Run 不支援 NFS 鎖定，自動以 no-lock 模式掛載；需要 VPC 網路 [S10]（高）。
- Litestream：最新版 v0.5.18（2026-11-03 發布）[S11][S12]（高）。
  - 預設每秒複寫到 replica，崩潰時最多損失這段未複寫的資料；收到終止訊號會先同步完才結束 [S13]（高）。
  - 多個程序複寫到同一個 bucket 路徑可能造成無法還原 [S13]（高）。
  - 官方文件沒有 Cloud Run 專屬指南，只有 GCS 指南 [S14]；Cloud Run 範例僅社群專案（低）。
  - Cloud Run 實例收到 SIGTERM 後有 10 秒清理時間 [S7]（高）。
- 風險（推論，依據 S13 與 Cloud Run 換版行為）：Cloud Run 換版時新舊 revision 可能短暫並存，造成兩個程序複寫到同一路徑。需用手動縮放或部署流程（先停舊版）避免。

### 3. Cloud SQL for PostgreSQL（asia-east1）

下列 asia-east1 價格取自官方定價頁的內嵌區域資料（頁面預設只顯示 Iowa，Taiwan 需解析頁面內嵌 JSON），信心中。請在 Pricing Calculator 再核對一次。

| 項目 | 價格 | 信心 |
|---|---|---|
| `db-f1-micro`（0.6 GiB，shared core） | $0.0105 /小時 = $7.665 /月；HA $15.33 /月 | 中 |
| `db-g1-small`（1.7 GiB，shared core） | $0.035 /小時 = $25.55 /月；HA $51.10 /月 | 中 |
| Enterprise 版 vCPU | $0.0413 /小時 = $30.149 /vCPU-月；HA $60.298 | 中 |
| Enterprise 版記憶體 | $0.007 /GiB-小時 = $5.11 /GiB-月；HA $10.22 | 中 |
| Enterprise Plus 版 vCPU / 記憶體 | $0.054 /小時（$39.42 /月）、$0.009 /GiB-小時（$6.57 /月） | 中 |
| SSD 儲存 | $0.17 /GiB-月；HA $0.34 | 中 |
| HDD 儲存 | $0.09 /GiB-月 | 中 |
| 備份（已用量） | $0.08 /GiB-月 | 中 |
| 閒置 IPv4 | $0.01 /小時 = $7.30 /月 | 中 |

- HA 倍率：vCPU、記憶體、儲存、shared core 全部 2 倍（高，頁面明列 HA 價格為 2 倍）[S15]。
- 閒置能否停機：可以。`activation-policy=NEVER` 停止後，執行個體費用暫停，儲存與 IP 費用繼續（高）[S16]。
- SLA（高）[S17]：
  - shared core（`db-f1-micro`、`db-g1-small`）不在 SLA 範圍內 [S15]。
  - 單區（非 HA）執行個體不在 SLA 範圍內。
  - Enterprise 版加 HA：月可用率 99.95%；Enterprise Plus 版加 HA：99.99%。
- 版本：PostgreSQL 18（預設，18.6）、17、16、15、14、13（高）[S18]。RLS 是 PostgreSQL 核心功能，所有上述版本都有（推論，低；FORCE ROW LEVEL SECURITY 與 Cloud SQL 的 `cloudsqlsuperuser` 角色互動未實測，需在 M1 驗證）。
- 版本與版別：PostgreSQL 16 以上，用 gcloud 或 API 建立時預設為 Enterprise Plus；shared core 屬 Enterprise 版，建立時必須明確指定 `ENTERPRISE`（高）[S19]。
- 備份與 PITR：自動備份每日一次，預設保留 7 份（可設 1 到 365）[S20]（高）。PITR 需啟用，且一律還原成新執行個體（clone），不能原地還原 [S21]（高）。PITR 的 RPO 秒數與日誌保留費用，頁面未明列，未查到。啟用或停用 PITR 會讓執行個體重啟 [S20]。
- 備份預設存多區域 [S20]；備份價格是否因位置不同，未查到。

### 4. Compute Engine 自架 PostgreSQL（一句）

月費約為 VM 加磁碟（e2-small 約 $14 加磁碟），比 Cloud SQL 的 `db-g1-small` 便宜，但備份、PITR、升級、RLS 角色設定與故障復原都要自己做，且單機沒有 SLA（推論，低）。

### 5. Cloud Storage（asia-east1）

- Standard 儲存：$0.02 /GiB-月（中：取自頁面內嵌區域資料）[S22]。
- 操作（單一區域 Standard）：Class A $0.005 /千次，Class B $0.0004 /千次 [S22]（高）。
- Always Free 額度（5 GB-月）只適用 US-WEST1、US-CENTRAL1、US-EAST1，asia-east1 沒有 [S22]（高）。
- 輸出流量（一般網際網路，月彙總）[S22]（高）：
  - 到亞洲（含香港，不含中國）：0 到 10 TiB $0.12 /GiB。
  - 到全球（不含亞洲、澳洲）：0 到 10 TiB $0.12 /GiB。
  - 到中國（不含香港）：$0.23 /GiB。
  - 到澳洲：$0.19 /GiB。
  - 流入：免費。
- 同一位置內（bucket 與同區 Cloud Run）讀取：免費（高）[S22]。

### 6. Artifact Registry

- 儲存：每月 0.5 GiB 免費，超過 $0.000136986 /GiB-小時（≈ $0.10 /GiB-月）。區域與多區域同價（高）[S23]。
- 資料傳輸：同位置（例如 asia-east1 到 asia-east1 的 Cloud Run）免費；亞洲內不同區域 $0.05 /GiB；流入免費（高）[S23]。
- Cloud Build 非必要：CI 在 GitHub Actions 建置映像後，可用 Workload Identity Federation 登入，推到 Artifact Registry，再用官方 `google-github-actions/deploy-cloudrun`（目前 v3）部署 [S24]（高）。

### 7. Secret Manager

- 有效版本：6 個免費，超過 $0.000082192 /小時（≈ $0.06 /版本-月）。存取操作：每月 10,000 次免費，超過 $0.03 /萬次。輪替通知：3 次免費，超過 $0.05 /次。管理操作與已銷毀版本免費（高）[S25]。

### 8. `*.run.app` 與自訂網域

- 每個 Cloud Run service 有穩定的 HTTPS URL（高）[S26]。格式為 `https://SERVICE_NAME-PROJECT_NUMBER.REGION.run.app`（決定性 URL），也可能是含隨機雜湊的舊格式，兩者都保持穩定（高）[S26]。可當 webhook URL 使用。
- 自訂網域（高）[S27]：
  - 官方建議做法是全域外部 Application Load Balancer。
  - Cloud Run domain mapping 支援 asia-east1，但仍是 Preview，官方明說因延遲問題「不建議用於正式環境」。
  - domain mapping 本身的費用，文件未寫，未查到。
  - Load Balancer 轉發規則：前 5 條 $0.025 /小時（≈ $18.25 /月），再加輸出流量 [S28]（中：此為通用轉發規則價格，Application LB 另有的處理費未查）。

### 9. 存取保護與 IAP

- Cloud Run 直連 IAP（不需 Load Balancer）已 GA（部落格日期 2026-03-14）[S29]（高）。
- 費用：IAP 本身不收費；需要 Load Balancer 時才有網路與運算費 [S30]（高）。
- 文件載明的限制 [S31]（高）：
  - 直連 IAP 保護所有入口，包含預設 `run.app` URL 與 Load Balancer。
  - 不能同時在 Load Balancer 與 Cloud Run 啟用 IAP。
  - 依賴自己驗證機制的服務（例如 Pub/Sub）可能失敗，因為 IAP 會取代原呼叫者身分。
- 能否放行單一路徑給 webhook：文件沒有路徑層級的例外設定，未查到。依上一條限制推論，點點簽伺服器沒有 Google 身分，webhook 會被擋（低）。
- 替代方案（推論，低）：
  1. 拆兩個 service：後台 UI 開 IAP，webhook 單獨一個公開 service。SQLite 單寫入端無法兩個 service 共用，只適用遷移到 PostgreSQL 之後。
  2. 全域外部 Application Load Balancer 加路徑路由：後台 backend 啟用 IAP，`/api/webhooks/dottedsign` 走不啟用 IAP 的 backend，再加 Cloud Armor。月增至少約 $18（見問題 8）。
  3. 應用層驗證：後台加登入，webhook 驗簽或共用密鑰。成本最低，要改程式碼。點點簽是否支援簽章或自訂標頭，我用 `dottedsign-api` MCP 搜尋 `webhook` 無結果，未查到。
- 預算保護：Cloud Run 支援「支出上限預算」（spend cap），達 100% 預估費用時暫停該專案的 Cloud Run 工作，service 回 5xx；上限僅限單一專案加單一服務，不暫停儲存等持續性資源 [S32]（高）。

### 10. Cloud NAT 固定出口 IP（情境 C）

- 閘道：每個使用的 VM 執行個體 $0.0014 /小時（最多 32 個），資料處理 $0.045 /GiB，NAT 使用的外部 IP $0.005 /小時（高）[S28]。
- Cloud Run 要走固定 IP，需設 Direct VPC egress 並 `--vpc-egress=all-traffic`，掛 Cloud NAT 加保留的靜態 IP [S33]（高）。
- Cloud Run 實例如何換算成「VM 執行個體」計價，文件未寫，未查到。以 2 個實例估：2 × $0.0014 × 730 = $2.04；IP $0.005 × 730 = $3.65；處理 5 GiB × $0.045 = $0.23；合計約 $5.92 /月（低）。
- 注意（推論）：`all-traffic` 會讓呼叫 GCS 等 Google API 也經 NAT 計 $0.045 /GiB，需另外設定 Private Google Access 避開。
- 便宜替代：VM 方案只要把 VM 的外部 IP 設成靜態，費用同為 $0.005 /小時（$3.65 /月），不需要 NAT [S28]（高）。

### 11. Cloud Run 回應的 egress

- 走 Premium Tier，依 Cloud Run 定價頁指向網路定價 [S1]。從台灣出發（高 / 中：區域資料解析）[S28]：
  - 到北美、歐洲、亞洲（不含韓國、印尼）：0 到 1,024 GiB $0.12 /GiB；1,024 到 10,240 GiB $0.11；超過 $0.085。
  - 到澳洲、印尼、韓國、南美、沙烏地阿拉伯：$0.19 /GiB（0 到 1,024 GiB）。
  - 到中國（不含香港）：$0.23 /GiB。
  - 流入：免費。
- Cloud Run 頁面提到的「每月 1 GiB 免費」只限北美出口 [S1][S34]，從台灣出去的流量沒有免費額度（中）。
- 同區 Google 資源（例如 Cloud Run 到同區 GCS）免費 [S1]。

### 12. 免費試用與預算警示

- Free Trial：$300 歡迎額度，效期 90 天，期間不會被扣款；需未曾付費使用 Google Cloud、Maps Platform、Firebase，且未註冊過試用 [S34]（高）。
- 註冊必須提供信用卡或其他付款方式，系統會送出 $0 到 $1 的暫時授權（非扣款），部分國家還需驗證銀行帳戶 [S34]（高）。
- 試用結束或額度用完，若未升級為付費帳戶，專案與資源會停止 [S34]（高）。
- 永遠免費額度（節錄）：Compute Engine 1 個 e2-micro 只限 us-west1、us-central1、us-east1，asia-east1 不適用；Artifact Registry 0.5 GB；Secret Manager 6 版本 [S34]（高）。
- 預算警示 [S35]（高）：一般預算（alerts-only）只寄通知，不會自動限制花費；可在 50%、80%、100% 等門檻寄信，也可透過 Pub/Sub 觸發自動動作。要硬性上限，用 Cloud Run 的 spend cap（見問題 9）。

## SQLite 持久化做法比較表

| 做法 | WAL 相容性 | 資料遺失風險 | 費用（asia-east1） | 結論 |
|---|---|---|---|---|
| GCS FUSE 掛載 | 不相容：官方說不支援檔案鎖與 patch，延遲高，不應當資料庫後端；多寫入端 last write wins [S8][S9] | 高：任一重疊寫入即覆蓋，WAL 與 shm 無鎖保護 | 儲存 $0.02 /GiB-月 加操作費 | 不採用。只適合存 PDF 這類整檔一次寫入的物件（推論） |
| 記憶體檔案系統或 in-memory volume，搭配 seed 重建 | 相容（本機檔案系統語意） | 實例停止即全失；資料庫大小吃記憶體 [S5][S6] | 隨記憶體計價，無額外費用 | 只適合 demo 且 DB 小，資料可重建 |
| ephemeral disk 加 Litestream 到 GCS，`max-instances=1` | 相容（ext4 本機磁碟）[S7] | 預設每秒複寫，崩潰最多失約 1 秒資料（Litestream 預設設定）；換版並存會造成複寫衝突 [S13]；request-based 下閒置時 CPU 被降速，同步可能延遲（推論） | 磁碟 $0.000109589 /GiB-小時；GCS 儲存加操作費；Litestream 本身免費 | 目前最合適的 Cloud Run 方案 |
| NFS / Filestore | 不相容：Cloud Run 以 no-lock 掛載 [S10] | 高：同上，且要 VPC | 最小規格：Regional 100 GiB × $0.50 = $50 /月；Basic HDD 1 TiB × $0.18 = $184.32 /月 [S36]（中） | 不採用 |
| Compute Engine VM（e2-micro / e2-small）加持久磁碟跑 Docker | 完全相容 | 取決於快照頻率；磁碟本身有複本 | e2-micro $7.08、e2-small $14.16 /月 [S37]（中）；pd-balanced $0.10 /GB-月、pd-standard $0.04 /GB-月 [S37]（中）；外部 IP $0.005 /小時 = $3.65 /月 [S28]；快照費用未查到；asia-east1 無免費 e2-micro [S34] | 最便宜最單純，但自管 |

## 三情境費用表

### 共用假設

- 一個月 = 730 小時 = 2,628,000 秒。1 GiB ≈ 1 GB。
- Cloud Run：1 vCPU、1 GiB，單一實例，request-based，除非另註明。
- 使用中時間：A 依題目 30 小時（108,000 秒）。B、C 以「請求數 × 0.3 秒」估上限（不計並行重疊，偏保守）。
- 免費額度只套用在使用中計價項，閒置計價項不扣（推論，保守估）。
- Artifact Registry 映像：A 1 GiB、B 2 GiB、C 3 GiB。Secret Manager：A 5 版本、B 與 C 10 版本。
- GCS 操作費為估計值（低）：A $0，B $0.50，C $1.00。
- Litestream 儲存以 DB 大小 × 2（一份快照加增量）估。
- 價格依本文問題 1 到 11 的來源。egress 一律用到亞洲 $0.12 /GiB。

### 情境 A：demo（2,000 次請求、30 小時活動、檔案 1 GB、DB 1 GB 以下、egress 2 GB）

| 計費項 | A1：min=0，request-based，ephemeral disk 加 Litestream | A2：min=1，request-based，同左 | A3：min=1，instance-based，同左 | A4：e2-small VM |
|---|---|---|---|---|
| Cloud Run vCPU 使用中 | 108,000 秒，低於 180,000 免費 = $0 | $0 | 併入下列 | n/a |
| Cloud Run 記憶體使用中 | 108,000 GiB-秒，低於 360,000 免費 = $0 | $0 | 併入下列 | n/a |
| 請求 | 2,000 次，低於 200 萬免費 = $0 | $0 | 無請求費 | n/a |
| min instance 閒置 | n/a | (2,628,000 − 108,000) × ($0.0000025 + $0.0000025) = $12.60 | n/a | n/a |
| instance-based 全程 | n/a | n/a | 2,628,000 × ($0.000018 + $0.000002) = $52.56，扣免費 $5.22 = $47.34 | n/a |
| ephemeral disk 2 GiB | 2 × 30 × $0.000109589 = $0.01 | 2 × 730 × $0.000109589 = $0.16 | $0.16 | n/a |
| VM e2-small | n/a | n/a | n/a | $14.16 |
| 磁碟 20 GB pd-balanced | n/a | n/a | n/a | 20 × $0.10 = $2.00 |
| VM 外部 IP | n/a | n/a | n/a | 730 × $0.005 = $3.65 |
| GCS 檔案 1 GB | 1 × $0.02 = $0.02 | $0.02 | $0.02 | n/a |
| GCS Litestream 2 GB | 2 × $0.02 = $0.04 | $0.04 | $0.04 | n/a |
| egress 2 GB | 2 × $0.12 = $0.24 | $0.24 | $0.24 | $0.24 |
| Artifact Registry | (1 − 0.5) × $0.10 = $0.05 | $0.05 | $0.05 | n/a |
| Secret Manager | 5 版本，免費 = $0 | $0 | $0 | n/a |
| 合計 | 約 $0.36 | 約 $13.11 | 約 $47.85 | 約 $20.05 |

A1 沒算冷啟動與還原延遲（未查到）。若 demo 資料可由 seed 重建，可省掉 Litestream 與 GCS 備份 $0.04。

### 情境 B：pilot 300 租賃單位（300,000 次請求、DB 5 GB、檔案 13 GB、egress 30 GB、上班時段需快速回應）

| 計費項 | B1：Cloud Run min=1 + SQLite（ephemeral disk 加 Litestream） | B1h：同 B1，只在上班時段 min=1 | B2：Cloud Run min=1 + Cloud SQL `db-g1-small` | B3：e2-small VM（40 GB 磁碟） |
|---|---|---|---|---|
| 使用中 vCPU / 記憶體 | 90,000 秒，低於免費額度 = $0 | $0 | $0 | n/a |
| 請求 | 300,000 次，低於免費 = $0 | $0 | $0 | n/a |
| min instance 閒置 | (2,628,000 − 90,000) × $0.000005 = $12.69 | (264 × 3,600 − 90,000) × $0.000005 = $4.30（排程費用未查到） | $12.69 | n/a |
| ephemeral disk 10 GiB | 10 × 730 × $0.000109589 = $0.80 | 約 $0.30（只在實例存活時計） | n/a | n/a |
| Cloud SQL 執行個體 | n/a | n/a | $25.55 | n/a |
| Cloud SQL SSD 5 GB | n/a | n/a | 5 × $0.17 = $0.85 | n/a |
| Cloud SQL 備份 5 GB | n/a | n/a | 5 × $0.08 = $0.40（備份量為估計） | n/a |
| VM e2-small | n/a | n/a | n/a | $14.16 |
| 磁碟 40 GB pd-balanced | n/a | n/a | n/a | 40 × $0.10 = $4.00 |
| VM 外部 IP | n/a | n/a | n/a | $3.65 |
| GCS 檔案 13 GB | 13 × $0.02 = $0.26 | $0.26 | $0.26 | n/a |
| GCS Litestream 10 GB | 10 × $0.02 = $0.20 | $0.20 | n/a | n/a |
| GCS 操作 | $0.50 | $0.50 | $0.10 | n/a |
| egress 30 GB | 30 × $0.12 = $3.60 | $3.60 | $3.60 | $3.60 |
| Artifact Registry | (2 − 0.5) × $0.10 = $0.15 | $0.15 | $0.15 | n/a |
| Secret Manager | (10 − 6) × $0.06 = $0.24 | $0.24 | $0.24 | n/a |
| 合計 | 約 $18.44 | 約 $9.55 | 約 $43.84 | 約 $25.41 |

說明：

- B1h 只在 264 小時（12 × 22）內保持 min=1，下班時間 min=0 會冷啟動，且 5 GB 資料庫要從 GCS 還原，耗時未查到。需靠排程更新 `min-instances`，Cloud Scheduler 費用未查到。
- B2 的 `db-g1-small` 沒有 SLA。換成 Enterprise 版 1 vCPU、3.75 GiB 約 $49.31（vCPU 30.149 + 3.75 × 5.11），機型組合是否允許，未查到。
- B3 快照備份費用未查到。

### 情境 C：Phase 1 結束（1,000,000 次請求、DB 10 GB、檔案 30 GB、egress 100 GB、常駐 worker、固定出口 IP、RPO 5 分鐘）

SQLite 加 Litestream 的預設 1 秒複寫雖然符合 RPO 5 分鐘，但 C 已進入 PostgreSQL 加 RLS 階段，所以 C 只算 Cloud SQL 與 VM 兩條。

| 計費項 | C1：Cloud Run 加 Cloud SQL 2 vCPU / 8 GiB 單區 | C2：同 C1，改 HA | C3：同 C1，改 1 vCPU / 3.75 GiB | C4：單台 e2-standard-2 自管 |
|---|---|---|---|---|
| Web 使用中 vCPU | 1,000,000 × 0.3 = 300,000 秒；超出 120,000 × $0.000024 = $2.88 | $2.88 | $2.88 | n/a |
| Web 使用中記憶體 | 300,000 低於 360,000 免費 = $0 | $0 | $0 | n/a |
| Web 請求 | 100 萬次，低於 200 萬免費 = $0 | $0 | $0 | n/a |
| Web min instance 閒置 | (2,628,000 − 300,000) × $0.000005 = $11.64 | $11.64 | $11.64 | n/a |
| Worker pool（1 vCPU、1 GiB 常駐） | 2,628,000 × ($0.000011244 + $0.000001235)，扣免費 $5.22 = $27.57 | $27.57 | $27.57 | n/a |
| Cloud SQL 執行個體 | 2 × $30.149 + 8 × $5.11 = $101.18 | $202.36 | $49.31 | n/a |
| Cloud SQL SSD 10 GB | 10 × $0.17 = $1.70 | 10 × $0.34 = $3.40 | $1.70 | n/a |
| Cloud SQL 備份 10 GB | 10 × $0.08 = $0.80（估計） | $0.80 | $0.80 | n/a |
| Cloud NAT 與 IP | $5.92（見問題 10） | $5.92 | $5.92 | n/a |
| VM e2-standard-2 | n/a | n/a | n/a | $56.64 |
| 磁碟 100 GB pd-balanced | n/a | n/a | n/a | $10.00 |
| VM 靜態外部 IP | n/a | n/a | n/a | $3.65 |
| GCS 檔案 30 GB | 30 × $0.02 = $0.60 | $0.60 | $0.60 | n/a |
| GCS WAL 封存 20 GB（自管 PITR） | n/a | n/a | n/a | $0.40 |
| GCS 操作 | $1.00 | $1.00 | $1.00 | $0.50 |
| egress 100 GB | 100 × $0.12 = $12.00 | $12.00 | $12.00 | $12.00 |
| Artifact Registry | (3 − 0.5) × $0.10 = $0.25 | $0.25 | $0.25 | n/a |
| Secret Manager | $0.24 | $0.24 | $0.24 | n/a |
| 合計 | 約 $165.78 | 約 $268.66 | 約 $113.91 | 約 $83.19 |

說明：

- Cloud SQL 的 PITR 日誌儲存是否另計，定價頁沒列，未查到。
- C4 的 PITR 要自己用 WAL-G 之類工具封存，快照費用未查到。
- 「RPO 5 分鐘」在 Cloud SQL PITR 的實際保證值，文件未查到。
- C1 到 C3 沒有 SLA 的是單區版本（見問題 3）。要 99.95% 只有 C2 類（Enterprise 加 HA）。

## 來源清單（查詢日期皆為 2026-11-07）

說明：Google 定價頁預設只顯示 Iowa 價格，Taiwan 價格取自頁面內嵌的各區域資料。標「中」的價格請以 Pricing Calculator 再核對。

- S1 Cloud Run pricing：https://cloud.google.com/run/pricing
- S2 Billing settings：https://docs.cloud.google.com/run/docs/configuring/billing-settings
- S3 Cloud Run 概觀（縮放到零）：https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run
- S4 CPU 限制：https://cloud.google.com/run/docs/configuring/services/cpu
- S5 Container runtime contract（檔案系統）：https://cloud.google.com/run/docs/container-contract
- S6 In-memory volume mounts：https://cloud.google.com/run/docs/configuring/services/in-memory-volume-mounts
- S7 Ephemeral disk：https://docs.cloud.google.com/run/docs/configuring/services/ephemeral-disk
- S8 Cloud Storage FUSE 概觀與限制：https://cloud.google.com/storage/docs/cloud-storage-fuse/overview
- S9 Cloud Run Cloud Storage volume mounts：https://cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts
- S10 Cloud Run NFS volume mounts：https://cloud.google.com/run/docs/configuring/services/nfs-volume-mounts
- S11 Litestream releases：https://github.com/benbjohnson/litestream/releases/tag/v0.5.18
- S12 Litestream GitHub API（最新版查詢）：https://api.github.com/repos/benbjohnson/litestream/releases/latest
- S13 Litestream Tips & Caveats：https://litestream.io/tips
- S14 Litestream GCS 指南：https://litestream.io/guides/gcs
- S15 Cloud SQL pricing：https://cloud.google.com/sql/pricing
- S16 Cloud SQL 啟停：https://docs.cloud.google.com/sql/docs/postgres/start-stop-restart-instance
- S17 Cloud SQL SLA：https://cloud.google.com/sql/sla
- S18 Cloud SQL 資料庫版本：https://docs.cloud.google.com/sql/docs/postgres/db-versions
- S19 Cloud SQL editions：https://docs.cloud.google.com/sql/docs/postgres/editions-intro
- S20 Cloud SQL instance settings：https://docs.cloud.google.com/sql/docs/postgres/instance-settings
- S21 Cloud SQL PITR：https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/pitr
- S22 Cloud Storage pricing：https://cloud.google.com/storage/pricing
- S23 Artifact Registry pricing：https://cloud.google.com/artifact-registry/pricing
- S24 deploy-cloudrun GitHub Action：https://github.com/google-github-actions/deploy-cloudrun
- S25 Secret Manager pricing：https://cloud.google.com/secret-manager/pricing
- S26 Cloud Run HTTPS 端點與 URL：https://cloud.google.com/run/docs/triggering/https-request
- S27 Cloud Run 自訂網域：https://cloud.google.com/run/docs/mapping-custom-domains
- S28 VPC 網路定價（egress、外部 IP、轉發規則、Cloud NAT）：https://cloud.google.com/vpc/network-pricing
- S29 IAP 與 Cloud Run GA 公告：https://cloud.google.com/blog/products/serverless/iap-integration-with-cloud-run
- S30 IAP pricing：https://cloud.google.com/iap/pricing
- S31 Configure IAP for Cloud Run / Enable IAP for Cloud Run：https://docs.cloud.google.com/iap/docs/enabling-cloud-run 與 https://cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run
- S32 Spend cap budgets：https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps
- S33 Cloud Run 靜態出口 IP：https://cloud.google.com/run/docs/configuring/static-outbound-ip
- S34 Free Trial 與免費額度：https://docs.cloud.google.com/free/docs/free-cloud-features
- S35 Cloud Billing 預算與警示：https://cloud.google.com/billing/docs/how-to/budgets
- S36 Filestore pricing 與服務層級：https://cloud.google.com/filestore/pricing 與 https://cloud.google.com/filestore/docs/service-tiers
- S37 Compute Engine 機型與磁碟價格（第三方，資料更新於 2026-11-01）：https://gcloud-compute.com/e2-small.html、https://gcloud-compute.com/e2-micro.html、https://gcloud-compute.com/e2-medium.html、https://gcloud-compute.com/e2-standard-2.html、https://gcloud-compute.com/pd-balanced.html、https://gcloud-compute.com/pd-standard.html（Google 的 VM 定價頁為動態載入，無法直接抓取）
