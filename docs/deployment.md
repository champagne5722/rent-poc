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
| `K_SERVICE` | Cloud Run 自動注入 | `src/proxy.ts` 用來判斷是否必須要求密碼 |

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

## 資料保存規則

- 資料庫由 Litestream 每秒複寫到 Cloud Storage。
- 實例啟動時從 `CURRENT` 還原，並寫到新路徑。還原失敗時用空資料庫啟動，並在 log 記下舊路徑。舊路徑不會被刪除，能手動救回。
- 換版時，並存期間寫入舊實例的資料會遺失。部署時不做 demo。
- 已簽 PDF 不持久保存。下載時向點點簽補抓，mock 模式重新產生。
- `runs/` 下的舊路徑不會自動清除。每次啟動約多出一份小型快照，費用可忽略。
