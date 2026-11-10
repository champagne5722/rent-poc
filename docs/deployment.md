# demo 環境部署

demo 環境跑在 GCP Cloud Run（asia-east1），服務名稱 `rent-poc-demo`，資料庫是 Cloud SQL for PostgreSQL。決策見 [ADR-0011](adr/0011-cloud-run-with-litestream-for-demo.md)（Cloud Run 部分）與 [ADR-0012](adr/0012-postgresql-rls-organization-isolation.md)（資料庫部分），評估見 [hosting-evaluation.md](research/hosting-evaluation.md)。

**警告：** 不得在 demo 環境輸入真實個資。Basic Auth 強度低，寄信 adapter 是 `log`，demo 沒有真實寄信服務。

## 分支模型

| 分支 | 用途 | 觸發 |
|---|---|---|
| `dev` | 開發主幹。所有功能分支從這裡開，PR 合併到這裡 | push 與 PR 只跑 `check` 與 `image`，不部署 |
| `demo` | demo 環境的部署來源 | push 才跑 `deploy` |
| `main` | 留給未來的正式環境 | 不觸發任何事 |

- 主控在功能做到一個斷點時，把 `dev` 快轉推到 `demo`，並回報使用者。子對話不推 `demo`。
- `demo` 只接受 `dev` 的快轉。不在 `demo` 上直接提交。
- Workload Identity 的條件只接受 `refs/heads/demo`。其他分支即使改了 workflow，也拿不到 GCP 權限。

## 切換到 Cloud SQL

用 wizard 帶著每一步。在 repo 根目錄的終端機執行：

```bash
deploy/cloudsql-cutover-wizard.sh
```

wizard 有 16 個階段，設定值存在 `.env.deploy`（不進版控，不含機密）。中斷後能重跑，已建立的資源會略過。

| 階段 | 內容 |
|---|---|
| 1 | 須知與工具（gcloud、gh、cloud-sql-proxy） |
| 2 | 切換前檢查清單 |
| 3 | 啟用 API、授權、Workload Identity 條件改成 `demo` |
| 4 | 建立 Cloud SQL 執行個體。這一步開始計費，每月約 US$9.81，必須逐字輸入確認 |
| 5 | 確認 PostgreSQL 主版本與 CI 相同 |
| 6 | 產生資料庫密碼，存進 Secret Manager |
| 7 | 建立角色，執行 migration |
| 8 | 建立檔案用的 Cloud Storage bucket |
| 9 | 輸入五個示範帳號的 email |
| 10 | 執行示範資料種子 |
| 11 | 驗證角色、連線池隔離與 `max_connections` |
| 12 | 寫入 GitHub repo variables |
| 13 | 請主控推 `demo`，等部署結束 |
| 14 | 建立 Cloud Scheduler 的 5 個 job |
| 15 | 冒煙測試與驗收 |
| 16 | 記錄與回滾說明 |

wizard 不建立 `dev` 與 `demo` 分支，也不推 `demo`。階段 13 會停下來，等主控推。wizard 的命令第一次在真實環境執行是 MIL-92，寫成之前只用 `bash -n` 與替身工具空跑檢查過。

### 切換前檢查清單

demo 得先切換，條件是不放真實個資。開放給真實使用者或 pilot 之前，下列項目必須全部完成。

| 項目 | demo 切換 | pilot 前 |
|---|---|---|
| `PRACTICE_REGISTRY`（MIL-113） | 沒設時一律讀真實登錄。審核台沒有資料時，包租與居間合約送不出去 | 登錄資料齊全。不得設 `PRACTICE_REGISTRY=seed` |
| PostgreSQL 版本 | 18，與 CI 相同。wizard 階段 5 檢查 | 同左 |
| `/demo/mail`（MIL-120） | 沒有真實個資時可先接受 | 收掉或限營運者 |
| `AUDIT_ANCHOR_PROVIDER` 與兩個稽核排程（MIL-88） | workflow 寫入 `freetsa`，排程在階段 14 建立 | 換 TWCA 或中華電信 |
| 個資揭露矩陣測試（MIL-165） | 沒有真實個資時可先接受 | 必須通過 |
| 簽章人員只從自家指派居間（MIL-200） | 可先接受 | 必須完成 |

## CI/CD

`.github/workflows/ci-deploy.yml` 有 3 個 job：

| Job | 觸發時機 | 內容 |
|---|---|---|
| `check` | PR、push `dev`、push `demo`、手動 | `tsc`、ESLint、vitest（含真實 PostgreSQL 的測試） |
| `image` | 同上 | 建置映像，執行 `deploy/smoke-test.sh` |
| `deploy` | push `demo`、手動（選 `demo` 分支）。前兩個 job 通過，且已設定 `GCP_PROJECT_ID` | 推送映像，用 `app_owner` 跑 migration，部署 Cloud Run，檢查 `/api/health` |

如果沒有設定 `GCP_PROJECT_ID`，`deploy` 會略過，`demo` 不會失敗。

### 映像冒煙測試

`deploy/smoke-test.sh <映像>` 在宿主機起一個 PostgreSQL 18 容器，依序檢查：

