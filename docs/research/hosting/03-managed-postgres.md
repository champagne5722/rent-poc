# 託管 PostgreSQL 調研：Neon 與 Supabase

查詢日期：2026-11-07。所有數字來自本次實際讀取的頁面，來源編號見文末。信心：高（官方頁面）、中（官方搜尋摘要、第三方）、低（推論）。

## 結論

1. 兩家都沒有台灣區域。Neon 最近是新加坡（`aws-ap-southeast-1`），Supabase 最近是東京（`ap-northeast-1`）與新加坡，Supabase 另有首爾。
2. 兩家的 Postgres 都能建自訂角色、多 schema、觸發器、`SECURITY DEFINER`、`FORCE ROW LEVEL SECURITY`（文件未逐項禁止，須 PoC 驗證）。真正的雷是 BYPASSRLS：Neon 用 Console 或 API 建的角色預設有，改用 SQL `CREATE ROLE` 建；Supabase 的 `service_role` 有，`postgres` 角色擁有的 `SECURITY DEFINER` 函式會繞過 RLS。
3. 池化的 transaction 模式下，`SET LOCAL` 兩家文件都沒有明載。PgBouncer 官方列 `SET/RESET` 為 Never。`set_config(..., true)` 與 `SET LOCAL` 是否安全，必須在 PoC 實測。
4. 費用（情境 A/B/C）：Neon Launch 約 $1.15 / $8.95 至 $29.93 / $22.98 至 $80.22。Supabase Pro 約 $25 / $25 至 $30 / $125 至 $130。情境 C 要時點復原，Supabase PITR 單項 $100，Neon 的 history 按 GB 計費便宜很多，但 Neon 的 RPO 未查到。
5. 區域在台灣以外是否可行，個資法第 21 條只授權中央目的事業主管機關限制國際傳輸，本次沒查到不動產業的限制公告。須法務確認。

## 1. Neon

| 項目 | Free | Launch（最低付費） | 信心 |
|---|---|---|---|
| 月費 | $0 | 無固定月費、無最低消費，用多少付多少 | 高 [N1] |
| 計算 | 100 CU-hours / project | $0.106 / CU-hour | 高 [N1] |
| 儲存 | 1 GB / project，全帳號 20 GB | $0.35 / GB-month | 高 [N1] |
| 歷史（PITR） | 6 小時，變更量 1 GB 內 | 最長 7 天，預設 1 天，$0.20 / GB-month（只算 root branch 的 WAL 歷史） | 高 [N1][N5] |
| Branch | 10 | 含 10，超過 $1.50 / branch-month | 高 [N1] |
| 自動擴縮 | 最高 2 CU | 最高 16 CU（64 GB RAM） | 高 [N1] |
| scale-to-zero | 5 分鐘後，不能關 | 5 分鐘後，可關閉 | 高 [N1] |
| 流量 | 5 GB / project | 500 GB / project，之後 $0.10 / GB | 高 [N1] |

- 一個 CU 約 4 GB RAM，最小 0.25 CU（1 GB RAM）。vCPU 數文件未寫 [N5]。
- 計費單位：CU-hours = 計算大小 × 運作小時。縮到零時不計。所有 compute 都算，含 read replica [N5]。
- 冷啟動：官方只說「幾百毫秒內自動恢復」，沒有更精確的數字 [N3]（高）。
- 區域：AWS 有 US East（維吉尼亞、俄亥俄）、US West（奧勒岡）、法蘭克福、倫敦、新加坡、雪梨、聖保羅。東京、台灣、首爾、香港未列，要請 Neon support 申請 [N2]（高）。Azure 區域已不能新建。
- 發票低於 $0.50 不收款 [N1]。

## 2. Supabase

