# 點點簽（DottedSign）整合筆記

給接手開發團隊的整合備忘。程式碼入口：`src/lib/dottedsign.ts`（API client）、`src/app/api/webhooks/dottedsign/route.ts`（webhook 接收）。文件來源：<https://developer.dottedsign.com/v1.0-sandbox/>（AI 可讀清單：`/v1.0-sandbox/llms.txt`）。

## 認證

- **OAuth2 Client Credentials flow**（伺服器對伺服器）。
- Token endpoint：`POST https://api.sandbox.dottedsign.com/v1/oauth/token`，**JSON body**（非 form-encoded）：`{ grant_type: "client_credentials", client_id, client_secret, scope }`。
- scope 以空格分隔。本專案用到：
  - `sign_tasks.general.write`（建立簽署任務）
  - `sign_tasks.general.read`（查詢）
  - `sign_tasks.management.write`（撤回 void）
  - `sign_tasks.download.read`（下載已簽文件）
- 回應含 `access_token` / `expires_in`（實測範例為 172800 秒＝48 小時）。`src/lib/dottedsign.ts` 有做過期前 60 秒的快取換發。
- **token 交換必須在伺服器端**——client secret 不能進前端，這也是本專案必須有後端的原因之一（另一個是 webhook）。

## 建立簽署任務

`POST /v1/sign_tasks`，重點欄位：

- `base64_file`：合約 PDF 的 base64 字串（我們自產 PDF，不用點點簽範本）。
- `file_name`：**不得含 `. " * : < > ? / \ | ~ # % & { }` 開頭或特殊字元**（regex 限制見 API spec），程式已做清洗。
- ⚠️ **必帶 `start: true`**：預設 `false` 只建立點點簽端的「草稿」，不會寄信給任何簽署人，且草稿不能 void（只能 delete）。實測踩過。
- `has_order: true`：依序簽署。**stages 陣列順序＝簽署順序**，本專案固定 `[乙方（租客）, 甲方（房東）]`。
- 每個 stage：`{ name, email, stage_type: "sign", field_settings }`。
- ⚠️ `stage_setting.decline_enable` 不要硬帶 `true`：signer 若同時是 task owner（帳號本人信箱）會回 `400417 invalid stage_setting`，官方規定 owner 必須為 `false`。省略讓 API 用預設值（owner 預設 false、其他人預設 true）。已實測踩過。
- `field_settings` 每項：`{ field_type: "signature", page, coord, options: { force: true } }`。
- 回應：`{ data: { task_id: <integer> } }`。

## 座標系（重要眉角）

- 點點簽 `coord` 格式：`[left-x, bottom-y, right-x, top-y]`，**原點在左下**（PDF 慣例）。
- 本系統內部（`SignatureField`）存**相對比例**（0~1，原點左上、y 向下，同瀏覽器慣例），送簽時在 `toDsCoord()` 轉換。
- ✅ **coord 單位已實測確認為 PDF points**（A4 = 595.28 × 841.89 pt）：2026-08-01 以任務 466 實測，簽名精確落在指定座標，`toDsCoord()` 轉換正確。
- 前端拖拉像素 → 比例的轉換在 `SignatureFieldEditor.tsx`（除以渲染尺寸）。

## 撤回與下載

- 撤回：`POST /v1/sign_tasks/void`，body `{ task_id: <integer> }`（注意是 body 不是 path 參數）。
  - ⚠️ **草稿狀態（`start: false` 建立的）不能 void**，會回 `403036 task_not_accessible`，只能 delete。可先以 `GET /v1/sign_tasks?task_id=...`（query 參數，不是 path）查 `access_info.void` 確認權限。
- 已簽文件下載：`GET /v1/sign_tasks/download_link?task_id=...&file_types[]=task`。回傳的是**下載連結**而非檔案本體。
  - ✅ 回應形狀已實測：`{ data: { task: "<S3 預簽連結>" } }`，key 對應 `file_types[]` 的值。連結會 302 轉址，client 要跟隨。
  - Sandbox 下載的 PDF 蓋有「Sample by DottedSign」浮水印，正式環境無。

## 簽署連結（share_link API）

- 官方機制：`GET /v1/sign_tasks/share_link?task_ids=...&email=<簽署人>`（scope `sign_tasks.general.write`），回 `{ data: { share_link } }`，可加 `redirect_url`（簽完導回）與 `short=true`。搭配建立任務時 `stage_setting.informable: false`（不寄邀請信）就是官方的「系統自行派發簽署連結」模式，也允許 iframe 內嵌。
- ⚠️ 參數名實測是 `task_ids`（reference 寫 `task_ids[]` 會被打回 `400998`）。
- ✅ **403002 已解除**（2026-08-02 實測）：client credentials token 對 task 470 呼叫成功回 `data.share_link`（`https://sandbox.dottedsign.com/task?code=<JWT>`）。2026-08-01 曾一律回 `403002 not allow for this action`（當時已排除 owner、`informable`、scope 等假設，研判是 Application 層級閘門），未改任何設定即恢復，原因不明；若復發，優先向點點簽支援查 Application 動作閘門。系統的「取得簽署連結」按鈕（`GET /api/contracts/[id]/sign-link`）已走此端點。
- ⚠️ **resend 在 sandbox 不可用**（2026-08-02 實測）：`POST /v1/sign_tasks/resend` 一律回 `403036 task_not_accessible`，任務的 `access_info.resend` 為 `false`；建立任務時帶 `stage_setting.informable: true` 也一樣（task 471 實驗）。研判與 sandbox 不寄信同源，正式環境待驗證。系統的「重寄簽署通知」按鈕在 sandbox 會顯示對應錯誤說明。
- Sandbox 不寄邀請信，測試時簽署人要從點點簽系統內開啟任務；正式環境預設會寄。
- Embedded signing（iframe SDK）需 Business/Enterprise 方案 + `embedded_signing` scope（見 ADR-0003），PoC 未使用。