1. 管理者執行 migration，再用 `app_owner` 重跑，必須沒有待執行的項目。
2. 用 `app_rw` 連跑兩次 `npm run db:seed`，第二次不得建立資料。
3. 啟動映像（live 模式、假金鑰）：`/api/health` 回 200、Basic Auth、webhook 驗簽。
4. 重啟映像（mock 模式）：用種子屋主登入，建立物件、建立合約、補欄位、送簽、mock 簽署到完成、下載已簽文件，每一步檢查 response body。
5. 再換一個新實例：session 與上一輪建立的物件仍在 PostgreSQL。

本機執行需要 Docker、Node.js 與 `npm ci` 過的 `node_modules`：

```bash
docker build -t rent-poc:smoke .
deploy/smoke-test.sh rent-poc:smoke
```

### migration 的執行

- 只在 `deploy` 工作跑，在部署新 revision 之前。連線身分是 `app_owner`，經 Cloud SQL Auth Proxy。
- 連線字串在 Secret Manager 的 `migrate-database-url`。只有部署用 service account 讀得到。Cloud Run 的環境變數不含這組憑證。
- 沒有新的 migration 時什麼都不做，所以重新部署與手動重跑都安全。
- migration 先於流量切換，舊 revision 在這段時間仍在服務。新 migration 必須讓舊版本能繼續運作：先加欄位、後移除，不得在同一次部署做破壞性的改動。
- migration 只往前，沒有 down。

## 環境變數與 secrets

Cloud Run 的環境變數：

| 名稱 | 來源 | 用途 |
|---|---|---|
| `APP_ORIGIN` | workflow 組出 | 簽署完成導回網址的 origin |
| `DEMO_BASIC_AUTH_USER` | workflow 寫死 `demo` | Basic Auth 帳號 |
| `DEMO_BASIC_AUTH_PASSWORD` | Secret Manager `demo-basic-auth-password` | Basic Auth 密碼 |
| `DATABASE_URL` | Secret Manager `database-url` | `app_rw` 的連線字串，主機是 Unix socket `/cloudsql/<專案>:asia-east1:<執行個體>`。必須是 `app_rw`，不得是 `app_owner` |
| `PG_POOL_MAX` | workflow 寫死 `5` | 每個實例的連線池上限。見「連線數」 |
| `DOTTEDSIGN_CLIENT_ID` | Secret Manager `dottedsign-client-id` | 點點簽 demo Application。只在 `DOTTEDSIGN_ENABLED=true` 時掛載 |
| `DOTTEDSIGN_CLIENT_SECRET` | Secret Manager `dottedsign-client-secret` | 同上 |
| `DOTTEDSIGN_VERIFY_SIGNERS` | 目前 workflow 不注入，正式環境上線前手動設定 | 設為 `1` 時，送簽替每位簽署人帶 `email` 驗證。未設定時不送。sandbox 停用驗證，帶了會回 400428，所以 demo 必須維持未設定。正式環境的 `email` 驗證尚未實測。這個變數同時是「正式環境」的判定：設為 `1` 時，執業人員登錄一律用真實 adapter（MIL-113），不接受 `PRACTICE_REGISTRY=seed`：兩者並用時，要求執業人員簽章的合約（包租、承租人是包租業者、居間）一律無法送簽（ADR-0021）。設為 `1` 時，綁定未經法務審閱範本的合約也一律無法送簽（MIL-73、P0-10 AC5）。現有的租賃範本 v2 是未審閱，所以上線前要先完成範本審閱（MIL-48）並把範本登錄的 `legalReviewed` 改為 `true`，否則正式環境任何合約都送不出去 |
| `PRACTICE_REGISTRY` | 不注入 | 執業人員登錄的來源（MIL-113）。未設定時讀真實登錄資料。設為 `seed` 改用假資料，只給本機或 mock 示範，正式環境不得設定。說明見 `src/lib/practice-registry/README.md` |
| `FILE_STORE` | workflow 寫死 `gcs` | `gcs` 時文件存進 Cloud Storage。未設定時存實例的本機磁碟（`data/files/`），換實例就會遺失 |
| `GCS_BUCKET_SIGNED` | workflow 組出 `<專案 ID>-files-signed` | 已簽 PDF 與 Audit Trail File 的 bucket。`FILE_STORE=gcs` 時必須設定 |
| `GCS_BUCKET_GENERAL` | workflow 組出 `<專案 ID>-files-general` | 其他檔案的 bucket，例如謄本上傳、帳單匯入。`FILE_STORE=gcs` 時必須設定 |
| `K_SERVICE` | Cloud Run 自動注入 | `src/proxy.ts` 用來判斷是否必須要求密碼 |
| `AUTH_SECRET` | Secret Manager `auth-secret` | 登入驗證碼雜湊用的 HMAC 金鑰（MIL-103）。正式環境沒設定時，登入功能拒絕啟動，驗證碼寄不出去也驗不了。換金鑰會讓尚未使用的驗證碼全部失效，已建立的 session 不受影響 |
| `SEED_OWNER_EMAIL` | workflow 不注入，需要時手動設定 | 預設組織（既有資料所在的屋主組織）的 `admin`。這個 email 第一次通過驗證碼時建帳號並加入預設組織，所以必須在該帳號第一次登入前設定，帳號建立後才設不會補成員資格（admin 移除成員的結果也因此不會被登入蓋回來）。沒設定時沒有人能進入既有資料 |
| `PLATFORM_OPERATOR_EMAILS` | repo variable | 平台營運者的 email。workflow 的 `env_vars` 以逗號分隔，所以這個 variable 只放一個 email（多個時手動用 `gcloud run services update --update-env-vars "^;^…"`）。第一次通過驗證碼時建帳號並加入平台組織，同樣必須在帳號第一次登入前設定。沒有自助註冊 |
| `MAILER_ADAPTER` | workflow 寫死 `log` | 寄信 adapter。目前只有 `log`：驗證碼寫進 server log，並顯示在 `/demo/otp`（Basic Auth 之後，不需登入）。正式環境（`NODE_ENV=production`）沒設定時拒絕寄信，且 `/demo/otp` 回 404，避免忘了設定就把驗證碼公開。真實寄信服務在 pilot 前由使用者選定，選定前不得放真實個資。通知 email 另有 `/demo/mail`（Mock 模式才存在，需要登入）：它列出所有組織的信，含登入驗證碼，**上線前必須收掉或加權限** |
| `JOBS_OIDC_AUDIENCE` | workflow 寫入 `APP_ORIGIN` | 內部 job route 驗證 OIDC token 的 `aud`，值是服務網址。見「內部 job 與 Cloud Scheduler」 |
| `JOBS_OIDC_SERVICE_ACCOUNT` | workflow 組出 `rent-poc-scheduler@<專案 ID>.iam.gserviceaccount.com`。 Cloud Scheduler 的 service account email。token 的 `email` 必須等於它 |
| `AUDIT_ANCHOR_PROVIDER` | workflow 寫死 `freetsa` | 稽核鏈錨定用的服務。demo 設 `freetsa`。正式環境（`NODE_ENV=production`）沒有設定時，`anchor-audit` 與 `verify-audit` 回 500。設成 `mock` 也會被拒絕。見「稽核鏈錨定與每日驗證」 |

