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
   gcloud run services update rent-poc-demo --region asia-east1 --project "$PROJECT" --min-instances=1
   ```

2. demo 結束後，改回去：

   ```bash
   gcloud run services update rent-poc-demo --region asia-east1 --project "$PROJECT" --min-instances=0
   ```

**注意：** `min-instances=1` 每天約 US$1.73。忘記改回去時，每月約 US$48。

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

回滾不會回復資料。新實例還原的是 `CURRENT` 指向的最新資料。

### 換 Basic Auth 密碼

1. 重跑 `deploy/first-deploy-wizard.sh`，在密碼步驟選擇換新密碼。
2. 在 GitHub Actions 手動執行 `ci-deploy`，讓新實例讀到新密碼。

### 清空 demo 資料

**警告：** 這個步驟會永久刪除 demo 資料。

1. 刪除 `CURRENT`。舊的複寫資料留在 `runs/` 下：

   ```bash
   gcloud storage rm "gs://<bucket>/CURRENT"
   ```

2. 在 GitHub Actions 手動執行 `ci-deploy`。新實例會用空資料庫啟動。

## 資料保存規則

- 資料庫由 Litestream 每秒複寫到 Cloud Storage。
- 實例啟動時從 `CURRENT` 還原，並寫到新路徑。還原失敗時用空資料庫啟動，並在 log 記下舊路徑。舊路徑不會被刪除，能手動救回。
- 換版時，並存期間寫入舊實例的資料會遺失。部署時不做 demo。
- 已簽 PDF 不持久保存。下載時向點點簽補抓，mock 模式重新產生。
- `runs/` 下的舊路徑不會自動清除。每次啟動約多出一份小型快照，費用可忽略。