## Webhook

- Webhook URL 在點點簽開發者後台**建立 Application 時**設定。
- ⚠️ **後台儲存 webhook URL 時會送一記空 body、無簽章 header 的驗證 ping**，endpoint 必須回 200，否則 webhook 註冊無效、之後的事件都不會送（實測踩過：ping 被簽章驗證擋掉回 401，乙方簽署事件就沒有進來）。route 已對空 body 早退回 200。
- 本機開發需開通道：`cloudflared tunnel --url http://localhost:3000` 或 ngrok，把公開 URL + `/api/webhooks/dottedsign` 填到後台。
- Payload 欄位：`resource_id`（= task_id）、`resource_type`（`task`）、`action_name`、`event_datetime`、`event_email` 等。
- 事件對應（`src/lib/transitions.ts`）：
  - `signed`（個別簽署人完成）→ 待乙方簽 → 待甲方簽
  - `completed`（全員完成）→ 已完成
  - `declined` → 已拒簽
  - `voided` → 已撤回
  - ✅ 實測另有 `viewed` 事件（簽署人開啟文件時觸發），route 未映射、自動忽略，無妨。
- ✅ 簽章驗證已實測確認：header 名稱就叫 **`Signature`**，值 = **HMAC-SHA256(client secret, raw JSON body) 的 hex 字串**（64 字元小寫）。`verifyWebhookSignature()` 已按此實作。

## Mock 模式

- 未設定 `DOTTEDSIGN_CLIENT_ID` / `DOTTEDSIGN_CLIENT_SECRET` 時自動啟用（`isMockMode()`）。
- 送簽回假 task id（`mock-<合約id>-<亂數>`），不打點點簽。
- UI 會出現「模擬乙方簽署／拒簽／甲方完成」按鈕，走 `/api/mock/advance` → **與真 webhook 共用同一套 `applyDsEvent()` 轉移邏輯**，確保模擬與真接行為一致。
- 已完成合約的「下載已簽 PDF」在 mock 模式回未簽版 PDF 充當示意。

## 踩坑記錄

1. **pdf-lib `subset: true` + CJK 字型會缺字**。OTF（CFF outline）與 Google Fonts 的 TTF 都會壞（缺「第」「條」「簡」等隨機字）。解法：`subset: false` 全字型內嵌，`assets/fonts/NotoSansTC-Regular.ttf`（6.8MB）→ 產出的 PDF 約 4.3MB。正式版建議改用伺服器端字型子集化（fonttools pyftsubset 預先裁到常用字集）或改用支援 CJK subset 的 PDF 產生方案。
2. **PDF 大小與 API 限制**：base64 後約 5.8MB。點點簽上傳限制未實測，若被拒優先處理字型瘦身。
3. Embedded Signing 需要商業／企業方案帳戶開 `embedded_signing` scope，PoC 未使用（見 ADR-0003）。

## 真接 sandbox 檢查清單

1. 開發者後台建立 Application，取得 client id/secret，設定 webhook URL（含通道）。
2. `.env.local` 填入金鑰（參考 `.env.example`），重啟 dev server，確認 `/api/meta` 回 `mock: false`。
3. 送一張雙方都是自己信箱的測試合約，驗證（2026-08-01 已全數完成，結論見上方各節）：
   - [x] 簽名框位置正確（座標單位＝PDF points 確認）
   - [x] 乙方先收到信、甲方後收到（簽署順序）
   - [x] webhook 事件名稱與 payload 形狀（另發現 `viewed` 事件）
   - [x] webhook 簽章 header 名稱與驗證方式（`Signature` ＝ HMAC-SHA256）
   - [x] 下載連結回應形狀（`data.task`，302 轉址）
   - [x] 執行中任務的 void（task 471 實測成功；⚠️ start 後立即 void 曾回 403，稍候重試即成功，疑為非同步建立的 race）
   - [ ] 拒簽流程（`declined` 事件）尚未實測
   - [ ] resend（重寄通知）sandbox 一律 403036，需正式環境驗證（步驟見下節）

## 接正式環境時的 resend 驗證清單

resend 卡的是 sandbox 環境本身（`access_info.resend: false`），接正式環境時照此驗證：

1. 前置：正式後台建立 Application，`.env.local` 改 `DOTTEDSIGN_API_BASE=https://api.dottedsign.com` 與正式 client id/secret，webhook URL 在正式後台重新設定。⚠️ 正式環境送簽消耗方案任務額度、會真的寄信，測試合約甲乙雙方都填自己的信箱（+alias 手法）。
2. 送簽測試合約，確認乙方邀請信寄達（email 通道有效是 resend 有意義的前提）。
3. `GET /v1/sign_tasks?task_id=<id>` 看 `access_info.resend`。此步驟直接裁決假設：
   - `true` → 證實限制只在 sandbox，續走步驟 4。
   - `false` → 假設錯誤，限制在 client credentials token 或方案等級，向點點簽支援確認，再決定「重寄簽署通知」按鈕去留。
4. 按合約頁「重寄簽署通知」，驗兩件事：route 回 200 帶 `resent_to`；信箱再收到一封通知信。
5. 通過後把上方檢查清單的 resend 項打勾，並刪除 `src/app/api/contracts/[id]/resend/route.ts` 中把 `task_not_accessible` 轉成「sandbox 不提供 resend」的訊息對應，讓真正的 403 原樣浮出。
