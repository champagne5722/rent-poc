# Rent PoC — 電子簽約物業管理系統

驗證「房東建立物件與租賃合約 → 設定簽署區域 → 透過點點簽（DottedSign）完成雙方電子簽約」核心流程的 PoC。

- 領域詞彙表：[GLOSSARY.md](./GLOSSARY.md)
- 狀態機與資料模型：[docs/domain-model.md](./docs/domain-model.md)
- 架構決策：[docs/adr/](./docs/adr/)
- 點點簽整合筆記（含踩坑與真接檢查清單）：[docs/dottedsign-integration.md](./docs/dottedsign-integration.md)
- 已知簡化清單：[docs/known-simplifications.md](./docs/known-simplifications.md)
- demo 環境部署：[docs/deployment.md](./docs/deployment.md)

## 技術棧

Next.js（App Router）＋ React ＋ Ant Design ＋ PostgreSQL（pg，測試用 PGlite）＋ pdf-lib（合約 PDF 產生）＋ pdf.js（預覽與簽署區域拖放）。

## 啟動

需 Node.js ≥ 20（建議 26）與 Docker（跑本機 PostgreSQL）。

```bash
npm install
# 本機 PostgreSQL。版本與 CI、Cloud SQL 相同
docker run --name rentpoc-pg -d -p 5432:5432 -e POSTGRES_PASSWORD=pw postgres:18
# 第一次 migration 必須用管理者，它建立 app_owner 與 app_rw 兩個角色
DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres npm run db:migrate
docker exec rentpoc-pg psql -U postgres -c "ALTER ROLE app_rw PASSWORD 'pw'"
# 示範資料（五個帳號、一個物件），能重複執行
DATABASE_URL=postgres://app_rw:pw@localhost:5432/postgres npm run db:seed
# 應用程式用 app_rw 連線
echo 'DATABASE_URL=postgres://app_rw:pw@localhost:5432/postgres' >> .env.local
npm run dev
# 打開 http://localhost:3000
```

登入用 email 驗證碼，驗證碼顯示在 http://localhost:3000/demo/otp。示範帳號的 email 與環境變數見 [docs/deployment.md](./docs/deployment.md) 的「示範資料」。

未設定點點簽金鑰時以 **mock 模式**運作：送簽不會真的呼叫點點簽，合約頁會出現「模擬乙方簽署／拒簽／甲方完成」按鈕推進狀態，可完整走過流程。

## 真接點點簽 sandbox

1. 到[點點簽開發者後台](https://developer.dottedsign.com/)建立 Application，取得 client id/secret。
2. `cp .env.example .env.local` 並填入金鑰。
3. Webhook 需要公開 URL：`cloudflared tunnel --url http://localhost:3000`，把 `https://<tunnel>/api/webhooks/dottedsign` 填到 Application 設定。
4. 重啟 dev server；詳細驗證步驟見[整合筆記](./docs/dottedsign-integration.md)的檢查清單。

## Demo 流程

物件頁「新增物件」→「建立合約」→ 填欄位、儲存 → 右側預覽上為甲／乙方各拖放簽名框 → 送簽 → 乙方（租客）先簽、甲方（房東）後簽 → 完成後可下載已簽 PDF。例外流程：乙方拒簽、甲方撤回，兩者皆可「複製為新草稿」重走。

資料在 PostgreSQL。要重置，刪掉容器重建，再重跑 `db:migrate` 與 `db:seed`。文件檔案存在 `data/files/`（已 gitignore）。
