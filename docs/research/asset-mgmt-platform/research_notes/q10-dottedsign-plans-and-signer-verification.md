# Q10：點點簽費用、方案差異與簽署人驗證限制

本筆記已依 [稽核報告](../audit/audit-phase1-map-research.md) 修正。

查閱日期：2026-11-07。對應 Linear 票 MIL-36。

## 結論

- 三位簽署人可行。API 的 `stages` 是陣列，讀取範例有 3 個 stage【高】。
- API 只在商務方案與企業方案提供，不另收 API 費用【高】。正式金鑰必須有 Business 帳號【高】。
- 計費單位是「任務數」，SaaS 與 API 共用額度【高】。各方案金額未查到。
- `verify_methods` 逐位簽署人設定，值只有 `email`、`sms`、`twca_mid`【高】。可用種類依方案或群組設定【高】。
- 驗證每次是否另外計費未查到。但 API 有 `over_verify_method_usage` 錯誤，表示驗證有用量上限【中】。
- 沙盒不支援驗證，也限制每任務 5 個 stage【高】。沙盒頁更新於 2025-10-27，早於 `twca_mid` 上線日 2026-08-19。驗證行為須實測或問業務。
- 同一 email 兩個 stage 待 sandbox 驗證。`PATCH` 換簽署人有重複 email 錯誤碼，但不代表建立任務會拒絕。
- `twca_mid` 可能需要企業版【中】。來源是行銷頁，須向業務確認。
- `verify_type` 沒有憑證類的值。API 不能指定工商憑證或自然人憑證驗證【高】。

## 1. 費用與方案

