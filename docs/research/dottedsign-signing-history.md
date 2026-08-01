# 點點簽（DottedSign）簽署任務歷程與稽核設計調查

> 本文件是 wayfinder 票「合約歷程與稽核紀錄」的研究成果，作為平台側歷程設計的事實基準。
> 研究日期：2026-08-01。
>
> 來源層級：以官方開發者文件（<https://developer.dottedsign.com/v1.0-sandbox/>，第一手）為主；官方產品頁（dottedsign.com）為輔；help center 文章因 Cloudflare 阻擋無法直接抓取，僅列出存在的條目。所有結論均附來源連結；文件沒寫的明確標註「文件未載明」。

## 1. Webhook 事件型別完整清單

**結論**：官方事件表共列 25 列（其中 `unarchived` 重複出現兩次，實為 24 個相異事件），resource type 全部是 `task`。payload 除了本 repo `docs/dottedsign-integration.md` 已知的 5 個欄位外，還有 `ip_address`、`user_agent`、`other_info` 三個欄位。**沒有 `expired` 事件**（詳見第 4 節）。

### 事件表（照官方文件原樣）

| Event | 說明 |
| --- | --- |
| `created` | 任務已建立 |
| `sent` | 任務已送出給簽署人 |
| `modified` | 任務被 owner 更新 |
| `verified` | 任務被某位簽署人驗證（verify） |
| `viewed` | 任務被檢視 |
| `signed` | 某位簽署人完成簽署 |
| `completed` | 全部簽署人完成簽署 |
| `declined` | 某位簽署人拒簽 |
| `voided` | owner 撤回任務 |
| `review_verified` | 某位審閱人完成驗證 |
| `review_passed` | 某位審閱人審閱通過 |
| `review_rejected` | 某位審閱人退回 |
| `confirm_verified` | 某位簽署人完成確認前驗證 |
| `confirmed` | 某位簽署人確認任務 |
| `archived` | 任務被有權限的成員封存 |
| `unarchived` | 任務被有權限的成員解除封存（官方表格中此列重複出現兩次） |
| `discarded` | 任務被移入垃圾桶 |
| `restored` | 任務從垃圾桶還原 |
| `garbage_collected` | 任務被系統永久刪除、無法還原 |
| `signer_change_request` | 簽署人請求 owner 更換簽署人 |
| `signer_changed` | 簽署人已被 owner 或原簽署人更換 |
| `reviewer_change_request` | 審閱人請求 owner 更換審閱人 |
| `reviewer_changed` | 審閱人已被 owner 或原審閱人更換 |
| `email_failed` | 簽署人 email 寄送失敗（地址無效或無法投遞） |

### Payload 形狀（8 個欄位，皆不可為 null）

| 欄位 | 說明 |
| --- | --- |
| `resource_id` | 資源 ID（= task id） |
| `resource_type` | 資源型別，例如 `task` |
| `action_name` | 事件名稱（見上表） |
| `event_datetime` | 事件發生時間戳 |
| `event_email` | 觸發事件的成員 |
| `ip_address` | 事件發生的 IP 位址 |
| `user_agent` | 事件發生的 user agent／裝置 |
| `other_info` | 事件附加資訊；**官方註明各事件的 attributes 不盡相同**（例如拒簽理由等，確切形狀文件未逐一載明） |

### 其他行為要點

- **簽章驗證**：官方原文——Signature header 是「以 application 的 client secret 用 sha256 演算法對 JSON payload 編碼」產生。**header 的確切名稱與究竟是 HMAC 還是純 hash，文件未載明**（與本 repo 整合筆記的觀察一致）。
- **重試**：非 2xx 回應會以指數退避重試 3 次（間隔 1／2／3 分鐘）；**單日累積 10 次投遞失敗會暫停整個 application 的 webhook**，需人工重新啟用。
- **接收資格**：只有透過 Open API 建立／送出／簽署（即觸發過 `created`、`sent` 或 `signed`）的任務，後續事件才會發 webhook。
- Webhook 投遞有後台日誌（Webhook Log）可查。