| 項目 | Free | Pro | 信心 |
|---|---|---|---|
| 月費 | $0 | $25 起 | 高 [S1] |
| 資料庫大小 | 500 MB | 8 GB 磁碟含在內，之後 $0.125 / GB | 高 [S1][S6] |
| 計算 | 共用 CPU，約 0.5 GB RAM（Nano） | 含 $10 compute credits，剛好抵一台 Micro | 高 [S1][S6][S7] |
| 備份 | 無自動備份 | 每日備份保留 7 天 | 高 [S1][S3] |
| 流量 | 5 GB | 250 GB，之後 $0.09 / GB | 高 [S1] |
| 閒置暫停 | 一週內資料庫活動不足就暫停；暫停前約一週寄警告信；暫停後可還原 1 年 | 不會暫停 | 高 [S4]（搜尋摘要曾見 90 天舊版文字，以官方頁面 1 年為準） |
| 專案數 | 2 個組織，各 1 個 active 專案 | — | 高 [S2] |

- compute 加購（每月）：Micro $10、Small $15、Medium $60、Large $110、XL $210、2XL $410、4XL $960 [S1]（高）。Micro $0.01344 / 小時，按小時計，不滿一小時算一小時 [S7]。compute 不受 Spend Cap 保護。
- 規格：Micro 1 GB RAM，直連 60、pooler 客戶端 200；Small 2 GB，90 / 400；Medium 4 GB，120 / 600；預設 pool 15 [S6]（高）。
- PITR 加購：7 天 $100 / 月、14 天 $200、28 天 $400，按小時計，不受 Spend Cap 保護 [S8]。RPO 最壞 2 分鐘，WAL 約每 2 分鐘備份。所有 compute 大小都能用。啟用 PITR 後每日備份停止 [S3]（高）。
- 區域：東京 `ap-northeast-1`、新加坡 `ap-southeast-1`、首爾、孟買、雪梨等。台灣與香港未列 [S5]（高）。
- Supavisor transaction 模式：共用 pooler 埠 6543，使用者 `postgres.[PROJECT-REF]`，不支援 prepared statement，共用 pooler 只有 IPv4。文件說 session 層級狀態（含 `set`、`reset`）在交易之間遺失，要在需要的交易內執行，或用 session 模式或直連。`SET LOCAL` 未明載 [S9]（高）。
- Pro 以上有 dedicated pooler（PgBouncer，只有 transaction 模式，支援 prepared statement，預設 IPv6）[S9]（高）。

## 3. RLS 相容性

| 能力 | Neon | Supabase | 信心 |
|---|---|---|---|
| pooler transaction 模式下 `SET LOCAL` / `set_config(..., true)` | 文件列 `SET` / `RESET` 不支援，沒提 `SET LOCAL` [N4] | 文件說 `set` 狀態會遺失，要在交易內執行 [S9] | 中。兩家皆未明載，PgBouncer 官方亦未提 [P1]。須 PoC 實測 |
| 自訂角色 | 可。SQL `CREATE ROLE` 建的角色只有 public schema 基本權限，要自己授權 [N6] | 可。`create role` 加 `login password` [S10] | 高 |
| 角色的 BYPASSRLS | `neon_superuser` 含 CREATEDB、CREATEROLE、BYPASSRLS、REPLICATION。Console / API / CLI 建的角色與專案初始 owner（如 `neondb_owner`）都是成員，SQL 建的不是 [N6][N7] | `service_role` 有 `bypassrls`；`postgres` 擁有的 `SECURITY DEFINER` 函式會繞過 RLS，因為該角色有 `bypassrls` [S11] | 高 |
| `FORCE ROW LEVEL SECURITY` | 兼容性頁未列為限制 [N7]，未明載支援 | RLS 文件提到有此設定 [S11] | 中。須 PoC |
| `SECURITY DEFINER` | 兼容性頁未列為限制 | 支援。須設 `search_path = ''`，且不要放在對外暴露的 schema [S11] | 中 |
| 多 schema、觸發器 | 兼容性頁未列為限制 | 標準 Postgres。Supabase 預設只暴露的 schema 要看 Data API 設定 | 低。須 PoC |
| 平台保留限制 | 不能連超級使用者；只能裝 Neon 支援的 extension；instance 層級參數只有 Scale 可請求調整；不能建 tablespace；idle 連線會被關，session 狀態消失 [N7] | `postgres` 不是真正的超級使用者；不支援 `COPY ... FROM PROGRAM`、`ALTER USER ... WITH SUPERUSER` [S12]。`postgres` 能否管理 BYPASSRLS 屬性，官方 changelog 曾提及，現況未查到 | 高 |
| 對應本案 `app_rw` / `app_owner` | 用 SQL 建 `app_rw`（`NOBYPASSRLS`）。注意專案初始 owner 有 BYPASSRLS，不要給應用用 | 用 SQL 建 `app_rw`、`app_owner`。避免用 `postgres` 當函式 owner，改由 `app_owner`（NOBYPASSRLS）擁有 | 中（推論） |

