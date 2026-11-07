---
status: accepted
---

# 部署到 Cloud Run asia-east1，SQLite 階段用 Litestream

demo 環境需要公開網址，點點簽 webhook 不再靠 ngrok。決議部署到 GCP Cloud Run（asia-east1），用 GitHub Actions 加 Workload Identity Federation 部署，repo 內不存金鑰。原因是 Cloud Run 能直接跑現有 Docker 映像，資料能留在台灣，之後能用 Cloud NAT 取得固定出口 IP。demo 預估每月約 US$0.4。評估全文見 `docs/research/hosting-evaluation.md`。

PostgreSQL 遷移前，SQLite 放在容器內，用 Litestream 複寫到 Cloud Storage。這個階段只服務 demo，只放測試資料。

## 決議內容

1. **計費與實例數。** `--no-cpu-throttling`（instance-based）、`min-instances=0`、`max-instances=1`。request-based 下 Litestream 在請求之間拿不到 CPU，寫入要等到下一個請求才會複寫。
2. **每次啟動都複寫到新路徑。** `max-instances` 能短暫超過，換版時新舊實例會並存。多個程序寫到同一路徑可能讓複寫資料無法還原，所以每次啟動都寫到 `runs/<時間>-<亂數>`，由 `CURRENT` 物件指向最新一份。新路徑確定能還原後才移動 `CURRENT`。實作在 `deploy/entrypoint.mjs`。
3. **存取保護用應用層 Basic Auth。** Cloud Run 直連 IAP 無法放行單一路徑，會擋住點點簽 webhook。`src/proxy.ts` 放行 webhook 與健康檢查。webhook 由 HMAC 驗簽保護。Cloud Run 上沒有設定密碼時回 503，不得變成公開開放。
4. **已簽 PDF 不持久保存。** 檔案留在容器內，重啟後消失。下載時由 `serveContractFile` 向點點簽補抓。
5. **PR 不做 preview 部署。** 每個 revision 都是獨立的 SQLite 寫入端。

## Considered Options

- Cloudflare Workers 加 OpenNext：`better-sqlite3` 不能用，必須先完成資料層遷移，也要升級 Next.js。
- Cloudflare Containers：能跑映像，但磁碟同樣暫存，不能指定地區，沒有查到固定出口 IP 方案。每月至少 US$5。
- Compute Engine 小型 VM：有持久磁碟，換版不會遺失資料，但每月約 US$20，還要自管 TLS、更新與部署。PostgreSQL 遷移後這套部署方式要重做。
- Cloud Run 掛 GCS FUSE 或 NFS：不支援檔案鎖定，不得跑 SQLite。

## Consequences

- 換版時，並存期間寫入舊實例的資料會遺失。pilot 不得使用這個配置，必須先完成 PostgreSQL 遷移。
- 系統必須用 `APP_ORIGIN` 組出對外網址。standalone 在反向代理後方時，`request.url` 的 origin 是 `0.0.0.0:<port>`。
- 遷移 PostgreSQL 後移除 `deploy/entrypoint.mjs` 與 Litestream，改回 request-based 計費，並解除 `max-instances=1`。

## 編號對應

本編號與架構文件第 8 節的候選 ADR-0011（不持有款項與入帳確認轉接層）不同。候選 ADR 尚未落檔，正式落檔時取下一個可用編號。
