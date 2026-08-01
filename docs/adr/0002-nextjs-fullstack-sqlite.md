# Next.js 全端單一專案 ＋ SQLite

點點簽的 OAuth token 交換必須在伺服器端執行、簽署狀態靠 webhook 回報，因此「純前端無後端」不可行。決定用 **Next.js 單一專案**承載頁面與 API routes（token 交換、送簽 proxy、webhook 接收），儲存用 **SQLite**（單檔、零安裝、schema 可讀），將 PoC 的維護與交接成本降到最低。開發期以 cloudflared／ngrok 開通道讓點點簽 webhook 打得到本機。

## Considered Options

- Vite React SPA ＋ 獨立 Express 後端：架構更像正式產品，但要管兩個服務與 CORS，對 PoC 無益。
- 無後端、前端直呼點點簽：不可行（secret 外洩、無法接 webhook）。
