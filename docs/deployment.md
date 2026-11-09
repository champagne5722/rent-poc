# demo 環境部署

demo 環境跑在 GCP Cloud Run（asia-east1），服務名稱 `rent-poc-demo`。決策見 [ADR-0011](adr/0011-cloud-run-with-litestream-for-demo.md)，評估見 [hosting-evaluation.md](research/hosting-evaluation.md)。

**警告：** 不得在 demo 環境輸入真實個資。Basic Auth 強度低，且換版可能遺失資料。

## 第一次部署

在 repo 根目錄的終端機執行腳本。腳本會逐步引導，並在你自己的瀏覽器完成登入：

```bash
deploy/first-deploy-wizard.sh
```

腳本的設定值存在 `.env.deploy`。這個檔案不進版控，不含機密。中斷後能重跑，已建立的資源會略過。

## CI/CD

`.github/workflows/ci-deploy.yml` 有 3 個 job：

| Job | 觸發時機 | 內容 |
|---|---|---|
| `check` | PR、push main、手動 | `tsc`、ESLint、vitest |
| `image` | PR、push main、手動 | 建置映像，執行 `deploy/smoke-test.sh` |
| `deploy` | push main、手動。前兩個 job 通過，且已設定 `GCP_PROJECT_ID` | 推送映像，部署 Cloud Run，檢查 `/api/health` |

如果沒有設定 `GCP_PROJECT_ID`，`deploy` 會略過，main 不會失敗。

## 環境變數與 secrets

Cloud Run 的環境變數：

| 名稱 | 來源 | 用途 |
|---|---|---|
| `APP_ORIGIN` | workflow 組出 | 簽署完成導回網址的 origin |
| `DEMO_BASIC_AUTH_USER` | workflow 寫死 `demo` | Basic Auth 帳號 |
| `DEMO_BASIC_AUTH_PASSWORD` | Secret Manager `demo-basic-auth-password` | Basic Auth 密碼 |
| `LITESTREAM_GCS_BUCKET` | repo variable | Litestream 複寫的 bucket |
| `DOTTEDSIGN_CLIENT_ID` | Secret Manager `dottedsign-client-id` | 點點簽 demo Application。只在 `DOTTEDSIGN_ENABLED=true` 時掛載 |
| `DOTTEDSIGN_CLIENT_SECRET` | Secret Manager `dottedsign-client-secret` | 同上 |
| `DOTTEDSIGN_VERIFY_SIGNERS` | 目前 workflow 不注入，正式環境上線前手動設定 | 設為 `1` 時，送簽替每位簽署人帶 `email` 驗證。未設定時不送。sandbox 停用驗證，帶了會回 400428，所以 demo 必須維持未設定。正式環境的 `email` 驗證尚未實測。這個變數同時是「正式環境」的判定：設為 `1` 且 C 線的 `practiceRegistry` 真實 adapter 尚未註冊時，要求執業人員簽章的合約（包租、承租人是包租業者、居間）一律無法送簽（ADR-0021）。未設定時用 seed 假資料 |
| `FILE_STORE` | MIL-92 設定 | `gcs` 時文件存進 Cloud Storage。未設定時存實例的本機磁碟（`data/files/`），換實例就會遺失 |
| `GCS_BUCKET_SIGNED` | MIL-92 設定 | 已簽 PDF 與 Audit Trail File 的 bucket。`FILE_STORE=gcs` 時必須設定 |
| `GCS_BUCKET_GENERAL` | MIL-92 設定 | 其他檔案的 bucket，例如謄本上傳、帳單匯入。`FILE_STORE=gcs` 時必須設定 |
| `K_SERVICE` | Cloud Run 自動注入 | `src/proxy.ts` 用來判斷是否必須要求密碼 |
| `JOBS_OIDC_AUDIENCE` | MIL-92 切換時設定 | 內部 job route 驗證 OIDC token 的 `aud`，值是服務網址。見「內部 job 與 Cloud Scheduler」 |
| `JOBS_OIDC_SERVICE_ACCOUNT` | MIL-92 切換時設定 | Cloud Scheduler 的 service account email。token 的 `email` 必須等於它 |

GitHub repo variables：

| 名稱 | 內容 |
|---|---|
| `GCP_PROJECT_ID` | GCP 專案 ID |
| `GCP_PROJECT_NUMBER` | GCP 專案編號 |
| `WIF_PROVIDER` | Workload Identity provider 的完整名稱 |
| `DEPLOY_SA` | 部署用 service account |
| `RUNTIME_SA` | Cloud Run 執行用 service account |
| `LITESTREAM_BUCKET` | Cloud Storage bucket 名稱 |
| `DOTTEDSIGN_ENABLED` | `true` 時掛載點點簽 secrets，否則是 mock 模式 |

GitHub 不存任何 secret。

## 文件儲存（FileStore）

已簽 PDF、Audit Trail File 與其他上傳檔案存在 Cloud Storage。程式碼在 `src/lib/file-store/`，設計見 [ADR-0012](adr/0012-postgresql-rls-organization-isolation.md)。

兩個 bucket 對應兩種用途：

| 用途 | bucket 環境變數 | 放什麼 |
|---|---|---|
| `signed-document` | `GCS_BUCKET_SIGNED` | 已簽 PDF、Audit Trail File |
| `general` | `GCS_BUCKET_GENERAL` | 謄本上傳、帳單匯入等其他檔案 |