登入（MIL-103）與 Basic Auth 並存：先過 Basic Auth，再用 email 驗證碼登入。`/demo/otp` 只在 `log` adapter 下存在。信件清單存在各實例自己的記憶體，所以多於一個實例時，驗證碼可能出現在另一個實例的 `/demo/otp`。demo 流量低，通常只有一個實例。找不到驗證碼時重新整理幾次，或重寄。這是已知限制，真實寄信服務選定後消失。

GitHub repo variables：

| 名稱 | 內容 |
|---|---|
| `GCP_PROJECT_ID` | GCP 專案 ID |
| `GCP_PROJECT_NUMBER` | GCP 專案編號 |
| `WIF_PROVIDER` | Workload Identity provider 的完整名稱 |
| `DEPLOY_SA` | 部署用 service account |
| `RUNTIME_SA` | Cloud Run 執行用 service account |
| `CLOUDSQL_INSTANCE` | Cloud SQL 的連線名稱，格式 `<專案 ID>:asia-east1:rent-poc-demo-pg` |
| `PLATFORM_OPERATOR_EMAILS` | 平台營運者的 email（單一個） |
| `DOTTEDSIGN_ENABLED` | `true` 時掛載點點簽 secrets，否則是 mock 模式 |

GitHub 不存任何 secret。Secret Manager 的名稱：

| 名稱 | 內容 | 誰讀得到 |
|---|---|---|
| `database-url` | `app_rw` 的連線字串（Unix socket） | 執行用 service account |
| `migrate-database-url` | `app_owner` 的連線字串（經 Auth Proxy，`127.0.0.1:5432`） | 部署用 service account |
| `auth-secret` | 登入驗證碼雜湊的金鑰 | 執行用 service account |
| `cloudsql-postgres-password` | `postgres` 管理者密碼，break-glass 與清空資料用 | 只有操作者本人 |
| `demo-basic-auth-password` | Basic Auth 密碼 | 執行用 service account |
| `dottedsign-client-id`、`dottedsign-client-secret` | 點點簽 demo Application | 執行用 service account |

## 資料庫

Cloud SQL for PostgreSQL 18，Enterprise 版，`db-f1-micro`，SSD 10 GiB，單區，公開 IP，每日自動備份。執行個體名稱 `rent-poc-demo-pg`，資料庫 `rentpoc`。每月約 US$9.81。shared core 機型沒有 SLA，demo 接受，pilot 前升規格。

- 應用程式用 `app_rw`，migration 用 `app_owner`，兩個角色都沒有 `BYPASSRLS`。第一個 migration（0001）建立角色，必須由 `postgres` 執行，由 wizard 階段 7 處理。
- 公開 IP 沒有授權網路。連線只走 Cloud SQL Auth Proxy 與 Cloud Run 的 Unix socket。

### 連到 Cloud SQL

1. 啟動 Auth Proxy：

   ```bash
   cloud-sql-proxy --gcloud-auth --port 54320 "$PROJECT:asia-east1:rent-poc-demo-pg"
   ```

2. 另開終端機，取得 `app_owner` 的連線字串，把 port 換成 54320，再用它查資料：

   ```bash
   gcloud secrets versions access latest --secret migrate-database-url --project "$PROJECT"
   ```

3. 用完關掉 Auth Proxy。

### 連線數

`max_connections` 必須大於 Cloud Run 的 `max-instances` 乘以 `PG_POOL_MAX`，並保留餘裕給管理連線與 Cloud Scheduler 的 job。目前 `max-instances` 是 3，`PG_POOL_MAX` 是 5，乘積 15。wizard 階段 11 查 `max_connections` 並檢查這個條件。提高任一個數字前先重查。

