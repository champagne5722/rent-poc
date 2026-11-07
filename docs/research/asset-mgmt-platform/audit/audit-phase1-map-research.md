# 稽核報告：Q10、Q13、Q21、Q27 研究筆記

稽核日期：2026-11-07。基準 commit：`2f39b875`。
稽核範圍：`research_notes/` 下四份未 commit 的筆記。
本報告沒有修改筆記、`src/`、`GLOSSARY.md`，也沒有寫入 Linear。

## 稽核摘要

| 筆記 | 總評 | 錯誤 | 過度推論 | 缺引用 | 補充 | 最重要的發現 |
|---|---|---|---|---|---|---|
| Q27 押金 | 修正後可採用 | 3 | 6 | 1 | 8 | 條次錯一處；「合法」越界；官方全文查得到 |
| Q10 點點簽 | 修正後可採用 | 4 | 5 | 2 | 4 | 有重複 email 錯誤碼；`twca_mid` 可能需企業版 |
| Q13 呼叫點 | 修正後可採用 | 8 | 2 | 0 | 1 | 計數全對；13 處低估為 24 處；同 tick 交易會撞 |
| Q21 錨定 | 修正後可採用 | 2 | 6 | 3 | 2 | TWCA 精準度查得到；建議超出證據 |

四份筆記的主結論方向都沒有被推翻。
必須修正後才能給 grilling 使用。
Q27 的法律判斷仍必須由法務確認。本報告不下法律結論。

等級定義：
- **錯誤**：與來源或程式碼不符。
- **過度推論**：來源不足以支持結論。
- **缺引用**：主張無法追溯。
- **補充**：筆記漏掉、會影響決策的事實。

---

## 一、Q27：一般代管能否由代管業者收押金

### 總評：修正後可採用

條次與文號幾乎全對。一處條次錯誤必須改。
「合法選項」「立法意向」等句越過筆記自己的不下結論聲明。
「兩站轉載」的主要缺口已可補上：行政院網站有官方全文。

### 已核對清單

| 項目 | 方法 | 結果 |
|---|---|---|
| 條例 §3⑥、§3⑬、§7、§12②、§22、§28、§30、§32、§33 | curl 全國法規資料庫全文，逐條比對 | 一致 |
| 條例關鍵字 | 全文計數。「信託」0 次、「履約保證」0 次、「專戶」只在 §22 | 與筆記一致 |
| 修正日期與整編截止日 | 頁面標示 112-02-08 與 115-10-30 | 一致 |
| 公告文號、全文 2 點、生效日 | 法源頁、行政院 PDF | 一致 |
| 公告壹、五（八）、九（三）（七）（八）、十一（二） | 行政院 PDF、法源、消基會三方比對 | 文字一致，只有標點差異 |
| 公告貳 五項 | 同上 | 一致，五項都沒有押金字樣 |
| 範本文號 1080264475、1080264472 | 消基會頁、新北市地政局 PDF | 一致 |
| 範本第 4 條第 8 款、第 8 條第 1 項第 3、7、8 款、第 10 條第 1 項第 2 款 | 同上 | 一致 |
| 兩版範本押金條款 | 程式比對含「押金」的行，各 7 行 | 逐字相同 |
| 社宅範本五筆沿革函號 | 臺北市網站 PDF | 一致 |
| 社宅範本第 3、4、7、8 條 | 同上，全文閱讀 | 一致，第 8 條第 1 項第 11 款原文無誤 |
| Q3 選項與 PRD P0-14 規則 2、3 的對應 | 讀 PRD 702 至 716 行、1133 行 | 一致 |

### 發現表

