# Rent PoC — 電子簽約物業管理系統

驗證「房東建立物件與租賃合約 → 設定簽署區域 → 透過點點簽（DottedSign）完成雙方電子簽約」核心流程的 PoC。

- 領域詞彙表：[CONTEXT.md](./CONTEXT.md)
- 狀態機與資料模型：[docs/domain-model.md](./docs/domain-model.md)
- 架構決策：[docs/adr/](./docs/adr/)
- 點點簽整合筆記（含踩坑與真接檢查清單）：[docs/dottedsign-integration.md](./docs/dottedsign-integration.md)
- 已知簡化清單：[docs/known-simplifications.md](./docs/known-simplifications.md)

## 技術棧

Next.js（App Router）＋ React ＋ Ant Design ＋ SQLite（better-sqlite3）＋ pdf-lib（合約 PDF 產生）＋ pdf.js（預覽與簽署區域拖放）。

## 啟動

需 Node.js ≥ 20。

```bash
npm install
npm run dev
# 打開 http://localhost:3000
```

未設定點點簽金鑰時以 **mock 模式**運作：送簽不會真的呼叫點點簽，合約頁會出現「模擬乙方簽署／拒簽／甲方完成」按鈕推進狀態，可完整走過流程。

## 真接點點簽 sandbox

1. 到[點點簽開發者後台](https://developer.dottedsign.com/)建立 Application，取得 client id/secret。
2. `cp .env.example .env.local` 並填入金鑰。
3. Webhook 需要公開 URL：`cloudflared tunnel --url http://localhost:3000`，把 `https://<tunnel>/api/webhooks/dottedsign` 填到 Application 設定。
4. 重啟 dev server；詳細驗證步驟見[整合筆記](./docs/dottedsign-integration.md)的檢查清單。

## Demo 流程

物件頁「新增物件」→「建立合約」→ 填欄位、儲存 → 右側預覽上為甲／乙方各拖放簽名框 → 送簽 → 乙方（租客）先簽、甲方（房東）後簽 → 完成後可下載已簽 PDF。例外流程：乙方拒簽、甲方撤回，兩者皆可「複製為新草稿」重走。

資料存在 `data/rent-poc.db`（已 gitignore），刪除即重置。