## 示範資料

`npm run db:seed` 建立示範資料。讀 `DATABASE_URL`（必須是 `app_rw`），能重複執行，成功時以 0 結束。

| 帳號 | 環境變數 | 預設值 | 建立的資料 |
|---|---|---|---|
| 屋主 | `DEMO_SEED_OWNER_EMAIL` | `demo-owner@example.com` | 屋主組織「示範屋主」，一個示範物件 |
| 代管業者 | `DEMO_SEED_MANAGER_EMAIL` | `demo-manager@example.com` | 組織「示範代管股份有限公司」，業別代管，統編 `00000001` |
| 包租業者 | `DEMO_SEED_MASTER_LESSOR_EMAIL` | `demo-master-lessor@example.com` | 組織「示範包租股份有限公司」，業別包租，統編 `00000002` |
| 承租人 | `DEMO_SEED_TENANT_EMAIL` | `demo-tenant@example.com` | 只有帳號。承租人身分要有案件才出現，建立租賃合約時把承租人 email 填這個位址 |
| 平台營運者 | `DEMO_SEED_OPERATOR_EMAIL` | `demo-operator@example.com` | 帳號加平台組織成員資格 |

- 預設值用保留網域 `example.com`。wizard 階段 9 請操作者輸入自己控制的位址。真實的 email 不進 repo。
- 兩個示範統編的檢查碼不成立，不會與任何真實公司相同。平台只檢查 8 碼數字。
- 種子經既有的帳號、組織與物件函式建立，RLS 與稽核照常生效，沒有直接寫表。
- 代管業者與包租業者的組織是「待驗證」狀態。要走完包租與居間流程，需要平台營運者在審核台核對業別，並登錄執業人員。
- 登入用 email 驗證碼。`log` adapter 不寄信，驗證碼顯示在 `/demo/otp`。
- 重跑只印「已存在」。

本機執行：

```bash
DATABASE_URL=postgres://app_rw:<密碼>@127.0.0.1:5432/rentpoc npm run db:seed
```

## 文件儲存（FileStore）

已簽 PDF、Audit Trail File 與其他上傳檔案存在 Cloud Storage。程式碼在 `src/lib/file-store/`，設計見 [ADR-0012](adr/0012-postgresql-rls-organization-isolation.md)。

兩個 bucket 對應兩種用途：

| 用途 | bucket 環境變數 | 放什麼 |
|---|---|---|
| `signed-document` | `GCS_BUCKET_SIGNED` | 已簽 PDF、Audit Trail File |
| `general` | `GCS_BUCKET_GENERAL` | 謄本上傳、帳單匯入等其他檔案 |

物件 key 格式是 `org/<org_id>/<area>/<檔名>`。文件表只存 key 與 SHA-256，不存路徑。

**警告：** 不得建立 service account 金鑰檔，也不得把金鑰放進 repo、映像或環境變數。Cloud Run 用執行身分（`RUNTIME_SA`）取得權限。

### 設定步驟（wizard 階段 8 已自動執行）

以下是手動做法，只在 wizard 失敗時參考。`$PROJECT` 是 GCP 專案 ID，`$RUNTIME_SA` 是 Cloud Run 的執行用 service account。bucket 名稱要全域唯一，下例用專案 ID 當前綴。

1. 建立兩個 bucket：

   ```bash
   for name in signed general; do
     gcloud storage buckets create "gs://$PROJECT-files-$name" \
       --project "$PROJECT" --location asia-east1 \
       --uniform-bucket-level-access --public-access-prevention
   done
   ```

2. 已簽文件的 bucket 開啟版本控制，誤覆蓋時救得回來：

   ```bash
   gcloud storage buckets update "gs://$PROJECT-files-signed" --versioning
   ```

3. 只在這兩個 bucket 上授權執行身分。不得授權在專案層級：

   ```bash
   for name in signed general; do
     gcloud storage buckets add-iam-policy-binding "gs://$PROJECT-files-$name" \
       --member "serviceAccount:$RUNTIME_SA" --role roles/storage.objectUser
   done
   ```

   `roles/storage.objectUser` 可讀、寫、列出物件，不能改 bucket 設定。

4. 環境變數 `FILE_STORE`、`GCS_BUCKET_SIGNED`、`GCS_BUCKET_GENERAL` 由部署 workflow 寫入，不用手動設定。

5. 驗證（任一步失敗就停下來查）：

   1. mock 模式送簽一份合約，模擬簽署到完成。
   2. 開合約頁，下載已簽 PDF，確認能開。
   3. 執行 `gcloud storage ls "gs://$PROJECT-files-signed/org/**"`，確認有 `org/<org_id>/sign-tasks/…` 的物件。
   4. 重新部署一個 revision，再下載同一份 PDF，確認不需要向服務商補抓。

### 本機開發

不設 `FILE_STORE` 時，檔案存在 `data/files/<用途>/`。不需要 Google 帳號。

### 後續可加

- 已簽文件的 bucket 加保留期鎖（retention policy）。鎖定後無法縮短，上線前要先決定年限。

## 日常操作

指令內的 `$PROJECT` 是 GCP 專案 ID。

### demo 當天避免冷啟動

1. demo 開始前，讓實例保持開機：

   ```bash
   gcloud run services update rent-poc-demo --region asia-east1 --project "$PROJECT" --min=1
   ```