物件 key 格式是 `org/<org_id>/<area>/<檔名>`。文件表只存 key 與 SHA-256，不存路徑。

**警告：** 不得建立 service account 金鑰檔，也不得把金鑰放進 repo、映像或環境變數。Cloud Run 用執行身分（`RUNTIME_SA`）取得權限。

### 設定步驟（MIL-92 執行）

`$PROJECT` 是 GCP 專案 ID，`$RUNTIME_SA` 是 Cloud Run 的執行用 service account。bucket 名稱要全域唯一，下例用專案 ID 當前綴。

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

4. 在 Cloud Run 服務設定環境變數：

   ```bash
   gcloud run services update rent-poc-demo --region asia-east1 --project "$PROJECT" \
     --update-env-vars "FILE_STORE=gcs,GCS_BUCKET_SIGNED=$PROJECT-files-signed,GCS_BUCKET_GENERAL=$PROJECT-files-general"
   ```

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

`--min` 是 service 層級的設定，不會部署新 revision。不得改用 `--min-instances`，它會部署新 revision，並存期間的寫入會遺失。

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

回滾不會回復資料。新實例還原的是 `CURRENT` 指向的最新資料。

### 換 Basic Auth 密碼

1. 產生新密碼，存入 Secret Manager，並顯示在畫面上：

   ```bash
   NEW_PASSWORD=$(openssl rand -base64 18); printf '%s' "$NEW_PASSWORD" | gcloud secrets versions add demo-basic-auth-password --data-file=- --project "$PROJECT"; echo "$NEW_PASSWORD"
   ```

2. 把新密碼存到你的密碼管理工具。
3. 重新部署，讓新實例讀到新密碼：

   ```bash
   gh workflow run ci-deploy.yml --ref main
   ```

### 清空 demo 資料

**警告：** 這個步驟會永久刪除 demo 資料。

1. 刪除 `CURRENT`。舊的複寫資料留在 `runs/` 下：

   ```bash
   gcloud storage rm "gs://<bucket>/CURRENT"
   ```

2. 重新部署。新實例會用空資料庫啟動：

   ```bash
   gh workflow run ci-deploy.yml --ref main
   ```

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
   - Cloud SQL 的替代做法由 MIL-89 與 MIL-92 決定。決定前，單一組織的事故改用 `app_rw` 登入，在交易內設定 `SELECT set_config('app.org_id', '<組織 ID>', true)`。RLS 照常生效，一次只看得到一個組織。每個交易都要重設，不得用 session 層級的設定。
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

排程重試與每日工作走同一個服務內的內部 route，不開常駐程序。決策見 ADR-0020（`docs/adr/0020-worker-internal-routes-cloud-scheduler.md`）。這一節的步驟由 MIL-92 當天執行。MIL-92 是 demo 切到 Cloud SQL 的票。MIL-92 之前沒有 PostgreSQL，job 無法執行。

### job 一覽

入口只有一個：`POST /api/internal/jobs/:name`。Cloud Scheduler 帶 Google 簽發的 OIDC token 呼叫。

| job | 內容 | demo 週期 | pilot 週期 |
|---|---|---|---|
| `drain-inbox` | 重試還沒處理完的 webhook 事件 | 每 60 分鐘 | 每 5 分鐘 |
| `drain-outbox` | 重試未完成的撤回與重寄 | 每 60 分鐘 | 每 5 分鐘 |
| `scan-timers` | 執行各線註冊的計時器 | 每日 00:10（台灣時間） | 每日 00:10（台灣時間） |

`anchor-audit` 與 `verify-audit` 由 MIL-88 加入。加入時照下方「建立排程」的格式多建兩個排程。

每次 job 的處理筆數有上限。`drain-inbox` 100 筆，`drain-outbox` 50 筆，`scan-timers` 500 項。回應的 `truncated` 為 `true` 時，剩下的留給下一次排程。

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

4. 把兩個驗證設定加到 Cloud Run 服務。這會部署新 revision：

   ```bash
   gcloud run services update rent-poc-demo --region asia-east1 --project "$PROJECT" \
     --update-env-vars "JOBS_OIDC_AUDIENCE=$URL,JOBS_OIDC_SERVICE_ACCOUNT=$SA"
   ```

   MIL-92 的部署 workflow 加入這兩個變數後，這一步得省略。

5. 建立三個排程。demo 的 `drain-*` 用 `0 * * * *`（每小時）：

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

### 註冊計時器（給各線）

計時器註冊處是 `src/lib/jobs/timers/index.ts`。資料在組織內的計時器實作 `OrgTimer`。資料在 `registry` 的計時器實作 `GlobalTimer`。再加一行 `timerRegistry.register(...)`。介面與規則見 `src/lib/jobs/timers/registry.ts`。

冪等鍵是主體、事件、日期。同一把鍵只執行一次，效果與冪等紀錄在同一個交易。

## 資料保存規則

- 資料庫由 Litestream 每秒複寫到 Cloud Storage。
- 實例啟動時從 `CURRENT` 還原，並寫到新路徑。還原失敗時用空資料庫啟動，並在 log 記下舊路徑。舊路徑不會被刪除，能手動救回。
- 換版時，並存期間寫入舊實例的資料會遺失。部署時不做 demo。
- 已簽 PDF 不持久保存。下載時向點點簽補抓，mock 模式重新產生。
- `runs/` 下的舊路徑不會自動清除。每次啟動約多出一份小型快照，費用可忽略。