來源：[Webhooks 指南](https://developer.dottedsign.com/v1.0-sandbox/docs/03-about-dottedsign-api-02-webhooks.md)（以 curl 取得原始 markdown 逐字核對）。

## 2. API 歷程／audit trail 查詢

**結論**：**有專門的 audit trail 查詢端點** `GET /v1/sign_tasks/audit_trails`，回傳分頁的事件列表（含 IP、user agent、平台）。另外 `GET /v1/sign_tasks`（取單一任務）提供狀態列舉與建立／修改時間戳，但沒有逐簽署人的完成時間欄位明載於摘要層（在 `details` 各 stage 的 status 反映進度）。

### 2a. `GET /v1/sign_tasks/audit_trails`

- 參數：`task_id`（必填）、`page`（預設 1）、`per_page`（預設 10、上限 20）。
- Scope：`sign_tasks.general.read`（本專案已申請）。
- 回傳：分頁欄位（`total_count`／`current_page`／`total_pages`）＋ `events` 陣列，每筆 SignEvent 含：

| 欄位 | 說明 |
| --- | --- |
| `action_name` | 事件型別，枚舉共 10 種：`confirmed`、`created`、`declined`、`edited`、`file_consented`、`sent`、`signed`、`signer_change_requested`、`signer_changed`、`voided` |
| `role` | 角色名稱 |
| `email` | Email |
| `client` | 平台：`android`／`ios`／`open_api`／`web` |
| `user_agent` | User agent 字串 |
| `ip_address` | IP 位址 |
| `app_version` | App 版本（如適用） |
| `other_info` | 附加資訊（可能含 reason／message） |
| `created_at` | 事件時間戳（integer） |

- 注意：此端點的 `action_name` 枚舉（10 種）**與 webhook 事件表（24 種）不同**——例如沒有 `viewed`、`completed`，卻多了 `edited`、`file_consented`，且更名為 `signer_change_requested`（webhook 是 `signer_change_request`）。兩者是不同的清單，文件未說明對應關係。

來源：[Get the audit trails](https://developer.dottedsign.com/v1.0-sandbox/reference/getsigntaskaudittrails.md)。

### 2b. `GET /v1/sign_tasks`（取任務詳情）

- 任務層：`status` 枚舉 `draft`／`waiting`／`completed`／`declined`／`expired`／`voided`／`deleted`；時間戳有 `created_at`、`last_modified_at`。
- 簽署人層（`details` 內各 stage）：status 枚舉 `initial`／`processing`／`signed`／`done`／`modifying`／`reviewed`／`declined`／`canceled`；另有 `current_stage_infos` 表示目前輪到誰。
- **文件未載明** stage 層是否含各簽署人的完成時間戳——逐人簽署時間要靠 audit trails 端點或 webhook `signed` 事件的 `event_datetime` 取得。
- 到期相關欄位在 `task_setting`：`deadline`（秒級 timestamp，nullable）、`expires_in_days`（nullable）、`expire_remind`、`remind_days_before_expire`（見第 4 節）。

來源：[Get a task](https://developer.dottedsign.com/v1.0-sandbox/reference/getsigntask.md)。

## 3. 簽署證明／稽核文件

**結論**：**有**。任務完成時點點簽會自動產生「Audit Trail File」稽核文件，與完成文件一樣受點點簽數位簽章保護，且**可透過 API 下載**（`file_types[]=audit_trail`），使用本專案已申請的 `sign_tasks.download.read` scope。

### 產生時機與保護

Task 術語頁原文：任務進入 `Completed` 狀態時產生 `Completed File`，同時自動產生「Audit Trail File」，其作用是「audits the signers' actions during the task」；完成文件與稽核文件「are protected by DottedSign's digital signature and are available for download by authorized users」。
來源：[Task 術語頁](https://developer.dottedsign.com/v1.0-sandbox/docs/04-terminologies-01-signtask.md)。

### API 下載方式（兩個端點）

1. `GET /v1/sign_tasks/download_link?task_id=...&file_types[]=audit_trail`——回傳 pre-signed S3 下載連結（**15 分鐘失效**）。`file_types[]` 完整枚舉：`task`、`attachment`、`attachment_compressed`、`audit_trail`、`source_file`。
2. `GET /v1/sign_tasks/download`——直接回 zip（`Accept: application/zip`），同一組 `file_types[]`。

兩者 scope 皆為 `sign_tasks.download.read`。
來源：[Get a task download link](https://developer.dottedsign.com/v1.0-sandbox/reference/getsigntaskdownloadlink.md)、[Download task related files](https://developer.dottedsign.com/v1.0-sandbox/reference/downloadsigntask.md)。

### 稽核文件內容

- 官方產品頁（安全性頁）原文：audit trail 記錄「the name, email address, date, time stamp, IP address and device used」，提供「an electronic record of all signers' actions to a PDF document」以確保不可否認性與法律舉證。
- 同頁載明文件防竄改機制：數位憑證由 AATL（Adobe Approved Trust List）成員 CA 簽發；傳輸與儲存加密為 TLS/SSL、AES-256、RSA-2048。
- **文件未載明**：audit trail 檔案的確切格式（推測為 PDF，開發者文件未明說）與逐欄位樣板；開發者文件也沒有獨立的「certificate／簽署證明」端點——稽核文件就是 `audit_trail` 這個 file type。
- Help center 有專文〈How to Download the Audit Trail of a Signing Task〉（<https://support.dottedsign.com/hc/en-us/articles/900000379883>），本次因網站阻擋自動抓取未能核對內文，僅確認條目存在。

來源：[Secure Digital Signature（官方產品頁）](https://www.dottedsign.com/secure-digital-signature/)。

## 4. 有效期／過期機制

**結論**：**有自動過期機制，但沒有對應的 webhook 事件**——任務過期需靠平台側自行輪詢或比對 deadline。

- Task 術語頁明載 `Expired` 是任務狀態之一：「The task is automatically terminated after surpassing its predefined expiration date」，為終態；`GET /v1/sign_tasks` 的 `status` 枚舉亦含 `expired`。
- 設定方式（建立任務時的 `task_setting`）：
  - `deadline`：秒級 timestamp（上限 9999999999，即不支援 2286/11/20 之後）。
  - `expire_remind`（boolean）＋ `remind_days_before_expire`（允許值 1／2／3 天）：到期前提醒簽署人。
  - **文件未載明**未設定 deadline 時的預設有效期（是否永不過期或有系統預設值）。
- **Webhook 事件表沒有 `expired` 事件**（第 1 節清單逐字核對過）；audit trails 端點的 `action_name` 枚舉同樣沒有過期相關值。**文件未載明**任務過期時是否有任何主動通知整合方的機制。

來源：[Task 術語頁](https://developer.dottedsign.com/v1.0-sandbox/docs/04-terminologies-01-signtask.md)、[Create a task](https://developer.dottedsign.com/v1.0-sandbox/reference/createsigntask.md)、[Webhooks 指南](https://developer.dottedsign.com/v1.0-sandbox/docs/03-about-dottedsign-api-02-webhooks.md)。

## 對本專案的含意

僅陳述事實與選項，不做決定：

1. **舉證要素大多已由點點簽覆蓋**：任務完成後自動產生、受點點簽數位簽章保護的 Audit Trail File 含各方姓名、Email、時間戳、IP、裝置（產品頁載明），且用現有的 `sign_tasks.download.read` scope 就能下載（`file_types[]=audit_trail`）。若以此為法律舉證來源，平台側的歷程可以定位為「活動時間軸／營運紀錄」而非稽核級證據。
2. **平台側若要即時歷程，webhook 資料比目前存的多**：payload 還有 `ip_address`、`user_agent`、`other_info` 三欄，若歷程要顯示「從哪個裝置簽的」可直接入庫，不必另外查詢。事件面也比目前 `src/lib/transitions.ts` 處理的 4 種多（`viewed`、`sent`、`email_failed`、`signer_changed` 等對歷程或告警可能有用，例如 `email_failed` 是目前完全接不到的失敗訊號）。
3. **兩份事件詞彙表不一致**：webhook（24 種）與 audit trails API（10 種）的 `action_name` 枚舉不同、命名也有出入（`signer_change_request` vs `signer_change_requested`），平台側若要合併兩來源建歷程，需要一層事件名稱正規化。
4. **過期是唯一沒有推播的狀態轉移**：任務會自動 `expired` 但不發 webhook，平台側要嘛（a）自己排程比對 deadline、要嘛（b）定期輪詢 `GET /v1/sign_tasks` 的 `status`、要嘛（c）PoC 階段不設 deadline 迴避此題（預設行為文件未載明，需實測）。
5. **待實測項**（文件未載明，沿用整合筆記的真接檢查清單精神）：webhook 各事件 `other_info` 的實際形狀、signature header 名稱與演算法細節、audit trail 檔案格式與內容樣板、未設 deadline 的預設有效期。