2. demo 結束後，改回去：

   ```bash
   gcloud run services update rent-poc-demo --region asia-east1 --project "$PROJECT" --min=default
   ```

`--min` 是 service 層級的設定，不會部署新 revision。

**注意：** 保持開機每天約 US$1.73。忘記改回去時，每月約 US$48。

### 量測冷啟動秒數

實例閒置 15 分鐘後會關閉。閒置超過 15 分鐘後執行：

```bash
curl -s -o /dev/null -w '%{time_total}s\n' "https://rent-poc-demo-<專案編號>.asia-east1.run.app/api/health"
```

### 回滾

1. 列出 revision：

   ```bash
   gcloud run revisions list --service rent-poc-demo --region asia-east1 --project "$PROJECT"
   ```

2. 把流量切到目標 revision：

   ```bash
   gcloud run services update-traffic rent-poc-demo --region asia-east1 --project "$PROJECT" --to-revisions REVISION=100
   ```

3. 問題修好後，把流量切回最新版。如果沒有做這一步，之後的部署都拿不到流量：

   ```bash
   gcloud run services update-traffic rent-poc-demo --region asia-east1 --project "$PROJECT" --to-latest
   ```

回滾不會回復資料，也不會回復 migration。舊 revision 必須能在新 schema 上運作，所以 migration 一律先加後移除。

需要回復資料時，從 Cloud SQL 的自動備份還原：

```bash
gcloud sql backups list --instance rent-poc-demo-pg --project "$PROJECT"
gcloud sql backups restore BACKUP_ID --restore-instance rent-poc-demo-pg --project "$PROJECT"
```

**警告：** 還原會覆蓋執行個體上的全部資料，備份之後寫入的資料會消失。還原前先通知使用者。

切換到 Cloud SQL 當天若冒煙失敗，回滾做法是把流量切回切換前的 revision（它仍在 Litestream 版本上），並在 `dev` revert 這次合併，避免下一次部署又換版。切換後寫入 Cloud SQL 的資料不會回到 SQLite。

### 換 Basic Auth 密碼

1. 產生新密碼，存入 Secret Manager，並顯示在畫面上：

   ```bash
   NEW_PASSWORD=$(openssl rand -base64 18); printf '%s' "$NEW_PASSWORD" | gcloud secrets versions add demo-basic-auth-password --data-file=- --project "$PROJECT"; echo "$NEW_PASSWORD"
   ```

2. 把新密碼存到你的密碼管理工具。
3. 重新部署，讓新實例讀到新密碼：

   ```bash
   gh workflow run ci-deploy.yml --ref demo
   ```

### 清空 demo 資料

**警告：** 這個步驟會永久刪除 demo 的全部資料，包含稽核紀錄。

1. 暫停 Cloud Scheduler 的 5 個 job，等 2 分鐘讓連線池的閒置連線關閉：

   ```bash
   for JOB in drain-inbox drain-outbox scan-timers anchor-audit verify-audit; do
     gcloud scheduler jobs pause "rent-poc-$JOB" --location asia-east1 --project "$PROJECT"
   done
   ```

2. 刪除並重建資料庫：

   ```bash
   gcloud sql databases delete rentpoc --instance rent-poc-demo-pg --project "$PROJECT"
   gcloud sql databases create rentpoc --instance rent-poc-demo-pg --project "$PROJECT"
   ```

3. 啟動 Auth Proxy（見「連到 Cloud SQL」），用 `postgres` 重跑 migration，再執行種子。`postgres` 的密碼在 Secret Manager 的 `cloudsql-postgres-password`：

   ```bash
   DATABASE_URL="postgres://postgres:<密碼>@127.0.0.1:54320/rentpoc" npm run db:migrate
   DATABASE_URL="postgres://app_rw:<密碼>@127.0.0.1:54320/rentpoc" npm run db:seed
   ```

4. 恢復 5 個 job：

   ```bash
   for JOB in drain-inbox drain-outbox scan-timers anchor-audit verify-audit; do
     gcloud scheduler jobs resume "rent-poc-$JOB" --location asia-east1 --project "$PROJECT"
   done
   ```

檔案 bucket 的內容不會被這個步驟清掉，需要時另外清。這一節的步驟尚未在真實環境實測（MIL-92）。

### break-glass：維運事故時直接進資料庫

**警告：** break-glass 繞過組織隔離。每次使用都必須寫稽核紀錄，沒有例外。

平台營運者看組織資料，走審核台的 `operator` 脈絡。系統會自動留下存取紀錄。break-glass 只用於應用程式本身修不了的事故。

資料庫無法強迫維運人員先寫紀錄，因為授權與切換角色都由管理者操作。所以第 8 步的對帳不能省。

**前提：**

- 事故有工單，工單號是字母數字開頭、64 字內。
- 理由寫在工單上，不放個資。紀錄一旦寫入就刪不掉。
- 平常沒有任何人是 `break_glass` 的成員。

**步驟：**