## 4. 延遲

可查到的實測只有以下，Cloud Run asia-east1 到 Neon / Supabase 的直接實測未查到。

| 資料 | 數字 | 信心 |
|---|---|---|
| AWS ap-east-1（香港）到 ap-northeast-1（東京） | 52.26 ms | 中 [L1]（第三方，無方法與日期） |
| AWS 東京到新加坡 | 70.05 ms | 中 [L2]（同上） |
| Hyperdrive 文件：從遠地 region 每個查詢 | 20 至 30 ms；就近放置 1 至 3 ms | 高 [C1] |

- 推論：Cloud Run 彰化到 AWS 東京的 RTT 約 35 至 55 ms，到新加坡約 50 至 80 ms。依據：台灣在香港與東京之間的地理位置，加上上表兩個數字。跨雲（GCP 到 AWS）多一段公網或互連，實際值須量。信心低。
- 推論：交易內查詢數放大延遲。`withTx()` 至少有 BEGIN、`set_config`、N 個查詢、COMMIT，共 N+3 次往返。RTT 50 ms、N=10 時約 650 ms，只是網路。若 pg driver 把 BEGIN 與 `set_config` 分開送，更多。對策：把 `set_config` 與第一個查詢合併成一個語句、查詢用 CTE 合併、或把整個交易寫成 `SECURITY DEFINER` 函式一次呼叫。
- Neon serverless driver：HTTP 單查詢約 3 次往返，TCP 約 8 次（含連線建立），HTTP 只支援非互動交易，互動交易要用 WebSocket [N8]（高）。
- Hyperdrive：pool 在資料庫附近；`SET` 只在交易或單一查詢內有效，連線歸還時 RESET；`SET LOCAL` 未明載 [C2]（高）。接 Neon 要用直連字串（關掉 Neon 池化）與 `pg` 8.16.3 以上，不要用 Neon serverless driver [C3]（高）。Supabase 的 Hyperdrive 步驟未查到。快取讀取查詢，不會因寫入失效，交易型資料不要開 [C2]。Hyperdrive Free 每天 10 萬次查詢，Paid 不限，不另收資料傳輸費 [C4]。
- Workers 到 Neon / Supabase 的實測：未查到。

## 5. 個資法

- 全國法規資料庫的個資法頁面顯示第 21 條：非公務機關國際傳輸個人資料時，中央目的事業主管機關得在四種情形限制：涉及國家重大利益；國際條約或協定有特別規定；接受國對個資保護的法規不完備，有損當事人權益之虞；以迂迴方式向第三國傳輸以規避本法 [G1]（高）。條文本身沒有「資料必須存放台灣」的一般規定。
- 同頁顯示第 20-1 條第 1 項要求非公務機關採取安全維護措施，防止個資被竊取、竄改、毀損、滅失或洩漏 [G1]。第 27 條在該頁標為刪除。
- 搜尋到內政部 99 年函釋，指出舊的不動產仲介經紀業電腦處理個資管理辦法因個資法修正失去法律依據。本次沒有查到內政部或個人資料保護委員會針對不動產業限制國際傳輸的現行公告 [G2]（中，為地方法規網站彙整，非原始公告）。
- 本案客戶若為金融業、建經業，另有主管機關規定，本次未查。
- 以上只列公開條文。是否可把資料放新加坡或東京，**須法務確認**。

## 6. 與 Cloud SQL asia-east1 對照時要看的欄位

Cloud SQL 的數字由另一份調研提供。比較時只看這些：

