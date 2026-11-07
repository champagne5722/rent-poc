# CI/CD 與部署做法調研（Cloud Run、Cloudflare）

查詢日期：2026-11-07。信心標記：高＝官方頁面，中＝官方部落格或第三方，低＝推論。

## 結論

1. 此 repo 是 **public**（`gh repo view` 回傳 `isPrivate:false`），GitHub-hosted runner 免費且不限分鐘。Actions 費用不是選平台的因素。
2. Cloud Run 走「GitHub Actions + WIF + Artifact Registry + deploy-cloudrun@v3」最成熟。官方說 Cloud Run **不支援** WIF direct resource access，所以部署必須用 service account impersonation。
3. Cloudflare Workers 路線有兩個硬傷：Cloudflare 的 Actions 指南只有 API token（未查到 OIDC），且 Workers 文件未提及原生模組（`better-sqlite3`）與持久檔案系統，本專案的 SQLite 與 `data/` 寫檔很可能不能直接跑（推論）。Containers 可跑 Docker 但 Version URL 不支援 Containers Worker。
4. Next.js standalone 在 proxy 後方，`request.url` 的 origin 依原始碼會是 `http://<HOSTNAME>:<PORT>`，不是公開網址。`sign-link/route.ts:21` 必須改，用 `x-forwarded-host` 與 `x-forwarded-proto` 或固定的 `APP_ORIGIN` 環境變數，並須實測。
5. 需要先決定的風險：SQLite 寫在 `process.cwd()/data`，Cloud Run 檔案系統是記憶體內、實例停止即消失。demo 環境得接受資料每次重置，或另做持久化（本次未調研）。

## 專案現況（本機實測）

- public repo，分支 main。
- `next.config.ts` 沒有 `output`，要加 `output: 'standalone'`。
- `better-sqlite3` 13.0.1，`engines.node >= 22`，npm 套件內附 `prebuilds/` 含 `linux-x64`、`linux-arm64`、`linuxmusl-x64`、`linuxmusl-arm64`（本機 `ls node_modules/better-sqlite3/prebuilds` 實測）。
- `src/lib/pdf.ts:35` 讀 `assets/fonts/NotoSansTC-Regular.ttf`（7,090,820 bytes），`src/lib/design-theme-loader.ts:12` 讀 `DESIGN.md`，`src/lib/db.ts:20` 的 `DATA_DIR = process.cwd()/data`。三者都靠 `process.cwd()`。
- 本機 Node v26.5.0。

## 1. Cloud Run 的 GitHub Actions 標準做法

### 目前主版本（信心：高）

| Action | 主版本 | 來源 |
|---|---|---|
| `google-github-actions/auth` | v3 | README 範例 |
| `google-github-actions/deploy-cloudrun` | v3 | README 範例 |
| `google-github-actions/setup-gcloud` | v3 | README 範例，README 建議釘主版本 |
| `docker/build-push-action` | v7 | README 範例 |
| `docker/login-action` | v4 | build-push-action README 範例 |
| `docker/setup-buildx-action` | v4 | 同上 |
| `actions/checkout` | v6 | Cloudflare 與 Docker 文件範例 |
| `actions/setup-node` | v7 | README 範例 |

注意：setup-gcloud 的頁面同時出現 `auth@v2` 的舊範例，以 auth README 的 v3 為準。

### Docker build 與 push

流程：`auth`（要 `token_format: access_token`）→ `docker/login-action`（`username: oauth2accesstoken`，`password` 用 access_token）→ `docker/build-push-action`。access token 需要 service account email，所以這一段要用 impersonation（auth README：產生 access token 或 ID token 必須提供 service account）。

