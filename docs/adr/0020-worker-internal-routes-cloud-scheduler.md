---
status: accepted
---

# worker 用內部 route 加 Cloud Scheduler，不開常駐程序

ADR-0016 把 worker 的觸發方式留給 A 線。Cloud Run 的 `min-instances=0` 沒有常駐程序，遷移後的 request-based 計費也不給回應之後的 CPU。決議：worker 是同一個 Next.js 服務內的內部 route，由 Cloud Scheduler 帶 OIDC token 觸發。正常路徑在原請求內處理，排程只負責重試與定期工作。本決議修訂架構 2.5 的「背景 worker 是獨立程序」。

## 決議內容

1. **入口。** 內部 route 只有一個形狀：`POST /api/internal/jobs/:name`。每個 job 是一個函式，共用 `src/lib` 的領域程式碼。

2. **呼叫者驗證。** route 必須驗證 Google 簽發的 OIDC token，包含簽章、`aud` 與 service account。`src/proxy.ts` 放行這個路徑，比照 ADR-0011 的 webhook。驗證失敗回 401，不得執行 job。

3. **第一版的 job。**

   | job | 內容 | demo 週期 | pilot 週期 |
   |---|---|---|---|
   | `drain-inbox` | 重試未處理的 inbox 列 | 每 60 分鐘 | 每 5 分鐘 |
   | `drain-outbox` | 重試未完成的 outbox 列 | 每 60 分鐘 | 每 5 分鐘 |
   | `scan-timers` | ADR-0016 決議 18 的 7 條計時器 | 每日 | 每日 |
   | `anchor-audit` | 稽核鏈錨定（ADR-0019） | 每日 | 每日 |
   | `verify-audit` | `verifyChain()`（ADR-0019） | 每日 | 每日 |

   計時器由 C、E 線註冊，A 線只交註冊與執行機制。週期是排程設定，不寫在程式碼。

4. **demo 的重試週期較長。** 排程每次都會喚醒 Cloud Run 與 Neon。正常路徑已在原請求內處理，所以重試不用頻繁。

5. **正常路徑在原請求內處理。** 不用 `after()`，因為 request-based 計費在回應之後不保證有 CPU。

   | 路徑 | 第一個交易 | 同一請求內的下一步 | 失敗時 |
   |---|---|---|---|
   | 點點簽 webhook | 寫 `control.inbox_messages` | 處理這一列，一列一個交易 | 仍回 2xx，留給 `drain-inbox` |
   | 對外呼叫 | 業務資料與 outbox 列同交易 | 提交後派送這一列 | 依下方規則處理 |

6. **outbox 的重試規則。** 點點簽 API 文件查不到建立任務的冪等鍵（`dottedsign-api` 搜尋 `idempot` 無結果）。所以重試可能建立第二個任務。

   | 動作 | 自動重試 | 失敗時 |
   |---|---|---|
   | 建立簽署任務 | 否 | outbox 列轉失敗，合約留在草稿，畫面顯示原因，由使用者重新送簽 |
   | 撤回、重寄、文件保存 | 是，最多 5 次 | 轉人工處理清單，比照 ADR-0014 決議 15 |

7. **逐組織執行。** job 從 `control` 取得任務與 `org_id`，再逐組織 `set_config`（ADR-0012 決議 5）。一個任務一個交易，一個任務失敗不影響其他任務。認領用 `FOR UPDATE SKIP LOCKED`。冪等鍵是主體、事件與日期（ADR-0016 決議 18）。

8. **一次處理的量有上限。** 每次 job 處理固定筆數後回應，剩下的留給下一次排程。

9. **inbox 只存標準欄位。** `control` 不掛組織 RLS，所以 inbox 只存標準化的簽署事件與原始 body 的 SHA-256，不存原始 body。去重鍵是服務商加 body 雜湊。ADR-0010 決議 9 的 email 守門不變。路由列還沒寫入時，該列留到下次重試。

## Considered Options

- **獨立的 Cloud Run 服務常駐（架構 2.5）：** 沒有請求逾時，也能單獨設固定出口 IP。但 `min-instances=1` 每月約 US$48（`docs/deployment.md`），第一版也沒有長任務。
- **Cloud Run Jobs：** 不受請求逾時限制，但多一個部署單位。也不解決正常路徑要即時處理的問題。
- **Next.js 的 `after()`：** 程式碼最少，但回應之後不保證有 CPU。

## Consequences

- **固定出口 IP：** pilot 要接商工登記 API（MIL-49）時需要 Cloud NAT。第一版不做。NAT 接在整個服務上，網頁請求的對外流量也會經過它。屆時再評估是否拆出 worker 服務。
- 長任務受 Cloud Run 請求逾時限制，所以大批工作要分批。
- 建立簽署任務失敗時，服務商可能已有孤兒任務。這與現況相同（MIL-37 第 5.2 節），差別是 outbox 列留下了紀錄。
- demo 的重試延遲最長 60 分鐘。正常路徑失敗才會遇到。
- Neon 閒置多久才暫停沒有查證，所以 demo 週期是保守值。
- 網頁與 worker 共用連線池。job 的筆數上限必須低於連線池能負擔的量。
- Cloud Scheduler 的費用沒有查證。

## 編號對應

架構文件第 8 節沒有對應的候選 ADR。D 線 spec 若需要 ADR，編號從 0021 起。