1. 最低規格的月費：Neon 看「CU-hours × $0.106 + GB × $0.35 + history GB × $0.20」，Supabase 看「$25 + compute 超出 $10 的部分 + 磁碟超出 8 GB 的部分 + PITR $100」。
2. 費用是否含儲存、備份、HA。Cloud SQL 最低規格通常儲存與備份另計。
3. PITR 的 RPO 與保留天數：Supabase 2 分鐘、7 天起；Neon 最長 7 天，RPO 未查到。
4. 是否能 24 小時常駐不 scale-to-zero（情境 C）。
5. RLS 能力：`app_rw` / `app_owner` 自訂角色、`FORCE RLS`、`SECURITY DEFINER`，兩家都靠 PoC 驗證，Cloud SQL 的 `postgres` 角色權限也要比。
6. 區域：Cloud SQL 在 asia-east1（台灣）。兩家託管都在境外，延遲與個資法列為成本之外的差異。

## 7. 低價替代（每家一行）

| 平台 | 亞太區 | 最低月費 | 信心 |
|---|---|---|---|
| Render Postgres | 有新加坡，無東京 [R1] | Free $0（30 天限制）、Basic-256mb $6、Basic-1gb $19，儲存另計 $0.30 / GB；所有付費資料庫含 PITR [R2][R3] | 中。價格來自搜尋摘要，官方頁面本次抓不到價格表 |
| Railway | 有新加坡 [RW2] | Hobby $5 含 $5 用量，用量計價約 vCPU $20 / 月、記憶體 $10 / GB / 月、磁碟 $0.15 / GB / 月 [RW1]。這是自架 Postgres 容器，不是託管服務，PITR 未查到 | 中 |
| Fly.io Managed Postgres | 日本 `nrt`、新加坡 `sin` 在區域表，是否支援 MPG 頁面未明載 [F2] | Basic（共用 2x，1 GB）$38，儲存 $0.28 / GB，含 HA 與備份；PITR 未查到 [F1] | 高（價格），低（區域） |

## 8. 三情境費用（美元）

共同假設：1 個月 = 720 小時（情境 C）。history 或 PITR 的增量 GB 官方沒給估法，下表標「推論」。流量與 branch 超額不計。

### Neon Launch

| 情境 | 算式 | 小計 |
|---|---|---|
| A demo | 計算 0.25 CU × 30 小時 = 7.5 CU-h × 0.106 = $0.80。儲存 1 × 0.35 = $0.35。history 預設 1 天，增量約 0（推論）。 | **$1.15** |
| B pilot（0.25 CU） | 計算 0.25 × 264 小時（12 × 22）= 66 CU-h × 0.106 = $7.00。儲存 5 × 0.35 = $1.75。history 1 GB（推論）× 0.20 = $0.20。 | **$8.95** |
| B pilot（1 CU） | 計算 1 × 264 = 264 CU-h × 0.106 = $27.98。儲存 $1.75。history $0.20。 | **$29.93** |
| C Phase 1（0.25 CU） | 計算 0.25 × 720 = 180 CU-h × 0.106 = $19.08。儲存 10 × 0.35 = $3.50。history 7 天，2 GB（推論）× 0.20 = $0.40。 | **$22.98** |
| C Phase 1（1 CU） | 計算 1 × 720 = 720 CU-h × 0.106 = $76.32。儲存 $3.50。history $0.40。 | **$80.22** |

- B 上班時段外縮到零。上班時段內若閒置超過 5 分鐘也會縮到零，算式是上限。
- 冷啟動為「幾百毫秒」，pilot 的「快速回應」要求建議關閉 scale-to-zero 才有保證，但那會變成 720 小時計價（同 C）。
- 0.25 CU（1 GB RAM）夠不夠跑 background worker 與 RLS 查詢，未查到，須壓測。
- Free 方案情境 A：儲存 1 GB 剛好是上限，超過會禁止寫入，且沒有 PITR。情境 A 用 Free 為 $0，風險是 1 GB 邊界。

### Supabase Pro

| 情境 | 算式 | 小計 |
|---|---|---|
| A demo | $25 基本費。Micro $10 由 $10 credits 抵銷，附加 $0。磁碟 < 8 GB 含在內。 | **$25.00** |
| B pilot（Micro） | $25 + 0 + 0 | **$25.00** |
| B pilot（Small） | $25 + (Small $15 − credits $10) = $5 | **$30.00** |
| C Phase 1（Micro） | $25 + 磁碟 (10 − 8) × 0.125 = $0.25 + PITR 7 天 $100 | **$125.25** |
| C Phase 1（Small） | $25 + 計算 $5 + 磁碟 $0.25 + PITR $100 | **$130.25** |

