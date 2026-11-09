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
| `DOTTEDSIGN_VERIFY_SIGNERS` | 目前 workflow 不注入，正式環境上線前手動設定 | 設為 `1` 時，送簽替每位簽署人帶 `email` 驗證。未設定時不送。sandbox 停用驗證，帶了會回 400428，所以 demo 必須維持未設定。正式環境的 `email` 驗證尚未實測。這個變數同時是「正式環境」的判定：設為 `1` 且 C 線的 `practiceRegistry` 真實 adapter 尚未註冊時，要求執業人員簽章的合約（包租、承租人是包租業者、居間）一律無法送簽（ADR-0021）。未設定時用 seed 假資料。設為 `1` 時，綁定未經法務審閱範本的合約也一律無法送簽（MIL-73、P0-10 AC5）。現有的租賃範本 v2 是未審閱，所以上線前要先完成範本審閱（MIL-48）並把範本登錄的 `legalReviewed` 改為 `true`，否則正式環境任何合約都送不出去 |
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

## 資料保存規則

- 資料庫由 Litestream 每秒複寫到 Cloud Storage。
- 實例啟動時從 `CURRENT` 還原，並寫到新路徑。還原失敗時用空資料庫啟動，並在 log 記下舊路徑。舊路徑不會被刪除，能手動救回。
- 換版時，並存期間寫入舊實例的資料會遺失。部署時不做 demo。
- 已簽 PDF 不持久保存。下載時向點點簽補抓，mock 模式重新產生。
- `runs/` 下的舊路徑不會自動清除。每次啟動約多出一份小型快照，費用可忽略。