| 項目 | 事實 | 來源 | 信心 |
|---|---|---|---|
| 方案名稱 | 專業、商務、企業，另有免費試用 | https://www.dottedsign.com/zh-tw/pricing（2026-11-07） | 【高】 |
| 專業方案 | 月繳或年繳。金額頁面未列 | 同上 | 【高】 |
| 商務方案 | 年繳。依簽署任務數訂價。頁面預設滑桿為 100 任務每年。金額未列 | 同上；https://developers.dottedsign.com/pricing/（2026-11-07） | 【高】 |
| API 可用性 | 「需訂閱商務方案或企業方案」 | https://www.dottedsign.com/zh-tw/pricing（2026-11-07） | 【高】 |
| API 費用 | API 請求涵蓋於方案內，不另收費 | 同上 | 【高】 |
| 正式金鑰 | 需要 Business 帳號 | https://developers.dottedsign.com/pricing/（2026-11-07） | 【高】 |
| 計費單位 | 以透過 API 送出的任務數計。一個任務可含多份合併文件 | 同上 | 【高】 |
| 額度共用 | 訂閱內的任務數 API 與 SaaS 共用 | 同上 | 【高】 |
| 超額 | 額度用完後，到下個計費期前不能送邀請。管理員可買加購任務 | 同上 | 【高】 |
| 續約 | 每年自動續約 | 同上 | 【高】 |
| 沙盒 | 免費。不具法律效力 | 同上 | 【高】 |
| 速率限制 | 正式環境限 120 次／分鐘 | [Rate Limits 頁](https://developer.dottedsign.com/docs/03-about-dottedsign-api-05-rate-limits.md) | 【高】 |
| 任務額度的計入範圍 | 任務額度另含自簽、公開表單與前台使用 | [英文定價頁](https://developers.dottedsign.com/pricing/) | 【中】 |

查不到的項目與查過的位置：

- 專業、商務、企業各方案的金額。查過 https://www.dottedsign.com/pricing、`/zh-tw/pricing` 與 https://developers.dottedsign.com/pricing/。三頁都沒有金額。「方案及功能比較」區塊在抓取結果中為空。
- 加購任務的單價。同上三頁都沒有。
- 每次驗證的單價與計費單位。查過上述三頁、Dev docs 驗證頁、沙盒頁。都未提及。
- 企業方案的內容。頁面只列名稱。

不採用的來源：[eSign.ai 部落格](https://www.esign.ai/blog/dottedsign-electronic-signature-pricing-guide)宣稱身分驗證每次 1 至 2 美元。這是第三方文章，官網查無佐證【低】。不得當作點點簽價格。

### 各驗證方式由哪個方案提供

| 方式 | 方案說明 | 來源 | 信心 |
|---|---|---|---|
| `email` OTP | 官方說明為基本身分驗證。方案限制未查到明文 | https://support.dottedsign.com/hc/en-us/articles/11270318703385（搜尋摘要，本文 403） | 【低】 |
| `sms` OTP | 搜尋摘要見 SMS 限 Pro 訂閱者 | https://support.dottedsign.com/hc/en-us/articles/900000391766（搜尋摘要，本文 403） | 【低】 |
| `twca_mid` | 定價頁列出工商憑證、自然人憑證、MID 行動門號三種認證。方案限制未列 | https://www.dottedsign.com/zh-tw/pricing（2026-11-07） | 【中】 |
| `twca_mid` 的方案門檻 | [MID 頁](https://www.dottedsign.com/features/mid/)與[憑證頁](https://www.dottedsign.com/features/digital-certificate-cht/)都寫支援點點簽企業版。管理者須在控制台開啟 | 同左，文字在頁面內嵌資料 | 【中】 |

說明：

- `sms` 的方案限制來自搜尋摘要，原文頁 403，未能親讀。「以上」與「進階驗證」兩詞未見於摘要，已刪除。
- 日本比較站把 email 與 SMS OTP 列在商務方案。來源 URL 未能確認，可能是 saas.imitsu.jp。與官方說明衝突，以官方為準，但仍須向業務確認。
- `twca_mid` 的企業版線索來自行銷頁，不是方案條款。P0-12 成本模型必須向業務確認商務方案是否可用。
- 工商憑證與自然人憑證在 `verify_type` 沒有對應值。列舉只有 `email`、`sms`、`twca_mid`。來源：[changelog 1.0.9](https://developer.dottedsign.com/changelog/109) 與 `VerifyMethodRequest` 列舉。
- API 的 `verify_type` 描述寫「可用種類依使用者方案或群組設定」。見下節。

## 2. 簽署人驗證的 API 欄位與限制

### `verify_methods` 完整定義

來源：MCP `dottedsign-api`，SignTasks，`POST /v1/sign_tasks`（Create a task），schema `VerifyMethodRequest`。信心【高】。

`stages[].verify_methods` 是陣列，每項欄位如下。

| 欄位 | 型別 | 必要 | 說明 |
|---|---|---|---|
| `verify_type` | string | 是 | 列舉 `email`、`sms`、`twca_mid`。可用種類依方案或群組設定 |
| `verify_source` | string | 看類型 | 區碼加號碼 |
| `occasion` | string | 否 | `sign` 或 `read`。預設 `sign` |
| `options.national_id_number` | string | 看類型 | 只在 `twca_mid` 可用 |

各類型的必要欄位：

| 類型 | 必要欄位與條件 |
|---|---|
| `email` | 文件未列額外欄位。MCP schema 沒寫 `verify_source` 的 email 規則。推測不得採用，待驗證 |
| `sms` | `verify_source` 必填，內容是區碼加手機號碼 |
| `twca_mid` | `verify_source`（當作手機號碼）與 `options.national_id_number` 至少給一個才能建立。兩個都有才能驗證成功 |

### 其他欄位限制

來源：同上。

- schema 的 required 只有 `name` 與 `email`。但 `field_settings` 描述寫，`stage_type` 為 `sign` 時必填。`email` 最長 250 字元【高】。
- `has_order` 預設 `true`，簽署人依序簽【高】。
- `stage_type` 為 `sign` 或 `edit`。有 `edit` stage 時 `has_order` 必須為 `true`【高】。
- 讀取任務的回應，`verify_methods` 另有 `uuid`、`sequence` 欄位【高】。來源：`GET /v1/sign_tasks/read`。
- 每位簽署人可放多個 `verify_methods`。`sequence` 表示驗證順序【中】。數量上限未查到。

### stage 數量與人數上限

| 環境 | 上限 | 來源 | 信心 |
|---|---|---|---|
| 正式 | 未查到 | 查過 `POST /v1/sign_tasks` schema（無 `maxItems`）、定價頁、沙盒頁 | 【高】（確定未載明） |
| 沙盒 | 每個任務與範本 5 個 stage，只限沙盒 | https://developer.dottedsign.com/docs/01-welcome-dottedsign-api-07-sandbox.md（2026-11-07）。稽核直接讀原始 md，官方表格有列 | 【高】 |

沙盒另有每 24 小時 20 個任務的上限。來源同上，定價頁也有同數字。沙盒的驗證功能為停用，項目含 SMS、Email OTP、A+ Sign、Mobile ID。

「來自抽象層子對話」：API 範例有 3 個 stage。本次由 `GET /v1/sign_tasks/read` 範例回應複核，stage 的 `sequence` 為 1、2、3【高】。

### 同一 email 兩個 stage

文件未載明。查過 `POST /v1/sign_tasks`、`PUT /v1/sign_tasks` 的 schema 與錯誤範例，沒有重複 email 的錯誤碼。
`PATCH /v1/sign_tasks/signer` 有 400050 `forward_mail_already_in_flow`。這個碼只涵蓋換簽署人，不代表建立任務會拒絕。

**同一 email 兩個 stage 待 sandbox 驗證。**

限制：沙盒可測 stage 結構與重複 email 是否被拒。沙盒測試要加入此情境。沙盒不支援驗證，所以「重複 email 加驗證」的組合只能在正式環境測。

### 失敗時的回應

來源：MCP `dottedsign-api`，SignTasks。

| 時點 | HTTP | `error_key` | 說明 | 信心 |
|---|---|---|---|---|
| 建立任務 | 400 | `invalid_verify_params`（400428） | 範例註明群組未設定身分驗證 | 【高】 |
| 建立任務 | 403 | `over_verify_method_usage`（403068） | 驗證用量超額 | 【高】 |
| 建立任務 | 403 | `over_task_usage`（403032） | 任務額度超額 | 【高】 |
| 建立任務 | 400 | `email_format_invalid`（400220） | email 格式錯誤 | 【高】 |
| 簽署或讀取 | 403 | `stage_need_verify`（403034） | 需先驗證。回傳 `verify_info`（含 `uuid`、`verify_type`、`verify_source`）與 `verify_for` | 【高】 |
| 簽署 | 403、401 | `stage_need_verify`（403034）、401030 | `verify_for` 也可能是 `account_protect`。已註冊會員走 quick sign 會收到 401030 | 【高】 |
| 簽署或讀取 | 403 | `over_verify_method_usage`（403068） | 範例 `verify_type` 為 `sms`，標為 over otp usage | 【高】 |
| 簽署或讀取 | 406 | `verify_failed`（406031） | 回傳 `verify_info[].verify_status = failed` | 【高】 |

注意：

- 建立任務的 400428 表示帳號或群組沒開通該驗證方式。這是方案限制在 API 層的實際表現【中】。範例只寫到「group」，未寫明對應哪個方案。
- 403068 的範例只出現 `sms`。其他類型是否相同未查到。
- 送簽流程必須區分兩種 `verify_for`：身分驗證與帳號保護 `account_protect`。

### 驗證流程

來源：https://developer.dottedsign.com/docs/05-quick-start-scenarios-05-read-a-task-with-otp-verification.md（2026-11-07）。信心【中】。

1. 讀取或簽署任務時，API 回 `stage_need_verify` 並寄出驗證碼。
2. 用 `task_id`、`uuid`、`verify_data` 再呼叫。
3. 成功後取得 `identity_verify_token`。
4. 呼叫簽署 API 時帶入 `verify_info`。

該頁只示範 `email`。`sms` 與 `twca_mid` 的完整流程未載明。

`POST /v1/sign_tasks/sign` 的 `verify_info` 欄位有 `uuid`、`verify_data`、`identity_verify_token`、`account_protect_token`、`verify_token`【高】。

### webhook 與驗證結果

來源：https://developer.dottedsign.com/docs/03-about-dottedsign-api-02-webhooks.md（2026-11-07）。信心【高】。稽核已直接讀原始 md。

- 事件含 `verified`、`review_verified`、`confirm_verified`、`signed`、`completed`、`declined`、`voided` 等。
- payload 欄位：`resource_id`、`resource_type`、`action_name`、`event_datetime`、`event_email`、`ip_address`、`user_agent`、`other_info`。
- `verified` 事件表示一位簽署人驗證完成，並帶 `event_email` 與時間。
- 沒有驗證類型欄位，也沒有驗證失敗事件。
- `verified` 事件的 `other_info` 內容未載明。頁面也沒有 payload 範例。
- MCP `list-specs` 列出七份 spec，沒有 webhook。`search-endpoints` 搜不到 schema 與範例內容，連已知存在的 `twca_mid` 也回無結果。因此該工具的負面結果不能當證據。

稽核軌跡：`GET /v1/sign_tasks/audit_trails` 的 `action_name` 列舉為 `confirmed`、`created`、`declined`、`edited`、`file_consented`、`sent`、`signed`、`signer_change_requested`、`signer_changed`、`voided`【高】。列舉沒有 `verified`。範例卻出現 `viewed`，與列舉不一致。結論：稽核軌跡的列舉沒有驗證事件。

## 3. ADR-0016 與 P0-12 必須知道的限制

只列事實，不替它們做決定。

**對 ADR-0016（簽署人模型）：**

1. 三位簽署人在 API 層可行。`stages` 是陣列，`has_order` 預設 `true`【高】。
2. 正式環境的 stage 上限未載明。沙盒上限是 5，Phase 2 若到四位以上，沙盒可測的範圍夠【中】。
3. 同一 email 能否出現在兩個 stage 未知。若執業人員同時是甲方或乙方，本題會影響設計。待 sandbox 驗證。
4. 簽署順序是否由 stage 陣列順序決定，schema 沒寫陣列順序對應 `sequence`。範例只顯示讀回結果。ADR-0016 的「執業人員、乙方、甲方」對應 stage 1 至 3 是推測【中】，列入沙盒測試。
5. 簽署人角色（`party_a`、`party_b`、`practitioner`）在 API 沒有對應欄位。`stages` 只有 `name` 與 `email`。角色必須由本系統記錄【高】。
6. 換簽署人有 `PATCH /v1/sign_tasks/signer`。細節本次未查【低】。

**對 P0-12（簽章分流）：**

1. 驗證方式逐位設定，可讓執業人員用 `twca_mid`，其他人用 `email`【高】。
2. `twca_mid` 要手機號碼與身分證字號兩者才能驗證成功。系統必須蒐集並傳送這兩項，涉及個資。API 只要求送出，是否保存另行決定。
3. 點點簽只驗證「持有該手機或證件的人」。API 沒有欄位對應「專任管理人員資格」。資格檢查（M02）仍由本系統負責【高】。
4. webhook 有 `verified` 事件。沒有驗證類型欄位與失敗事件，`other_info` 內容未載明。稽核軌跡列舉沒有 `verified`。簽章紀錄的驗證欄位若要留存，建議再呼叫讀取任務確認。這是設計選項，需另行驗證【低】。
5. 驗證方式依方案或群組開通。建立任務時可能收到 400428 或 403068。送簽流程必須處理這兩個錯誤【高】。
6. 驗證用量有上限。單價與是否佔用任務額度未查到。這影響成本模型【中】。
7. 沙盒停用驗證。沙盒頁早於 `twca_mid` 上線，端到端測試須實測或向業務確認測試帳號【中】。
8. 任務額度 SaaS 與 API 共用。超額後無法送邀請，直到下個計費期【高】。
9. API 不能用 `verify_type` 指定憑證類驗證。工商憑證與自然人憑證沒有對應值【高】。
10. 讀取任務的回應 schema 含 `options.national_id_number`，回傳內容可能帶身分證字號。不得把完整回應寫入日誌。
11. 送簽流程必須區分 `stage_need_verify` 的兩種 `verify_for`：身分驗證與 `account_protect`。
12. `twca_mid` 的方案門檻可能是企業版【中】，來源是行銷頁。向業務確認。

## 待釐清

| 項目 | 建議方式 |
|---|---|
| 各方案金額、加購單價 | 洽點點簽業務 |
| 每次驗證計費方式、是否佔任務額度 | 洽點點簽業務 |
| `sms`、`twca_mid` 的方案門檻，含商務方案能否用 `twca_mid` | 洽點點簽業務 |
| 同一 email 兩個 stage | 沙盒實測 |
| stage 陣列順序是否對應 `sequence` | 沙盒實測 |
| 正式環境 stage 上限 | 洽點點簽業務 |
| `verified` 事件的 `other_info` 內容 | 讀原頁或實際接收 webhook |

## 來源清單

MCP `dottedsign-api`（SignTasks reference），查閱日期 2026-11-07：

- `POST /v1/sign_tasks`（Create a task）
- `GET /v1/sign_tasks/read`（Read a task）
- `POST /v1/sign_tasks/start`（Start a task）
- `POST /v1/sign_tasks/sign`（Sign a task）
- `GET /v1/sign_tasks/audit_trails`（Get the audit trails）

網頁，查閱日期皆為 2026-11-07：

- https://www.dottedsign.com/pricing
- https://www.dottedsign.com/zh-tw/pricing
- https://developers.dottedsign.com/pricing/
- https://developer.dottedsign.com/docs/01-welcome-dottedsign-api-07-sandbox.md
- https://developer.dottedsign.com/docs/03-about-dottedsign-api-02-webhooks.md
- https://developer.dottedsign.com/docs/03-about-dottedsign-api-03-response-codes.md
- https://developer.dottedsign.com/docs/03-about-dottedsign-api-04-error-handling.md
- https://developer.dottedsign.com/docs/05-quick-start-scenarios-05-read-a-task-with-otp-verification.md
- https://developer.dottedsign.com/changelog/109
- https://developer.dottedsign.com/docs/03-about-dottedsign-api-05-rate-limits.md
- https://www.dottedsign.com/features/mid/
- https://www.dottedsign.com/features/digital-certificate-cht/
- https://www.esign.ai/blog/dottedsign-electronic-signature-pricing-guide
- https://support.dottedsign.com/hc/en-us/articles/900000391766（403，只讀到搜尋摘要）
- https://support.dottedsign.com/hc/en-us/articles/11270318703385（403，只讀到搜尋摘要）

沙盒頁與 webhook 頁已由稽核讀原始 md。其他網頁內容由抓取工具摘要，引用處建議人工複核原頁。

## 稽核修正紀錄

依 [稽核報告](../audit/audit-phase1-map-research.md) 第二節。15 條發現全部套用。

| 發現 | 處理方式 |
|---|---|
| 1 | 補 `PATCH` 的 400050，說明只涵蓋換簽署人。沙盒測試加入此情境 |
| 2 | 補企業版線索，標【中】與行銷頁。待釐清補向業務確認 |
| 3 | `twca_mid` 與憑證類拆開。P0-12 補一條 |
| 4 | 改為有 `verified` 事件、無驗證類型欄位與失敗事件 |
| 5 | 改引 `list-specs`，並註明搜尋工具的負面結果不能當證據 |
| 6 | 結論改為沙盒停用、頁面早於 `twca_mid`，須實測或問業務 |
| 7 | 補 esign.ai 的 URL。日本站 URL 未能確認，照實寫 |
| 8 | 刪除 `sms` 列的後半句，【低】維持 |
| 9 | 改為「必須蒐集並傳送」，是否保存另行決定 |
| 10 | ADR-0016 第 4 點降為【中】，列入沙盒測試 |
| 11 | 補 `stage_type` 為 `sign` 時必填 |
| 12 | 補 `account_protect` 與 401030 |
| 13 | P0-12 補個資考量，不得把完整回應寫入日誌 |
| 14 | 補正式環境 120 次／分鐘與任務額度範圍 |
| 15 | 23、46 行兩處長引改寫 |

信心調整：沙盒與 webhook 兩項依稽核建議升為【高】。`email`、`sms` 方案列維持【低】。