1. 確認這個資料庫的 `break_glass` 能做什麼：

   ```sql
   SELECT rolbypassrls FROM pg_roles WHERE rolname = 'break_glass';
   ```

   - `true`：本機、CI 與自架 PostgreSQL。角色能讀寫所有組織的列。
   - `false`：Cloud SQL。`postgres` 不是 superuser，建不出有 `BYPASSRLS` 的角色（MIL-79 留言）。此時 `break_glass` 看不到任何組織的列，只能呼叫第 4 步的紀錄函式。
   - Cloud SQL 上，單一組織的事故改用 `app_rw` 經 Auth Proxy 登入（見「連到 Cloud SQL」），在交易內設定 `SELECT set_config('app.org_id', '<組織 ID>', true)`。RLS 照常生效，一次只看得到一個組織。每個交易都要重設，不得用 session 層級的設定。
   - 無論哪一種，第 4 步與第 6 步的紀錄都要寫。

2. 管理者把角色授權給維運人員的資料庫帳號：

   ```sql
   GRANT break_glass TO "<維運帳號>" WITH INHERIT FALSE, SET TRUE;
   ```

3. 維運人員用自己的帳號連線，不共用帳號。紀錄會記下登入身分（`session_user`）。

4. 動手之前，先寫開始紀錄：

   ```sql
   SET ROLE break_glass;
   SELECT * FROM audit.record_break_glass('start', '<工單號>', '<理由>', '<組織 ID>');
   ```

   - 事故只涉及一個組織時，第四個參數填組織 ID。紀錄寫在該組織的鏈，組織匯出稽核紀錄時看得到。
   - 涉及多個組織或與組織無關時，省略第四個參數。紀錄寫在平台鏈。
   - 函式回傳 `chain_id`、`seq`、`hash`。把 `seq` 貼回工單。
   - 函式丟錯時不得繼續。修正工單號或理由後重做這一步。

5. 在工單範圍內作業。範圍外的列不得讀，也不得改。

6. 結束時寫結束紀錄，然後退回原本的角色：

   ```sql
   SELECT * FROM audit.record_break_glass('end', '<工單號>', '<結果摘要>', '<組織 ID>');
   RESET ROLE;
   ```

7. 管理者收回授權：

   ```sql
   REVOKE break_glass FROM "<維運帳號>";
   ```

8. 事後對帳，當天完成。

   - 確認沒有人還持有角色，結果必須是 0 列：

     ```sql
     SELECT member::regrole FROM pg_auth_members WHERE roleid = 'break_glass'::regrole;
     ```

   - 用 `app_rw` 登入，查平台鏈與涉及的組織鏈。每個工單號的 `start` 與 `end` 必須成對：

     ```sql
     BEGIN;
     SELECT set_config('app.org_id', '<組織 ID 或 00000000000000000000000001>', true);
     SELECT seq, occurred_at, actor_id, action, payload FROM audit.events WHERE split_part(action, '.', 1) = 'break_glass' ORDER BY seq;
     COMMIT;
     ```

   - 用 `verifyChain()` 驗證同一條鏈，結果必須通過。
   - 對不上時，當成資安事件處理。在工單記下缺漏，並補寫一筆說明原因的 `start` 或 `end` 紀錄。

## 內部 job 與 Cloud Scheduler

排程重試與每日工作走同一個服務內的內部 route，不開常駐程序。決策見 ADR-0020（`docs/adr/0020-worker-internal-routes-cloud-scheduler.md`）。這一節的步驟已寫進切換 wizard 的階段 14，以下是手動做法。

### job 一覽

入口只有一個：`POST /api/internal/jobs/:name`。Cloud Scheduler 帶 Google 簽發的 OIDC token 呼叫。

| job | 內容 | demo 週期 | pilot 週期 |
|---|---|---|---|
| `drain-inbox` | 重試還沒處理完的 webhook 事件 | 每 60 分鐘 | 每 5 分鐘 |
| `drain-outbox` | 重試未完成的撤回、重寄、文件保存，以及到期的通知 email | 每 60 分鐘 | 每 5 分鐘 |
| `scan-timers` | 執行各線註冊的計時器 | 每日 00:10（台灣時間） | 每日 00:10（台灣時間） |
| `anchor-audit` | 把各組織稽核鏈的鏈頭送到外部時戳服務，保存回執 | 每日 00:30（台灣時間） | 每日 00:30（台灣時間） |
| `verify-audit` | 逐組織重算稽核鏈，並比對已存的回執 | 每日 01:00（台灣時間） | 每日 01:00（台灣時間） |
| `migrate-contracts-to-cases` | 把沒有案件的既有合約遷移成自管租賃案件（MIL-115），可重複執行，已有案件的合約不動 | 不排程 | 不排程 |

`anchor-audit` 與 `verify-audit` 的細節見「稽核鏈錨定與每日驗證」。

`migrate-contracts-to-cases` 不建 Cloud Scheduler 排程。demo 從空資料庫開始，不需要呼叫。

每次 job 的處理筆數有上限。`drain-inbox` 100 筆，`drain-outbox` 50 筆（簽署動作與通知 email 各 50 筆），`scan-timers` 500 項。回應的 `truncated` 為 `true` 時，剩下的留給下一次排程。

週期只是排程設定，不寫在程式碼。pilot 上線時改排程，不用部署。

### 呼叫者驗證

route 驗證三項。三項都通過才執行 job。

1. 簽章。用 Google 的公開金鑰驗證 RS256 簽章。
2. `aud`。必須等於 `JOBS_OIDC_AUDIENCE`。
3. service account。token 的 `email` 必須等於 `JOBS_OIDC_SERVICE_ACCOUNT`，而且 `email_verified` 為 `true`。