### 最小 workflow 骨架

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 24      # 與 Dockerfile 同一版；better-sqlite3 要求 >=22
          cache: npm
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm run lint
      - run: npm test

  deploy:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: check
    runs-on: ubuntu-latest
    concurrency: { group: deploy-demo, cancel-in-progress: false }
    environment: demo
    permissions:
      contents: read
      id-token: write
    env:
      REGION: asia-east1
      IMAGE: asia-east1-docker.pkg.dev/${{ vars.GCP_PROJECT }}/rent-poc/app
    steps:
      - uses: actions/checkout@v6
      - id: auth
        uses: google-github-actions/auth@v3
        with:
          workload_identity_provider: ${{ vars.WIF_PROVIDER }}   # projects/NUM/locations/global/workloadIdentityPools/POOL/providers/PROVIDER
          service_account: ${{ vars.DEPLOY_SA }}                  # deployer@PROJECT.iam.gserviceaccount.com
          token_format: access_token
      - uses: docker/login-action@v4
        with:
          registry: asia-east1-docker.pkg.dev
          username: oauth2accesstoken
          password: ${{ steps.auth.outputs.access_token }}
      - uses: docker/setup-buildx-action@v4
      - uses: docker/build-push-action@v7
        with:
          context: .
          push: true
          tags: ${{ env.IMAGE }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - uses: google-github-actions/deploy-cloudrun@v3
        with:
          service: rent-poc-demo
          region: asia-east1
          image: ${{ env.IMAGE }}:${{ github.sha }}
          env_vars: NODE_ENV=production
```

骨架是依各 README 範例組合而成，未實際執行（信心：中）。deploy-cloudrun 的 `region` 預設 `us-central1`，必須明確指定 `asia-east1`；輸出 `url`；`flags` 可傳額外 `gcloud run deploy` 旗標（官方 README）。

## 2. Workload Identity Federation

### 建立步驟（信心：高，來源 Google IAM 文件）

建立者需要 `roles/iam.workloadIdentityPoolAdmin`，並啟用 IAM、Resource Manager、Service Account Credentials、Security Token Service API。

```bash
gcloud iam workload-identity-pools create github \
  --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc rent-poc \
  --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com/" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository_owner_id=='<OWNER_ID>' && assertion.repository_id=='<REPO_ID>' && assertion.ref=='refs/heads/main'"
```

- Google 文件建議對映並使用數字的 `repository_id`、`repository_owner_id`，原因是名稱在 repo 刪除後可被他人重新註冊。文件範例的條件寫法用名稱（`assertion.repository_owner=='ORG'`、`&& assertion.ref=='refs/heads/main'`），同一文件也示範限定 main 分支。數字 ID 版本的條件是本文把兩段建議合併的寫法（推論）。`<OWNER_ID>`、`<REPO_ID>` 可用 `gh api repos/champagne5722/rent-poc --jq '.id, .owner.id'` 取得。
- GitHub 對所有組織共用同一個 issuer，所以條件為必填。auth README：「Always add an Attribute Condition」。
- `gcp-` 前綴保留，不可用在 pool 或 provider ID。provider ID 建立後不可改。
- **限定 main 的後果**：PR 的 preview 部署（若要做）token 的 `ref` 是 `refs/pull/N/merge`，會被條件擋下。要做 PR preview 需另開一個 provider，或把條件放寬並在 IAM 綁定層限制（推論）。

### 授權：direct 與 impersonation（信心：高）

- Google 文件預設建議 direct resource access（直接把角色授給 `principalSet://...`）。auth README 也標 Direct WIF 為 Preferred，token 壽命上限 10 分鐘。
- 但 Google「federated identity supported services」表明確寫：**Cloud Run 不支援 WIF direct resource access**，建議改用 service account impersonation。Artifact Registry、Cloud Build、Secret Manager 無已知限制。
- 因此本專案：**用 impersonation**（部署 Cloud Run 必須，docker login 的 access token 也需要 service account）。

```bash
gcloud iam service-accounts create rent-poc-deployer
gcloud iam service-accounts add-iam-policy-binding \
  rent-poc-deployer@PROJECT.iam.gserviceaccount.com \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository_id/<REPO_ID>"
```

### Service account 最小角色

| 角色 | 範圍 | 依據 |
|---|---|---|
| `roles/run.admin` | 專案或該 Cloud Run 服務 | deploy-cloudrun README 列為必要。是否有更小的可行角色：未查到（`roles/run.developer` 是否足夠未驗證） |
| `roles/iam.serviceAccountUser` | 在 Cloud Run 執行身分的 service account 上 | README 寫在 Compute Engine 預設 SA 上。建議另建專用 runtime SA，授權範圍縮到它（推論） |
| `roles/artifactregistry.writer` | 該 repository | docker login 的 SA 需要 push 權限（login-action README） |
| `roles/iam.workloadIdentityUser` | 在 deployer SA 上，給 WIF principalSet | Google 文件 |

### 費用（信心：高）

WIF 本身不收費：Google 的 IAM 定價頁寫「All use of Identity and Access Management API is free of charge」（`https://cloud.google.com/iam/pricing`）。該頁沒有單獨提到 WIF，WIF 屬 IAM（推論，依據同頁）。

## 3. Cloudflare 做法

### 版本與 token（信心：高）

- `cloudflare/wrangler-action@v4`，搭配 `actions/checkout@v6`。
- API token：權限選 **Edit Cloudflare Workers**，account 與 zone 範圍盡量縮小；另需 `CLOUDFLARE_ACCOUNT_ID` secret。
- **OIDC 免 token 做法：未查到。** Cloudflare 官方 Actions 指南只描述 API token；網頁搜尋也沒有找到 Wrangler OIDC 文件。
- Cloudflare 官方 Next.js 指南（`developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/`）現在首推 **vinext**，OpenNext 列為「既有 OpenNext 應用且 vinext 有相容缺口時」的備案。vinext 的成熟度與 `better-sqlite3` 相容性未查。

### OpenNext 指令（信心：高，來源 opennext.js.org/cloudflare/get-started）

```bash
npm install @opennextjs/cloudflare@latest
npm install --save-dev wrangler@latest
# package.json scripts：
#   "preview": "opennextjs-cloudflare build && opennextjs-cloudflare preview"
#   "deploy":  "opennextjs-cloudflare build && opennextjs-cloudflare deploy"
#   "upload":  "opennextjs-cloudflare build && opennextjs-cloudflare upload"
```

`wrangler.jsonc` 需 `main: ".open-next/worker.js"`、`assets` 指向 `.open-next/assets`、`compatibility_flags: ["nodejs_compat"]`、`compatibility_date >= 2024-09-23`。

### 與本專案的相容性（信心：低，推論）

- Workers 的 `node:fs` 是記憶體內虛擬檔案系統；`/bundle` 唯讀，`/tmp` 非持久且每個請求獨立（Cloudflare fs 文件）。本專案 `data/rent-poc.db` 與 `data/` 內合約檔案寫入，無法持久。
- 該 fs 文件未提及原生模組（native addon）。`better-sqlite3` 是 N-API 原生模組，Workers 是否能載入：**未查到**。不建議在沒有實測前選 Workers。
- 本專案需 D1 或 Durable Objects SQLite 等改寫才適合 Workers。改寫成本未評估。

### Containers 流程差異（信心：高）

- `npx wrangler deploy` 會上傳 Worker、用本機 Docker 建置並推送映像（**CI runner 需要 Docker**；GitHub-hosted ubuntu 已內建）。映像須為 `linux/amd64`。
- 需要 Workers Paid（USD 5/月）。含 25 GiB-hours 記憶體、375 vCPU-minutes、200 GB-hours 磁碟；超額 CPU USD 0.000020/vCPU-s、記憶體 USD 0.0000025/GiB-s。台灣出口流量 USD 0.05/GB，含 500 GB。
- 磁碟是否持久：未查到（頁面只說 Durable Object 的 `ctx.storage` 在容器重啟後保留）。
- Version URL 不支援 Containers Worker（見第 4 點）。

## 4. Preview 環境

### Cloud Run（信心：高）

```bash
gcloud run deploy rent-poc-demo --image IMAGE --no-traffic --tag pr-123
# URL：https://pr-123---rent-poc-demo-<hash>.a.run.app
gcloud run services update-traffic rent-poc-demo --remove-tags pr-123
```

- deploy-cloudrun@v3 的 `tag: pr-123` 與 `no_traffic: true` 即對應上述指令（README 未明列組合，屬依輸入欄位推論）。
- tag 名稱必須小寫。tag 數量上限：未查到。
- 費用：用 revision 層級最小實例時，tag 會替該 revision 配置最小實例而計費；用 service 層級最小實例則不會。本專案預設不設最小實例，則 tag 本身無額外固定費用（推論）。實例閒置時 request-based 計費，Tier 1 費率（asia-east1 屬 Tier 1）：每 vCPU-秒 USD 0.000024、每 GiB-秒 USD 0.0000025、每百萬請求 USD 0.40；免費額度 180,000 vCPU-秒、360,000 GiB-秒、200 萬請求/月（`cloud.google.com/run/pricing`，抓取後以腳本解析，信心：中高）。
- 清理：PR 關閉時跑 `--remove-tags`；舊 revision 與映像用 Artifact Registry cleanup policy 清（`gcloud artifacts repositories set-cleanup-policies REPO --location=asia-east1 --policy=policy.json --no-dry-run`，先加 `--dry-run` 測，政策約一天內生效）。Artifact Registry 儲存：前 0.5 GiB 免費，之後約 USD 0.000136986 / GiB-小時（約 USD 0.10/GiB-月，換算為推論）。
- 注意：tag revision 跟正式共用同一個 service 的環境變數與 SQLite 實例檔案系統；每個 revision 實例各有獨立記憶體內檔案系統（容器合約文件）。

### Cloudflare（信心：高）

- 文件現在叫 **Version URLs**（舊稱 preview URLs），格式 `<version-prefix>-<worker>.<subdomain>.workers.dev`；別名 `npx wrangler versions upload --preview-alias pr-123` 得到 `pr-123-<worker>.<subdomain>.workers.dev`。別名只能在 upload 時設定；只留最近 1000 個別名；別名加 Worker 名稱總長 ≤ 63。
- Version URL 預設**公開**，要保護用 Cloudflare Access。
- 限制：Durable Object Workers（含 Containers）沒有 Version URL；只支援 `workers.dev`。
- 回滾見第 8 點。

### 點點簽 webhook 與 preview（建議）

- 現況：未設 `DOTTEDSIGN_CLIENT_ID` / `DOTTEDSIGN_CLIENT_SECRET` 時 `isMockMode()` 為 true，送簽回假 task_id，狀態靠 `/api/mock/advance` 推進（`src/lib/dottedsign.ts:7-17`、`:108`）。
- 建議：**preview 環境一律不設這兩個變數，進 mock 模式**。webhook URL 只有一個，指向 demo 環境（或本機 ngrok）；preview 不收 webhook，不會互相搶。
- demo 環境若要接 sandbox 實際簽署，才設 secrets 並把唯一的 webhook URL 指到 demo。這一步需使用者在點點簽後台操作，本文不改任何設定。
- 備註：webhook 只有一個 URL 是任務給定的前提，點點簽 API 文件本次未重新查證。

### Fork PR 與 secrets（信心：高）

- `pull_request`：fork 來的 PR 不傳 secrets（`GITHUB_TOKEN` 除外），且 `GITHUB_TOKEN` 唯讀；首次貢獻者的 workflow 可能需維護者核准。
- `pull_request_target`：在 base repo 預設分支的 context 執行，可拿 secrets；官方警告不要用它建置或執行 PR 的程式碼（會導致 cache poisoning、secret 外洩）。
- 建議：PR 只跑 `pull_request` 的 vitest、tsc、eslint，不需要任何 secret。部署只在 `push` 到 main 時發生，且 `deploy` job 掛 `environment` 保護。不要使用 `pull_request_target`。`permissions` 預設設 `contents: read`。
- 若要對同 repo 的 PR 做 Cloud Run preview，須在 job 條件加 `github.event.pull_request.head.repo.full_name == github.repository`（推論，用於排除 fork）。

## 5. GitHub Actions 免費額度與用量

來源：GitHub Docs 計費頁與 changelog（信心：高）。

- **Public repo**：標準 GitHub-hosted runner 免費；`ubuntu-latest` 為 4 vCPU、16 GB RAM（private 為 2 vCPU、8 GB）。Self-hosted 免費。Larger runner 即使 public 也計費。
- **Private repo 免費額度**（每月）：Free 方案 USD 12 運算額度、500 MB artifact 儲存；Pro 為 USD 18、1 GB；Team 為 USD 18、2 GB。每個 repo 另有 10 GB cache。額度以金額而非分鐘數表示。
- **單價**：Linux 2-core x64 USD 0.006/分鐘（arm64 USD 0.005）。USD 12 ÷ 0.006 = 2,000 分鐘（換算為推論；官方頁面只給 USD 300 約 50,000 Linux 2-core 分鐘的例子）。
- **超額**：沒有付款方式則停止；有付款方式則依單價計費；90% 與 100% 會寄信通知，可設 budget。
- **2026 變動**：2025-12-16 changelog 宣布 2026-01-01 起 hosted runner 價格最多降 39%，免費分鐘配額不變。原訂 2026-03-01 對 self-hosted 收每分鐘 USD 0.002 平台費，GitHub 已「postponing ... to take time to re-evaluate」，changelog 沒給新日期。第三方稱至 2026 年中尚未生效，GitHub 官方頁面未見後續公告（信心：中）。本專案不用 self-hosted，不受影響。

### 本專案用量估算

以下「每次分鐘數」為**推論**，沒有實際執行 build。依據：305 個 vitest 測試、Next 16 Turbopack 建置、`better-sqlite3` 13 套件內附 prebuild，`npm ci` 不需編譯（本機確認 `prebuilds/` 內含 linux 二進位，13.0.0 release notes 說移除 `prebuild-install`、prebuilt binaries 隨套件出貨），所以 CI 不會因原生編譯變慢。npm 下載時間靠 `setup-node` 的 `cache: npm` 縮短。無公開資料可直接換算 npm ci 秒數，下表為估計值。

| 情境 | 每次分鐘（推論） | 每月次數 | 月用量 | public 費用 | 若為 private（Free 方案） |
|---|---|---|---|---|---|
| PR 檢查（npm ci、tsc、lint、test） | 3 | 40 | 120 | 0 | 120 × 0.006 = USD 0.72 |
| push main（檢查加 build 加 deploy） | 8（含 Docker build，快取命中約 5） | 20 | 160 | 0 | USD 0.96 |
| 合計 | | | 280 | 0 | 約 USD 1.7，遠低於 USD 12 額度 |

高估情境（每月 100 次 PR 檢查加 60 次 main，各 +50%）仍約 USD 5。結論：就算轉 private，Free 方案的 USD 12 額度也夠。

## 6. Next.js 16 Docker 最佳實務

### 官方依據（信心：高）

- `17-deploying.md`：Docker 範例為 `examples/with-docker`（standalone）。
- `output.md`：`output: 'standalone'` 產生 `.next/standalone`，含 `server.js`，**不複製** `public` 與 `.next/static`，要手動 `cp`（或在 Dockerfile 中 COPY）；`PORT`、`HOSTNAME` 環境變數控制監聽位址。
- `self-hosting.md`：建議前面放 reverse proxy；streaming 需關閉 proxy buffering；SIGTERM 可處理。

### with-docker 範例 Dockerfile（信心：中高）

官方範例 `examples/with-docker/Dockerfile`：三階段（dependencies、builder、runner），`ARG NODE_VERSION=24.13.0-slim`，runner 設 `NODE_ENV=production`、`PORT=3000`、`HOSTNAME=0.0.0.0`，以 `node` 使用者執行 `node server.js`。（WebFetch 摘要，未取得逐字內容。）

### better-sqlite3 與 standalone

- 此版 Next.js 文件的 `serverExternalPackages` 預設清單**包含 `better-sqlite3`**（本機 `node_modules/next/dist/docs/.../serverExternalPackages.md` 第 47 行）。所以不用手動加，它會以原生 `require` 載入，由檔案追蹤複製進 `node_modules`。
- `.node` 檔是否被追蹤帶入：**須實測**。依據：nft 追蹤 `require`/`fs` 使用；`better-sqlite3` 13 的 `lib/` 以 `./linuxmusl-x64` 等條件匯出載入對應 `prebuilds/*.node`。建議 build 後檢查 `.next/standalone/node_modules/better-sqlite3/prebuilds/linux-x64.node` 是否存在，不存在就用 `outputFileTracingIncludes` 補（推論）。
- 字型 `assets/fonts/*.ttf`：`path.join(process.cwd(), 'assets/fonts/...')` 屬動態路徑，nft 不一定能靜態解出。**建議直接寫 `outputFileTracingIncludes`**（`output.md` 明確提供此選項，key 為 route glob，value 從專案根目錄解析）。同理 `DESIGN.md`。信心：低，須實測。

```ts
// next.config.ts（建議）
const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingIncludes: {
    '/*': ['./assets/fonts/**/*', './DESIGN.md'],
  },
  // 既有 distDir、turbopack 設定保留
};
```

### Base image 選擇

- better-sqlite3 13.0.1 套件內附 `linux-x64`、`linux-arm64`、`linuxmusl-x64`、`linuxmusl-arm64` 預建檔，所以 alpine（musl）可行（本機實測 `prebuilds/` 目錄；官方 README 對 musl 無說明）。`engines.node >= 22`。
- v12.10.0 加入 Node 26 prebuild 並移除 EOL 的 Node 20、23；v13.0.0 改用 Node-API，release notes 說預建檔「理論上」跨 Node 版本可用。Node 26 在 v13 是否有問題：release notes 未提，本機 Node v26.5.0 開發中可用（推論，本機 `npm test` 305 測試為使用者既有環境）。
- 建議 `node:24-slim`（glibc，與官方範例同一系列），不用 alpine，原因：sharp 與其他套件在 musl 上常有記憶體配置問題，`self-hosting.md` 提到 glibc 上的 sharp 需另外設定（反方向仍需顧）。這一點取捨屬推論。distroless：未查，且 `node:*-slim` 內有 shell 方便除錯，不建議為此多付複雜度。
- 最新 better-sqlite3：v13.0.3（2026-08-05，`gh api releases`）。

### Dockerfile 骨架（依官方範例調整，未實際建置）

```dockerfile
ARG NODE_VERSION=24-slim
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM node:${NODE_VERSION} AS build
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION} AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 8080
CMD ["node", "server.js"]
```

- Cloud Run 會注入 `PORT`（預設 8080），`server.js` 讀 `PORT`，不用寫死。
- 注意：build 階段需要 `devDependencies`（TypeScript、型別），所以 deps 階段用完整 `npm ci`。

### 健康檢查

- Next.js 沒有內建 health endpoint；建議新增 `src/app/api/health/route.ts` 回 200（可含 `SELECT 1` 驗證 SQLite 可開檔，推論）。
- Cloud Run 沒設 probe 時，預設為 TCP startup probe：`timeoutSeconds: 240`、`periodSeconds: 240`、`failureThreshold: 1`；實例須在 4 分鐘內開始監聽（Cloud Run healthchecks 與 container contract 文件）。自訂 HTTP probe 範例：`--startup-probe httpGet.path=/api/health,httpGet.port=8080,periodSeconds=5,failureThreshold=6`。
- Dockerfile 不需要 `HEALTHCHECK`：Cloud Run 不使用它（未在文件中查到使用，推論）。

### `request.url` 的 origin（信心：中，須實測）

- 依本專案 `node_modules/next/dist/server/next-server.js:1266`：`initUrl = fetchHostname && port ? `${protocol}://${fetchHostname}:${port}${req.url}` : ...`；`next-request.js:94` 以 `initURL` 為 NextRequest 的 base。其中 `protocol` 看 `x-forwarded-proto` 是否含 https。
- 在 standalone `server.js` 下 `fetchHostname` 來自 `HOSTNAME`（Dockerfile 設 `0.0.0.0`），`port` 來自 `PORT`。所以 `new URL(request.url).origin` 很可能是 `https://0.0.0.0:8080` 這類內部位址，不是 `*.run.app` 公開網址。這是讀原始碼的推論，**須實測**。
- `base-server.js:574-576` 會在缺少時補 `x-forwarded-host`（取自 Host header）與 `x-forwarded-proto`。Cloud Run 前面的 Google Front End 是否送 `x-forwarded-host`：未查到；Cloud Run container contract 文件沒提 X-Forwarded-Proto。
- 建議做法：新增 `APP_ORIGIN` 環境變數為首選，缺值時退回 `x-forwarded-proto` + `host`。需要改 `src/app/api/contracts/[id]/sign-link/route.ts:21`（本次不改程式碼）。
- 另：Server Actions 的 CSRF 檢查比對 Origin 與 `Host`（或 `X-Forwarded-Host`），自訂網域時可能需設 `serverActions.allowedOrigins`（`server-actions.md`）。

## 7. 映像建置快取：`type=gha`（信心：高，Docker 官方文件）

```yaml
cache-from: type=gha
cache-to: type=gha,mode=max
```

- 只在 workflow 內可用（需要 `ACTIONS_RESULTS_URL`、`ACTIONS_RUNTIME_TOKEN`）。
- 只支援 GitHub Cache service API v2；v1 已於 2025-04-15 停用。需要 Buildx ≥ 0.21.0、BuildKit ≥ 0.20.0。
- 寫入需要寫入權限；`pull_request_target`、`issue_comment` 預設只有唯讀，匯出會失敗；唯讀 workflow 保留 `cache-from` 並省略 `cache-to`。對不信任的 workflow 開寫入有 cache poisoning 風險。
- BuildKit 的 cache mount（如上面 Dockerfile 的 `--mount=type=cache`）不會存進 GHA cache；官方建議 `reproducible-containers/buildkit-cache-dance`。所以 `npm ci` 的 cache mount 在 CI 無效，層快取（`COPY package*.json` 加 `npm ci`）才是有效的。
- 每個 repo 10 GB cache 額度（GitHub 計費頁）；Docker 頁面未提容量上限。`mode=max` 會存所有階段，容易吃滿 10 GB，須觀察（推論）。

## 8. 防誤部署與回滾

### Cloud Run（信心：高）

```bash
gcloud run revisions list --service rent-poc-demo --region asia-east1
gcloud run services update-traffic rent-poc-demo --region asia-east1 --to-revisions REVISION=100
```

官方警告：切換立刻生效，不會重跑部署健康檢查，也不驗證外部相依。

### Workers（信心：高）

`wrangler rollback [version-id]`，或 Dashboard 的 Deployments。只能回滾到最近 100 個版本。限制：兩版本間若有 Durable Object class 變更（`exports` 或 `migrations`）就不能回滾；綁定的 R2、KV、queue 已不存在也不行；連接的資源不會被回滾。

### 防誤部署建議（推論）

- `deploy` job 只在 `push` 到 `main` 觸發，`needs: check`，`environment: demo`，`concurrency` 序列化。
- WIF 條件限定 `refs/heads/main`，PR 與 fork 無法取得部署憑證。
- 映像標籤用 `github.sha`，不用 `latest`，回滾才有明確目標。
- repo 設定（branch protection、environment reviewers）本次不動，需要使用者決定。

## 未查到或須實測清單

| 項目 | 狀態 |
|---|---|
| Cloudflare Wrangler OIDC 免 token | 未查到 |
| Workers 載入 `better-sqlite3` 原生模組 | 未查到，推論不可行 |
| Containers 磁碟是否持久 | 未查到 |
| Cloud Run tag 數量上限 | 未查到 |
| `roles/run.admin` 的更小替代角色 | 未查到 |
| standalone 追蹤 `.node` 檔、字型、`DESIGN.md` | 須實測（`next build` 後檢查 `.next/standalone`） |
| Cloud Run 上 `request.url` origin、是否送 `x-forwarded-host` | 須實測 |
| vinext 與本專案的相容性 | 未查 |
| Docker build 與 Actions 各步驟實際分鐘數 | 未實測（只是估計） |
| SQLite 在 Cloud Run 的持久化方案 | 未調研 |

## 來源（查詢日期 2026-11-07）

- GitHub `gh repo view champagne5722/rent-poc`（isPrivate:false）
- https://github.com/google-github-actions/auth
- https://github.com/google-github-actions/deploy-cloudrun
- https://github.com/google-github-actions/setup-gcloud
- https://github.com/docker/build-push-action
- https://github.com/docker/login-action
- https://docs.docker.com/build/ci/github-actions/cache/
- https://github.com/actions/setup-node
- https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines
- https://docs.cloud.google.com/iam/docs/best-practices-for-using-workload-identity-federation
- https://docs.cloud.google.com/iam/docs/federated-identity-supported-services
- https://cloud.google.com/iam/pricing
- https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration
- https://docs.cloud.google.com/run/docs/configuring/healthchecks
- https://docs.cloud.google.com/run/docs/reference/container-contract
- https://cloud.google.com/run/pricing
- https://cloud.google.com/artifact-registry/pricing
- https://docs.cloud.google.com/artifact-registry/docs/repositories/cleanup-policy
- https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/
- https://opennext.js.org/cloudflare/get-started
- https://developers.cloudflare.com/containers/get-started/
- https://developers.cloudflare.com/containers/pricing/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/configuration/previews/
- https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/
- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://docs.github.com/en/billing/reference/actions-runner-pricing
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- https://docs.github.com/en/actions/reference/security/secure-use
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/
- https://github.com/WiseLibs/better-sqlite3/releases
- https://github.com/vercel/next.js/tree/canary/examples/with-docker
- 本機：`node_modules/next/dist/docs/01-app/01-getting-started/17-deploying.md`、`.../05-config/01-next-config-js/output.md`、`.../serverExternalPackages.md`、`.../02-guides/self-hosting.md`、`node_modules/next/dist/server/next-server.js`、`base-server.js`、`web/spec-extension/adapters/next-request.js`、`node_modules/better-sqlite3/package.json`