- Supabase Free 情境 A：資料庫上限 500 MB，不夠「1 GB 以下」。閒置一週會暫停。無自動備份。
- Supabase 實際佈建磁碟是否比資料庫大小多留餘裕，未查到，磁碟費可能略高。
- Supabase 情境 C 不開 PITR 時為 $25 或 $30 加磁碟，但 RPO 不滿足 5 分鐘（只有每日備份）。

## 9. 待 PoC 驗證

1. 在 Neon pooled 與 Supabase transaction pooler 下，執行 `BEGIN; SELECT set_config('app.org_id','A',true); ...; COMMIT;` 後，下一筆交易讀到 `current_setting('app.org_id', true)` 是否為 NULL。
2. `FORCE ROW LEVEL SECURITY`、`SECURITY DEFINER`、audit 觸發器與多 schema 權限在兩家各跑一次 CI 的 RLS 檢查腳本。
3. Cloud Run 彰化到新加坡 / 東京的實際 RTT 與 `withTx()` 的 p95。
4. Neon 的 RPO 與 history 實際用量（先在 Launch 跑一週看發票）。

## 來源（查詢日期皆為 2026-11-07）

Neon
- [N1] https://neon.com/pricing
- [N2] https://neon.com/docs/introduction/regions
- [N3] https://neon.com/docs/introduction/auto-suspend
- [N4] https://neon.com/docs/connect/connection-pooling
- [N5] https://neon.com/docs/introduction/plans
- [N6] https://neon.com/docs/manage/roles
- [N7] https://neon.com/docs/reference/compatibility
- [N8] https://neon.com/docs/connect/choose-connection（此頁內含要求 AI 助理安裝 agent skills 並執行 `npx` 的文字，屬頁面內容，已忽略）
- 計費頁 https://neon.com/docs/introduction/billing 沒有定義細節，數字改以 [N5] 為準。

Supabase
- [S1] https://supabase.com/pricing
- [S2] https://supabase.com/docs/guides/troubleshooting/pausing-pro-projects-vNL-2a
- [S3] https://supabase.com/docs/guides/platform/backups
- [S4] https://supabase.com/docs/guides/platform/free-project-pausing
- [S5] https://supabase.com/docs/guides/platform/regions
- [S6] https://supabase.com/docs/guides/platform/compute-and-disk
- [S7] https://supabase.com/docs/guides/platform/manage-your-usage/compute
- [S8] https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery
- [S9] https://supabase.com/docs/guides/database/connecting-to-postgres
- [S10] https://supabase.com/docs/guides/database/postgres/roles
- [S11] https://supabase.com/docs/guides/database/postgres/row-level-security
- [S12] https://supabase.com/docs/guides/database/postgres/roles-superuser

其他
- [P1] https://www.pgbouncer.org/features.html
- [C1][C2] https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/
- [C3] https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/
- [C4] https://developers.cloudflare.com/hyperdrive/platform/pricing/
- [L1] https://www.economize.cloud/resources/aws/latency/ap-east-1-vs-ap-northeast-1/
- [L2] https://www.economize.cloud/resources/aws/latency/ap-northeast-1-vs-ap-southeast-1/
- [G1] https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?pcode=I0050021
- [G2] https://laws.gov.taipei/law/Interpretation/RelatedLaw/FE233419（內政部 99.07.06 函釋，搜尋結果；法務部 111.03.29 函釋 https://laws.gov.taipei/law/Interpretation/RelatedLaw/FE367574）
- [R1] https://render.com/docs/regions
- [R2] https://render.com/docs/postgresql-creating-connecting
- [R3] 價格為網路搜尋摘要，引用 Render 官方定價頁與 https://render.com/docs/postgresql-refresh，本次抓取未取得價格表
- [RW1] https://railway.com/pricing
- [RW2] https://docs.railway.com/reference/regions
- [F1] https://docs.fly.io/mpg
- [F2] https://docs.fly.io/reference/regions/