驗證失敗回 401，job 不執行。兩個環境變數缺少時回 503，job 也不執行。取不到 Google 金鑰時回 503，Cloud Scheduler 會依重試設定再試。

`src/proxy.ts` 的 Basic Auth 只放行 `/api/internal/jobs/:name` 這個形狀。其他內部路徑仍要求帳號密碼。

### 建立排程

1. 建立 Cloud Scheduler 專用的 service account：

   ```bash
   gcloud iam service-accounts create rent-poc-scheduler --project "$PROJECT" --display-name "rent-poc Cloud Scheduler"
   ```

2. 啟用 Cloud Scheduler API：

   ```bash
   gcloud services enable cloudscheduler.googleapis.com --project "$PROJECT"
   ```

3. 取得服務網址與 service account email，存成變數：

   ```bash
   URL=$(gcloud run services describe rent-poc-demo --region asia-east1 --project "$PROJECT" --format 'value(status.url)')
   SA="rent-poc-scheduler@$PROJECT.iam.gserviceaccount.com"
   ```

4. 兩個驗證設定（`JOBS_OIDC_AUDIENCE`、`JOBS_OIDC_SERVICE_ACCOUNT`）已由部署 workflow 寫進環境變數，這一步省略。wizard 用 `APP_ORIGIN` 當 `$URL`，與 workflow 的 `JOBS_OIDC_AUDIENCE` 一致。

5. 建立五個排程。demo 的 `drain-*` 用 `0 * * * *`（每小時）：

   ```bash
   for JOB in drain-inbox drain-outbox; do
     gcloud scheduler jobs create http "rent-poc-$JOB" --location asia-east1 --project "$PROJECT" \
       --schedule "0 * * * *" --time-zone "Asia/Taipei" \
       --uri "$URL/api/internal/jobs/$JOB" --http-method POST \
       --oidc-service-account-email "$SA" --oidc-token-audience "$URL" \
       --attempt-deadline 300s --max-retry-attempts 3 --min-backoff 30s
   done
   gcloud scheduler jobs create http "rent-poc-scan-timers" --location asia-east1 --project "$PROJECT" \
     --schedule "10 0 * * *" --time-zone "Asia/Taipei" \
     --uri "$URL/api/internal/jobs/scan-timers" --http-method POST \
     --oidc-service-account-email "$SA" --oidc-token-audience "$URL" \
     --attempt-deadline 300s --max-retry-attempts 3 --min-backoff 30s
   # 稽核鏈：先錨定，再驗證。錨定失敗時 job 仍回 200，不靠 Cloud Scheduler 重試，所以 --max-retry-attempts 0
   gcloud scheduler jobs create http "rent-poc-anchor-audit" --location asia-east1 --project "$PROJECT" \
     --schedule "30 0 * * *" --time-zone "Asia/Taipei" \
     --uri "$URL/api/internal/jobs/anchor-audit" --http-method POST \
     --oidc-service-account-email "$SA" --oidc-token-audience "$URL" \
     --attempt-deadline 120s --max-retry-attempts 0
   gcloud scheduler jobs create http "rent-poc-verify-audit" --location asia-east1 --project "$PROJECT" \
     --schedule "0 1 * * *" --time-zone "Asia/Taipei" \
     --uri "$URL/api/internal/jobs/verify-audit" --http-method POST \
     --oidc-service-account-email "$SA" --oidc-token-audience "$URL" \
     --attempt-deadline 300s --max-retry-attempts 0
   ```

6. 手動觸發一次，確認回 200：

   ```bash
   gcloud scheduler jobs run rent-poc-drain-inbox --location asia-east1 --project "$PROJECT"
   gcloud run services logs read rent-poc-demo --region asia-east1 --project "$PROJECT" --limit 20
   ```

7. 確認沒有 token 的請求被擋下。結果必須是 `401`：

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/api/internal/jobs/drain-inbox"
   ```

   Basic Auth 擋不住這個路徑，所以 401 來自 route 自己的驗證。如果回 200，立刻停用排程並檢查環境變數。

### pilot 改成每 5 分鐘

```bash
for JOB in drain-inbox drain-outbox; do
  gcloud scheduler jobs update http "rent-poc-$JOB" --location asia-east1 --project "$PROJECT" --schedule "*/5 * * * *"