| # | 等級 | 位置 | 問題 | 證據 | 建議修正 |
|---|---|---|---|---|---|
| 1 | 錯誤 | 1.1「壹、七 第 2 項」；1.2 第 7 條第 2 項的對應欄 | 交付方式條文在壹、八第 2 項。壹、七是修繕之處理 | [行政院 PDF](https://www.ey.gov.tw/File/73851B219A5EC2CB?A=C) 第八點第二項 | 兩處都改為壹、八 |
| 2 | 過度推論 | 4 節選項 C「在原文上是合法選項」 | 「合法」是法律結論。筆記開頭聲明不下法律結論。第 2 節也寫帳戶持有人未規定 | 公告壹、九（七）（八）沒有帳戶或持有人文字 | 改為「原文未禁止，帳戶持有人未規定」 |
| 3 | 過度推論 | 1.1 壹、九（八）「代管業者可以持有並返還」 | 原文用「代為管理」，沒有「持有」。這正是 Q3 要問的事 | 公告壹、九（八） | 改為「可代為管理，經委託人同意後代為返還」 |
| 4 | 過度推論 | 結論第 9 行、1.1、第 2 節「明文允許」 | 原文是可勾選的委託項目，沒有「允許」字樣。方向成立，用語過強 | 公告壹、五（八）2、3 | 改為「列為可約定的委託項目」，並引下列第 8、10 條發現佐證 |
| 5 | 過度推論 | 4 節選項 A「立法意向」「顯示押金需要保護」「認為禁止是可行做法」 | 公告不是立法。筆記第 5 節自承查不到理由，三句都是推測 | 筆記第 3 節第 4 點、第 5 節 | 刪除推測，只留條文事實。要引理由就引第 10 條發現 |
| 6 | 過度推論 | 4 節選項 A 右欄「不是消保法層級的強制規定」 | 貳只列五項，貳、五是概括條款。沒列入不足以反推 | 公告貳、五「不得記載違反強制或禁止規定」 | 刪除這句，或列入法務清單 |
| 7 | 錯誤 | 第 2 節「代管業者破產時押金的處理｜無條文」 | 沒有破產專條，但條例有賠償與基金代賠條文。「無條文」過寬 | 條例 §31 第 1、4 項；§22、§23 | 改為「無破產專條；§31 有賠償與基金代賠，適用待法務確認」 |
| 8 | 補充 | 1.4 節 | 代收押金已是法定提供資訊。這是法規命令，比範本證據更強 | [資訊提供辦法](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=D0060131) §2、§4；條例 §34、§38⑤ | 列入 1.4。代管業 30 日內提供，違反處 6 千至 3 萬元 |
| 9 | 補充 | 第 0、5、8 節「官方頁面查不到」 | 行政院消保專區有官方頁與 PDF。缺口可補 | [行政院頁面](https://www.ey.gov.tw/Page/DFB720D019CCCB0A/19994068-fc51-4e6a-9dc5-447a8dfe6bf3) | 更新來源限制。1.1、1.2 的公告列可升為【高】。公報頁我也未找到 |
| 10 | 補充 | 第 5 節「總說明未查到，無法判斷理由」 | 範本附的簽約注意事項有主管機關說明。十（六）（七）、十二（二）涉及押金 | [新北市地政局 PDF](https://www-ws.land.ntpc.gov.tw/001/Upload/399/relfile/8993/77/30b86c57-ad3e-4ea2-a40b-764797b5f93d.pdf) 第 12 頁，企業版範本 | 補引。它稱代收為受託人重要業務，逾期未交付屬重大違約。總說明本身仍未找到 |
| 11 | 補充 | 第 2 節「專戶未規定」、第 4 節 | 現況描述正確，但主管機關已公開研議修法。Q3 必須知道 | [ETtoday 8/13](https://www.ettoday.net/news/20260813/3218849.htm)、[中央社 8/13](https://cna.com.tw/news/afe/202608130301.aspx) | 補一節。內容：研議代收款與自有資金分離、業檢加強押租金紀錄。屬媒體轉述，未見草案 |
| 12 | 補充 | 1.1、1.2 | 未說明適用範圍。企業版範本的注意事項稱，出租人為企業經營者時不具消費關係 | 新北市地政局 PDF 注意事項一（二）；公告授權含消保法 | 列入法務清單：法人屋主是否適用三十日與不得動支 |
| 13 | 補充 | 1.1 | 漏列壹、九第 2 項。受託人違反各款致損害須賠償 | 行政院 PDF 第九點第二項 | 加一列。它與押金逾期、動支直接相關 |
| 14 | 補充 | 第 5 節「施行細則未查」 | 我已查。細則全文「押金」「代收」「保管」都是 0 次 | [施行細則](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=D0060126)，113-05-28 版 | 從待補移到已查 |
| 15 | 缺引用 | 1.1「授權依據：消保法第 17 條第 1 項」 | 行政院 PDF、法源、消基會都沒載明。條例 §32③ 可追溯，消保法部分追不到 | 轉租公告有同句，但那是另一份公告 | 標為推論，或找到公報後再寫 |
| 16 | 過度推論 | 3 節第 1 點、1.3「整個刪除」「一併刪除，改以第 11 款禁止」 | 這是修訂史的寫法。沒有證據顯示社宅範本由一般範本修改而來 | 社宅範本沿革只列自身函號 | 改為「社宅範本沒有這兩項，另有第 11 款」 |
| 17 | 錯誤 | 第 2 節 145 行短引；第 6 節「短引都在 15 字內」 | 短引 16 字，也不是逐字原文。第 6 節聲明因此不成立 | 條例 §7 第 2 項 | 去掉引號改寫，並更新聲明 |
| 18 | 補充 | 1.3 第 8 條第 1 項第 4 款 | 省略「但另有約定者，從其約定」。五日只是原則 | 社宅範本第 8 條第 1 項第 4 款 | 補上但書 |

### 信心標示檢查

條例列的【高】相稱。社宅列的【高】相稱。
公告列的【中】在筆記當時相稱，現在可升【高】。
「未查到修正」維持【中】。行政院頁只列 108 年公告，只能當間接證據。
【低】那一條（未勾選就沒有委託項目）標示正確。注意事項六也支持這個讀法。

---

## 二、Q10：點點簽費用、方案差異與簽署人驗證

### 總評：修正後可採用

API 欄位、列舉、必填條件與錯誤碼全部正確。
一條「查過但沒有」的負面主張是錯的。
方案門檻有官方線索，筆記沒讀到。

### 已核對清單

| 項目 | 方法 | 結果 |
|---|---|---|
| `verify_type` 列舉 `email`、`sms`、`twca_mid` | MCP `POST /v1/sign_tasks`，schema `VerifyMethodRequest` | 一致 |
| `verify_source`、`occasion`、`options.national_id_number` 與條件 | 同上 | 一致 |
| `sms` 必填條件；`twca_mid` 二選一可建立、兩者才能驗證成功 | 同上 | 一致 |
| `name`、`email` 必填；`email` 上限 250；`has_order` 預設 true | 同上 | 一致，見發現 11 |
| edit stage 要求 `has_order` 為 true | 400417 example-10 | 一致 |
| 400428、403068、403032、400220 | `POST` 回應範例 | 一致 |
| 403034、403068、406031 | `GET /v1/sign_tasks/read` 與 `/sign` 範例 | 一致，`sms` 範例屬實 |
| `verify_info` 五個欄位 | `POST /v1/sign_tasks/sign` schema | 一致 |
| 讀取範例 stage 的 `sequence` | 解析 read 範例 `details` | 簽署人 1、2、3 屬實。另有 owner 的 0 |
| `stages` 無 `maxItems` | `POST`、`PUT` schema | 屬實 |
| 稽核軌跡列舉 10 值、無 `verified`、範例有 `viewed` | `GET /v1/sign_tasks/audit_trails` | 一致 |
| 沙盒 5 個 stage、每 24 小時 20 個任務、驗證停用 | curl [沙盒頁原始 md](https://developer.dottedsign.com/docs/01-welcome-dottedsign-api-07-sandbox.md) | 三項都在官方表格 |
| webhook 8 個 payload 欄位、無驗證欄位、無範例 | curl [webhook 頁原始 md](https://developer.dottedsign.com/docs/03-about-dottedsign-api-02-webhooks.md) | 一致 |
| 定價頁方案、API 文字、滑桿 100、額度共用、超額 | WebFetch 三個定價頁 | 一致，都無金額 |

沒有呼叫 `execute-request`。

四個指定主張的判定：
- 「沙盒不支援任何驗證」：站得住。官方表格標 Disabled。項目含 SMS、Email OTP、A+ Sign、Mobile ID。
- 「每任務上限 5 個 stage」：站得住，但只限沙盒。正式環境確實未載明。
- 「每 24 小時 20 個任務」：站得住。定價頁也有同數字。
- 「webhook 沒有驗證結果欄位」：字面站得住，結論過寬，見發現 4。

### 發現表

| # | 等級 | 位置 | 問題 | 證據 | 建議修正 |
|---|---|---|---|---|---|
| 1 | 錯誤 | 「同一 email 兩個 stage」段：查過 `PATCH` 且「沒有重複 email 的錯誤碼」 | `PATCH` 有 400050 `forward_mail_already_in_flow`。第 3 節第 6 點又寫 `PATCH` 本次未查，自相矛盾 | MCP `PATCH /v1/sign_tasks/signer` 400 example-2 | 修正主張。此碼只涵蓋換簽署人，不代表建立任務會拒絕。沙盒測試加入此情境 |
| 2 | 補充 | 1 節 `twca_mid`「方案限制未列」；待釐清表 | MID 與憑證功能頁都寫「支援點點簽 DottedSign 企業版」。管理者必須在控制台開啟。P0-12 成本模型受影響 | [MID 頁](https://www.dottedsign.com/features/mid/)、[憑證頁](https://www.dottedsign.com/features/digital-certificate-cht/)，文字在頁面內嵌資料 | 列為【中】，並寫明是行銷頁。向業務確認商務方案是否可用 |
| 3 | 錯誤 | 1 節表 `twca_mid` 列 | 把工商憑證、自然人憑證、MID 整句對到 `twca_mid`。列舉只有 MID。憑證類在 `verify_type` 沒有對應值 | [changelog 1.0.9](https://developer.dottedsign.com/changelog/109)；`VerifyMethodRequest` 列舉 | 拆開寫。P0-12 補一條：API 不能用 `verify_type` 指定憑證類驗證 |
| 4 | 過度推論 | webhook 節；3 節 P0-12 第 4 點「不保證帶驗證結果」 | `verified` 事件本身表示一位簽署人驗證完成，且帶 `event_email` 與時間。缺的是驗證類型與失敗事件 | webhook 頁事件表與欄位表 | 改為「有 `verified` 事件；沒有驗證類型欄位與失敗事件；`other_info` 未載明」 |
| 5 | 過度推論 | webhook 節「MCP 沒有 webhook 的 spec，查過皆無結果」 | `search-endpoints` 搜不到 schema 與範例內容。已知存在的 `twca_mid`、`stage_need_verify` 也回無結果 | 本次實測；`list-specs` 列七份 spec，無 webhook | 改引 `list-specs`。其他靠此工具的負面結果都不能當證據 |
| 6 | 過度推論 | 結論「只能在正式環境測」 | 第 3 節自己列了業務測試帳號這條路。沙盒頁更新於 2025-10-27，早於 `twca_mid` 上線 2026-08-19 | 沙盒頁 `updatedAt`；changelog 1.0.9 | 改為「沙盒停用；頁面早於 `twca_mid`，須實測或問業務」 |
| 7 | 缺引用 | 1 節「日本比較站」「eSign.ai」 | 兩個來源都沒有 URL，來源清單也沒有 | 筆記來源清單 | 補 URL。我查到 [esign.ai](https://www.esign.ai/blog/dottedsign-electronic-signature-pricing-guide)。日本站可能是 saas.imitsu.jp，未能確認 |
| 8 | 缺引用 | 1 節 `sms`「進階驗證為 Pro 以上」 | 支援頁 403。搜尋摘要只見 SMS 限 Pro 訂閱者，未見「以上」或「進階驗證」 | 我也只能讀到搜尋摘要 | 刪除後半句。【低】維持 |
| 9 | 過度推論 | 3 節 P0-12 第 2 點「必須蒐集並保存這兩項」 | API 只要求送出，沒有要求本系統保存。保存是設計決定 | `VerifyMethodRequest` | 改為「必須蒐集並傳送；是否保存另行決定」。見發現 13 |
| 10 | 過度推論 | 3 節 ADR-0016 第 4 點「stage 順序決定簽署順序【高】」 | schema 沒寫陣列順序對應 `sequence`。範例只顯示讀回結果 | `SignTaskRequestCreate` | 降為【中】，列入沙盒測試 |
| 11 | 錯誤 | 2 節「stage 必填欄位只有 `name` 與 `email`」 | schema 的 required 如此，但 `field_settings` 描述寫 `stage_type` 為 `sign` 時必填 | `SignStageRequest` | 補上這個條件 |
| 12 | 補充 | 2 節 `stage_need_verify` 列 | 此錯誤也可能由帳號保護觸發，`verify_for` 為 `account_protect`。已註冊會員走 quick sign 會收到 401030 | `POST /v1/sign_tasks/sign` 403、401 範例 | 補一條。送簽流程必須區分兩種 `verify_for` |
| 13 | 補充 | 3 節 P0-12 | 讀取任務的回應 schema 含 `options.national_id_number`。回傳內容可能帶身分證字號 | `GET /v1/sign_tasks/read` schema `VerifyMethod` | 補入個資考量。不得把完整回應寫入日誌 |
| 14 | 補充 | 1 節 | 正式環境限 120 次／分鐘。任務額度另含自簽、公開表單、前台。筆記都沒列 | [Rate Limits 頁](https://developer.dottedsign.com/docs/03-about-dottedsign-api-05-rate-limits.md)；英文定價頁 | 補入第 1 節 |
| 15 | 錯誤 | 23、46 行短引 | 兩處超過 15 字：18 字與 29 字 | 字數計算 | 改寫，保留關鍵短語 |

### 信心標示檢查

MCP 列的【高】相稱。
沙盒與 webhook 的【中】偏保守。原始 md 可直接讀，建議升【高】。
「來源由抓取工具摘要」的提醒可以拿掉這兩頁。
`email`、`sms` 方案列的【低】相稱，來源只有搜尋摘要。

---

## 三、Q13：SQLite 改 PostgreSQL 的呼叫點

### 總評：修正後可採用

全部計數經獨立方法重算，結果相同。計數部分可直接採用。
必須修的是風險判斷：漏 `await` 的靜默點、SQLite 版交易的插隊、outbox。
工時假設有標明，符合要求。排程句有矛盾。

### 已核對清單

獨立方法：我的腳本只用語法樹與 import 繫結，不用 type checker。

| 項目 | 筆記 | 我的結果 | 判定 |
|---|---|---|---|
| `db.ts` 匯出 | 27（23 函式、1 const、2 interface、1 type） | 同左 | 一致 |
| 未匯出函式 | 4 個，行號 99、111、126、132 | 同左 | 一致 |
| production 呼叫點與檔案 | 45 點、19 檔 | 同左 | 一致 |
| 37 fn、4 `getDb`、4 `prepare` | 同左 | 同左，grep 也是 37 | 一致 |
| 測試呼叫點與檔案 | 140 點、6 檔 | 同左，六個檔案分項都相同 | 一致 |
| grep 行數 | 84 | 84 | 一致 |
| route handler | 18 檔、25 個、全部 async、24 個在連鎖內 | 同左，`meta` 不在連鎖內 | 一致 |
| 必須新變 async 的函式 | 5 個 | 實測相同，見下 | 一致 |
| `db.transaction` | 7 個，db.ts 之外 0 個 | 行號 101、116、206、272、295、312、339 | 一致 |
| 交易內有無外部 API | 無 | 讀 5 個 runtime 交易本體，只有 SQL 與純函式 | 一致 |
| 外部呼叫位置 | `send:37`、`void:18`、`contract-files:119,135` | 讀原始碼 | 一致 |
| `use server`、middleware、proxy | 0 | grep 與 find 都無結果 | 一致 |
| 筆記腳本預期輸出 | 4 行 | 重跑，4 行相同 | 一致 |

抽查呼叫點：我逐行印出全部 41 個 db 與 `getDb` 呼叫，與 2.1 表逐一比對，全部相符。
代表性 12 點：`audit-trail:11`、`copy:13`、`events:13`、`files:26`、`[id]/route:25`、`[id]/route:41`、`send:39`、`contracts/route:39`、`properties/[id]:42`、`webhooks:34`、`contract-files:191`、`transitions:69`。

連鎖完整性實測：我在 scratchpad 副本把 db 函式與 5 個連鎖函式改 async。然後跑 `tsc`。
沒有出現 `await` 用在非 async 函式的錯誤。5 個函式的清單完整。

### 發現表

| # | 等級 | 位置 | 問題 | 證據 | 建議修正 |
|---|---|---|---|---|---|
| 1 | 錯誤 | 4.5「共 13 處」 | 實測漏 `await` 而 `tsc` 不報錯的點有 24 處。13 處只涵蓋語句位置 | 見下方清單；`tsc` 實驗 | 改寫 4.5，列出 24 處 |
| 2 | 錯誤 | 4.5 建議；6.2「開 `no-floating-promises` 並清 13 處」 | 實測此規則只抓語句位置。9 處兩條規則都抓不到，因為 `Response.json` 參數是 `any` | type-aware ESLint 實驗 | 補 `no-misused-promises`。route 層必須有驗 response body 的測試 |
| 3 | 錯誤 | 5.4「不會被插隊」 | 只對不同 macrotask 成立。同一 tick 內兩個續行會交錯，第二個 `BEGIN` 被拒 | 實測 `better-sqlite3`：C 提交，D 被拒 | SQLite 版 `withTx` 必須加序列化佇列。步驟 1 工時隨之調整 |
| 4 | 過度推論 | 5.2「沿用即可，不需 outbox」 | 架構 6.4 寫對外呼叫一律走 outbox。同段也承認 `send` 有孤兒任務。這句超出量測範圍 | `architecture.md` 1830 行 | 改為「交易內無外部呼叫。是否走 outbox 依架構 6.4 另議」 |
| 5 | 錯誤 | Inferences「UI 全是 client component」 | `layout.tsx` 與 `design/page.tsx` 沒有 `'use client'`，依文件預設是 server component | `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` 第 11 行 | 改為「2 個 server component，都不碰 db」。4.6 本文正確 |
| 6 | 錯誤 | 6.2「17 個 route 檔｜41 個點」 | 37 含 `contract-files` 4 點與 `transitions` 1 點。route 檔是 36 點，加 `applyDsEvent` 共 39 點 | 2.1 表重算 | 改為 39 點。54 點總數不變 |
| 7 | 錯誤 | 5.3 `lastInsertRowid` 清單 | 漏 `db.ts:199`（`addCustomEquipmentItem`） | `grep lastInsertRowid src/lib/db.ts` | 補上 |
| 8 | 錯誤 | 6.2「用 8 人日排程，留 0.5 人日緩衝」 | 8 低於上限 8.5，沒有緩衝。6.3 又說兩項各可能多 1 人日 | 筆記 6.2、6.3 | 改為明確區間，或重算緩衝 |
| 9 | 過度推論 | 6.3「風險 6.4 在現況規模下不成立」 | 依據是估算。Gaps 自承沒有速度資料。發現 1、3 也會增加工作 | 筆記 Gaps；本節發現 | 改為「現況入口少，風險較低；待步驟 1 實作後更新」 |
| 10 | 錯誤 | 2.2 測試案例 54 | `vitest list` 是 58。`transitions.test.ts` 是 20，含 `it.each` 展開的 4 列 | `vitest list` | 改數字，或註明不計展開 |
| 11 | 補充 | 6.1 假設 4、架構 6.2 步驟 1 | `src/app` 下沒有任何測試檔。「vitest 全數通過」無法發現 route 層靜默錯誤 | `find src/app -name '*.test.*'` 無結果 | 冒煙測試必須檢查 response body，不能只看狀態碼 |

**發現 1 的 24 處清單。** 13 處同筆記 4.5。下列 11 處是新增：

| 位置 | 程式碼形式 | 漏 `await` 的後果 | `tsc` | ESLint |
|---|---|---|---|---|
| `contracts/route.ts:8` | `Response.json({ data: listContracts() })` | 回傳空物件 | 不報 | 不報 |
| `properties/route.ts:6` | 同上，`listProperties` | 同上 | 不報 | 不報 |
| `equipment-vocabulary/route.ts:8` | 同上，`listEquipmentVocabulary` | 同上 | 不報 | 不報 |
| `contracts/[id]/events/route.ts:13` | 同上，`listContractEvents` | 同上 | 不報 | 不報 |
| `contracts/[id]/files/route.ts:12` | 同上，`listContractFiles` | 同上 | 不報 | 不報 |
| `contracts/[id]/files/route.ts:26` | 同上 | 同上 | 不報 | 不報 |
| `contracts/[id]/route.ts:11` | 同上，`getContractRelations` | 同上 | 不報 | 不報 |
| `contracts/[id]/copy/route.ts:13` | `newId` 傳入 `Response.json` | 新 id 變空物件 | 不報 | 不報 |
| `contracts/route.ts:39` | `id` 傳入 `Response.json` | 同上 | 不報 | 不報 |
| `equipment-vocabulary/route.ts:16` | `if (!added)` | 409 分支不會觸發 | 不報 | `no-misused-promises` 抓到 |
| `contract-files.ts:107` | `!isSaved(...)` 在 `filter` 內 | 未帶 `force` 時清單變空 | 不報 | `no-misused-promises` 抓到 |

13 處之中，3 處 `.prepare().run()` 沒進實驗，因為它們還不是 repository 方法。其餘 10 處 `no-floating-promises` 全部抓到。
「回傳空物件」來自 Promise 經 JSON 序列化的行為。我沒有實際啟動伺服器驗證。

實驗腳本與結果都在 scratchpad，不在 repo：
- `/private/tmp/claude-501/-Users-miles-jian-Side-project-GitHub-rent-poc--claude-worktrees-adoring-easley-4d77af/1c9208a4-cdf0-449f-b735-3137576cb146/scratchpad/audit-q13.cjs`
- `/private/tmp/claude-501/-Users-miles-jian-Side-project-GitHub-rent-poc--claude-worktrees-adoring-easley-4d77af/1c9208a4-cdf0-449f-b735-3137576cb146/scratchpad/mkasync.cjs`
- `/private/tmp/claude-501/-Users-miles-jian-Side-project-GitHub-rent-poc--claude-worktrees-adoring-easley-4d77af/1c9208a4-cdf0-449f-b735-3137576cb146/scratchpad/microtask.cjs`
- `/private/tmp/claude-501/-Users-miles-jian-Side-project-GitHub-rent-poc--claude-worktrees-adoring-easley-4d77af/1c9208a4-cdf0-449f-b735-3137576cb146/scratchpad/tsc-stage2.txt`

**發現 3 的限制。** 我實測的是同一 tick 內的兩個續行。正式環境多常出現這種情況，我沒有量測。

### 工時與信心標示檢查

第 6.1 節標明 6 條假設，開頭也標明是估算。符合要求。分項加總無誤。
本筆記沒有用【高】【中】【低】，改用「量測」與「推論」區分。區分大致相稱，發現 3、4 除外。

---

## 四、Q21：稽核事件 hash chain 的外部錨定

### 總評：修正後可採用

第 1 至 5 節的事實大多可追溯。電子簽章法與 FreeTSA 的主張都成立。
「TWCA 精準度查不到」是錯的。
第 6 節建議 TWCA 為主錨，理由大多無法區分 TWCA 與中華電信，超出證據。

### 已核對清單

| 項目 | 來源 | 結果 |
|---|---|---|
| TWCA 提供 RFC 3161、年費制、會員期限內不限次數、API 在客戶後台 | [T1](https://www.twca.com.tw/product/ac8b6a90-77f2-4a20-ab9a-8bf671be81aa) | 一致 |
| TWCA 對民間開放 | [TWCA 實務作業基準](https://www.twca.com.tw/upload/saveArea/filePage/20220425/7ed58f7012d1455785e7f4336bd55d10/7ed58f7012d1455785e7f4336bd55d10.pdf) §4.3、§5.3：個人或組織皆適用 | 成立，證據比筆記更強 |
| 中華電信對民間開放；須先持憑證 | [T3](http://eca.hinet.net/download/eTSAPS-v1.1.pdf) §4.3、§5.3 | 成立 |
| 中華電信 RFC 3628、3161、5816、ETSI EN 319 421 | T3 | 一致 |
| 中華電信 ±1 秒、不保證不中斷與精準度、責任限制、會收費 | T3 §6.1.2、§6.4、第 9 點 | 一致 |
| eTSCA CPS v1.01，2020-04-30 公告 | [T5](https://eca.hinet.net/) | 一致 |
| GCA 憑證對象是政府機關 | [T4](https://gcp.nat.gov.tw/views/about/about_1.html) | 一致 |
| GCA CPS 提到政府機關設立時戳機構 | [T6](https://gca.nat.gov.tw/download/GCA_CPS_v2.0.1.pdf) 我讀到全文，版本紀錄 Ver1.3 有此項 | 支持筆記判斷 |
| MOICA、GCA 首頁抓取為空 | curl 回應分別只有 212 與 68 位元組 | 屬實 |
| FreeTSA 免費可商用、無 SLA、每 IP 每秒 1 次 | [I1](https://www.freetsa.org/freetsa.html) | 一致 |
| FreeTSA 專用實例 500 歐元、約 100 次／秒 | 同上 | 一致 |
| FreeTSA 憑證 2026-03 到期、新時戳有效至 2040-02 | [I1 首頁](https://www.freetsa.org/index_en.php) | 一致 |
| FreeTSA CPS 無日期、只有個人信箱 | [I7](https://www.freetsa.org/freetsa_cps.html) | 一致 |
| DigiCert、Sectigo 端點；Sectigo 間隔 15 秒 | [I2](https://knowledge.digicert.com/general-information/rfc3161-compliant-time-stamp-authority-server)、[I3](https://sectigo.com/resources/time-stamping-server) | 一致 |
| GlobalSign 三種類型、價格欄空白、高可用無數字 | [I4](https://globalsign.com/timestamp-service) | 一致 |
| QuoVadis 揭露聲明 2021 版、信賴者依正式文件 | [I5](https://digicert.com/content/dam/digicert/pdfs/legal/quovadis/archive/2023/qv-tsa-disclosure-statement-1.11-approved.pdf) 我讀到全文 | 一致，可去掉「僅見摘要」 |
| 電子簽章法修正日、主管機關 | [L1](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0080037) | 一致 |
| 電子簽章法全文無「時戳」「時間戳」 | curl 全文計數，兩者都是 0 次 | 成立 |
| 電子簽章法 §4、§6、§8②、§9 摘要 | 同上 | 一致 |
| 民事訴訟法 §363 | [L3](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=B0010001&flno=363) | 一致 |
| S3 Object Lock：root 不能刪、須版本控制、有 Cohasset 評估。刪帳號是唯一途徑 | [A1](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html) | 一致 |
| QLDB 2025-07-31 終止、建議 Aurora PostgreSQL | [A2](https://www.infoq.com/news/2024/07/aws-kill-qldb)，2024-07-26 | 一致，見下 |
| 週期計算 | 365、8,760、24 倍 | 算術正確 |

QLDB 判定：InfoQ 是 2024 年的預告。「已終止」的過去式是推論。
AWS 官方文件頁也回 404，我同樣沒取得官方公告。【中】相稱，可採用。

### 發現表

| # | 等級 | 位置 | 問題 | 證據 | 建議修正 |
|---|---|---|---|---|---|
| 1 | 錯誤 | 「查不到」表 TWCA 精準度；第 1 節；待辦 1 | TWCA 實務作業基準有寫。UTC ±1 秒、致力高可用、損害賠償依合約、視業務類型收費。筆記只查產品頁 | TWCA 基準 §5.1、§6.1.2、§6.4、§7.1.2。110-11-08 生效 | 補引並改待辦。SLA 百分比與價格仍查不到，這兩項維持 |
| 2 | 過度推論 | 第 6 節建議 A 的理由 | 「在地」「只傳雜湊」不能區分兩家。只傳雜湊是 RFC 3161 的做法。唯一差異是年費，金額未知 | 第 1 節；中華電信文件比 TWCA 更完整 | 改為 TWCA 與中華電信並列，取得兩家報價與條款後再選主錨 |
| 3 | 缺引用 | 第 6 節「持政府許可」 | 沒有引用。T1 沒寫。TWCA 基準只寫受電子簽章法等規範。許可對象是憑證機構，不一定含時戳服務 | TWCA 基準法律遵循段 | 刪除或補來源。中華電信也有同等條件 |
| 4 | 補充 | 第 1 節中華電信列；待辦 2 | 產品頁寫明 RESTful API、GPS 時間源、國家標準時間備援，並有專用聯絡窗口 | [中華電信時戳服務頁](https://chtca.hinet.net/solution-03.html) | 補入第 1 節與待辦。筆記只寫 TCP 或 HTTP |
| 5 | 過度推論 | 第 5 節「竄改偵測視窗 1 小時，縮短 23 小時」 | `verifyChain()` 每日才比對。每小時錨定時，偵測延遲仍可達約 24 小時。週期縮短的是可被重算的未錨定窗口 | `architecture.md` 1463、1465 行 | 欄名改為「未錨定窗口」，另列驗證頻率。架構 4.7 的句子也有同樣問題 |
| 6 | 過度推論 | 結論與第 5 節「週期改每小時，費用不變」 | T1 的不限次數沒有明說涵蓋 API。TWCA 基準也寫依業務類型收費 | T1；TWCA 基準 §7.1.2 第 14 點 | 加前提「待 TWCA 確認 API 用量同適用」 |
| 7 | 缺引用 | 第 3 節 L4 的案號與案情 | 打開引用 URL，全文無「1464」，也無「簡訊」。案號追不到 | curl [L4](https://lawplayer.com/article/6438cf92e800e5f0b9328d4b) 後計數，兩者都是 0 次 | 刪除，或查司法院裁判書系統確認後再引 |
| 8 | 過度推論 | 第 3 節「查到：法院對電子證據仍個案審查」 | 唯一依據是上一條追不到的二手來源。沒有標信心 | 筆記第 3 節 | 改為「未查到判決原文，待法務檢索」 |
| 9 | 補充 | 第 3 節「查到：沒有條文把時戳的證據力明文化」 | 實際只讀電子簽章法與民事訴訟法。全國法規資料庫「時戳」有 5 筆法條命中，筆記未揭露 | [檢索結果](https://law.moj.gov.tw/Law/LawSearchResult.aspx?cur=Ld&ty=ONEBAR&kw=%e6%99%82%e6%88%b3) | 寫明範圍並列出 5 筆。我讀 2 筆，都未規定證據力。其餘 3 筆未讀 |
| 10 | 過度推論 | 第 4 節 S3「與平台同屬雲端帳號風險」；B2 | 架構只寫 S3 相容物件儲存，沒有選定 AWS。「S3 相容」也不等於支援 Object Lock | `architecture.md` 424 行 | 標為假設，並補「須確認供應商支援 Compliance 模式」 |
| 11 | 缺引用 | 第 4 節 OTS「驗證不需信任日曆」「各自發 Bitcoin 交易」「志工」 | [A3](https://opentimestamps.org/) 與 [A4](https://github.com/opentimestamps/opentimestamps-server) 的 README 都沒有這些字句 | 我讀 A3 與 README，A4 原始碼未讀 | 補來源或標為推論。「捐款」與「無 API key」可追溯 |
| 12 | 過度推論 | 第 2 節「公開端點多半為程式碼簽署設計」 | 沒有來源。GlobalSign 頁有 AATL 與 Qualified 類型。DigiCert 頁沒談用途 | I2、I3、I4 | 改為「部分頁面以程式碼簽署為主要情境，用途條款待確認」 |
| 13 | 錯誤 | 45 行短引 | 16 字，超過 15 字。T6 當時只見摘要，也無法當逐字引用 | T6 版本紀錄的文字不同 | 改寫 |

### 選型建議是否超出證據

「不建議 FreeTSA 當唯一錨點」與「不建議 QLDB」有證據支持。
「TWCA 為主錨」超出證據，見發現 2、3。
附前提的寫法有減輕問題，但沒有對中華電信做同等比較。
副錨建議本身合理，但 B2 的前提未確認，見發現 10。

### 信心標示檢查

電子簽章法與 S3 的【高】相稱。
中華電信 ±1 秒引 [T2] 與 [T3] 標【高】。T2 只見摘要，依筆記定義不到【高】。建議只引 T3。
GCA 那條【低】可升【中】，全文已可讀。

---

## 五、未能核對的項目

| 項目 | 原因 |
|---|---|
| 行政院公報的委託管理公告原文 | 未找到公報頁。改以行政院消保專區 PDF 核對 |
| 內政部主管法規共用系統的委託管理條目 | 查相鄰編號與搜尋都沒找到條目頁 |
| 公告與範本是否有未公開的修正 | 只能查到無修正線索，屬負面結果 |
| 內政部對一般代管收押金的函釋 | 兩次搜尋未命中。未逐筆查地政司函釋系統 |
| 社宅包租代管計畫作業規定對押金的要求 | 搜尋未找到原文。只有媒體轉述 |
| 點點簽支援文章兩篇 | 403，只有搜尋摘要 |
| 點點簽方案比較表與金額 | 頁面內容未載入，定價頁無金額 |
| 正式環境的驗證行為與費用 | 不得呼叫正式 API |
| 同一 email 建立兩個 stage | 文件未載明，須沙盒實測 |
| QLDB 官方終止公告 | AWS 文件頁 404，部落格 URL 導向列表頁 |
| 台灣法院採信時戳的判決 | 未查司法院裁判書系統 |
| 含「時戳」的另外 3 筆法條內文 | 郵政、無人載具、醫事憑證收費看來無關，未逐條讀 |
| OpenTimestamps 原始碼 | 只讀 README 與官網 |
| Q13 那 11 處靜默點的實際回應內容 | 依 Promise 序列化行為推論，沒有啟動伺服器 |