done
```

### 人工處理清單

重試超過 5 次的列轉成 `dead`，不再自動重試。job 結果的 `dead` 欄位標出筆數，並寫一筆 error log：`轉人工處理清單`。維運用這筆 log 設告警。

- 查 inbox：用 `app_owner` 連線，執行 `SELECT id, provider_task_ref, event_type, attempts, last_error, received_at FROM control.inbox_messages WHERE status = 'dead' ORDER BY id;`
- 查 outbox：`org.outbox` 有組織 RLS。用 break-glass 步驟進入該組織，查 `status = 'dead'` 的列。
- 處理方式：確認原因後，手動把 `status` 改回 `pending` 並把 `attempts` 歸零。下一次排程會重試。

### 稽核鏈錨定與每日驗證

決策見 ADR-0019。實作在 `src/lib/audit/anchor/`。

這兩個 job 的環境變數是 `AUDIT_ANCHOR_PROVIDER=freetsa`。FreeTSA 每個 IP 每秒限 1 次，沒有 SLA。demo 之後必須換成 TWCA 或中華電信，這是 pilot 的上線閘門。

**`anchor-audit`**

1. 讀出所有「鏈頭序號大於最後一片葉序號」的鏈。
2. 沒有這樣的鏈時，回 `{"status":"no_changes"}`，不呼叫外部服務。
3. 把這些鏈頭組成 Merkle 樹，只把 32 位元組的樹根送到 FreeTSA。
4. 回執通過簽章與信任鏈檢查後，連同葉與證明寫入 `audit.anchor_*`。

結果的 `status` 有四種。

| `status` | 意思 | 要做的事 |
|---|---|---|
| `no_changes` | 所有鏈都沒有新事件 | 無 |
| `anchored` | 已保存一批 | 無 |
| `superseded` | 另一個排程已涵蓋同樣的鏈頭 | 無 |
| `failed` | 外部服務失敗，什麼都沒保存 | 看下一則 log。稽核寫入不受影響 |

失敗時 job 仍回 200，不靠 Cloud Scheduler 重試。下一次排程會把未錨定的鏈頭，連同失敗期間的新事件一起送出。

**`verify-audit`**

1. 從 `control.orgs` 列出所有鏈，含平台組織。
2. 每條鏈開一個 org 交易，驗證本地雜湊鏈。
3. 比對已存的葉：事件雜湊必須與錨定當時相同，證明必須推回樹根，回執必須通過驗證。
4. 任何一項失敗，寫一筆 `CRITICAL` log，結果的 `failed` 列出該鏈。

驗證出問題時 job 仍回 200，因為重試不會改變結果。

**Log 與告警**

log 是一行 JSON，帶 `severity` 與 `component: "audit-anchor"`。Cloud Logging 依 `severity` 分級。

| `severity` | 條件 | 建議的告警 |
|---|---|---|
| `WARNING` | 錨定失敗 1 次 | 不告警 |
| `ERROR` | 錨定連續失敗 2 次以上，或某條鏈的驗證沒有完成 | 通知維運，查 FreeTSA 是否中斷 |
| `CRITICAL` | 稽核鏈驗證失敗 | 立即通知，當成資安事件處理 |

查看 `ERROR` 以上的 log：

```bash
gcloud logging read 'jsonPayload.component="audit-anchor" AND severity>=ERROR' --project "$PROJECT" --limit 20
```

**處理 `CRITICAL`**

1. 讀 log 的 `chainId`、`localIssues`、`anchorIssues`。
2. `anchored_hash_mismatch` 表示該鏈在錨定之後被重算過。
3. `anchored_event_missing` 表示被錨定的事件已不存在。
4. 用 break-glass 的對帳步驟，找出同一時段的資料庫存取紀錄。
5. 用資料庫備份對照該鏈被竄改前的內容。

**已知限制**

- 錨定之後才寫的事件，要等下一次 `anchor-audit` 才有回執。竄改這段事件，回執抓不到。
- 超級使用者也能刪除 `audit.anchor_*` 的列。刪除之後，回執就沒有可比對的對象。資料庫備份是唯一的保險。
- `app_rw` 能呼叫 `audit.record_anchor()`。函式檢查葉對得上目前的事件，但不檢查回執。偽造的批次會讓 `verify-audit` 回報 `anchor_receipt_invalid`，但也會佔掉該鏈那段序號。MIL-89 評估是否改用專用角色。
- `audit.unanchored_heads()` 不檢查呼叫脈絡。任何 `app_rw` 連線都讀得到所有組織的鏈編號、序號與鏈頭雜湊。函式只回傳雜湊，不回傳事件內容。
- `audit.record_anchor_failure()` 同樣不檢查呼叫脈絡。偽造的失敗紀錄只會讓連續失敗的告警提早或誤報，不影響稽核鏈。
- 兩個排程同時執行時，只要有一條鏈已被前一批涵蓋，後到的整批被拒絕（`superseded`）。其他新鏈等下一次排程。
- 拿到回執後保存失敗（資料庫錯誤）時，job 回 500，不計入連續失敗次數。回執沒有存下來，下一次排程重做。
- 回執只證明「這個雜湊在這個時間之前存在」。法律上的舉證力待法務確認（MIL-62）。

**重跑 FreeTSA 實測**

這個測試預設跳過。它只送一個 SHA-256 雜湊，不含業務資料。

```bash
FREETSA_LIVE=1 npx vitest run src/lib/audit/anchor/freetsa.live.test.ts
```

### 註冊計時器（給各線）

計時器註冊處是 `src/lib/jobs/timers/index.ts`。資料在組織內的計時器實作 `OrgTimer`。資料在 `registry` 的計時器實作 `GlobalTimer`。再加一行 `timerRegistry.register(...)`。介面與規則見 `src/lib/jobs/timers/registry.ts`。

冪等鍵是主體、事件、日期。同一把鍵只執行一次，效果與冪等紀錄在同一個交易。

## 資料保存規則

- 資料在 Cloud SQL，每日自動備份。換版與回滾不會遺失資料。
- 文件（已簽 PDF、Audit Trail File、其他上傳檔）在 Cloud Storage 的兩個 bucket。已簽文件的 bucket 開啟版本控制。
- 切換前的舊資料（Litestream 複寫在 `gs://<專案 ID>-demo-db`）不搬到 Cloud SQL，保留 2 週後刪除。到期日記在 MIL-92。
