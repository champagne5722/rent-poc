# Q21 稽核事件 hash chain 的外部錨定服務選型

本筆記已依 [稽核報告](../audit/audit-phase1-map-research.md) 修正。

查閱日期：2026-11-07。對應 Linear MIL-50。

## 結論

- 台灣有兩家可由民間公司呼叫的 RFC 3161 時戳服務：TWCA 與中華電信 ePKI。【中】
- TWCA 採年費制，會員期間不限次數，並提供 API。【中】 週期從每日改每小時，費用可能不變。前提是 TWCA 確認 API 用量同適用。
- 中華電信的用戶必須先持有 ePKI 憑證，費用未查到。產品頁寫明 RESTful API、GPS 時間源與國家標準時間備援。【中】
- 政府憑證管理中心（GCA）只發憑證給政府機關，未查到對外時戳服務。【中】
- 國際服務裡，FreeTSA 無 SLA，不適合當唯一錨點。DigiCert、Sectigo、GlobalSign 的價格與 SLA 均未查到公開資訊。【中】
- 電子簽章法現行條文沒有任何條文提到時戳。【高】 時戳的舉證力必須由法務確認。
- TWCA 的精準度與可用性已在實務作業基準查到：UTC 正負 1 秒，致力高可用。SLA 百分比與價格仍查不到。【中】
- 建議：TWCA 與中華電信並列為主錨候選。取得兩家報價與條款後再選。副錨候選為 OpenTimestamps 或 S3 Object Lock，前提見第 6 節。最後的決定留給 grilling。

## 1. 台灣的 RFC 3161 服務

| 服務 | 是否提供 | 民間公司能否用 API | 費用 | SLA | 來源 |
|---|---|---|---|---|---|
| TWCA「TSA 時戳即服務」 | 有 | 可。API 文件在客戶後台「API 介接」，公開頁面未附規格。基準 §4.3、§5.3 寫個人或組織皆適用 | 年費制，會員期間不限次數。金額未查到。基準寫視業務類型收費 | SLA 百分比未查到。基準寫致力高可用 | [T1] [T8] |
| 中華電信 ePKI 時戳服務 | 有 | 請求走 TCP 或 HTTP。產品頁另寫 RESTful API。用戶必須先持有 ePKI 或其認可 CA 的憑證 | 會收費，金額未查到 | 「高可用性」，但不保證可用性與精準度。產品頁寫 GPS 時間源與國家標準時間備援，並有專用聯絡窗口 | [T3] [T9] |
| 內政部憑證管理中心（MOICA） | 未查到 | 未查到 | 未查到 | 未查到 | [T7] |
| 政府憑證管理中心（GCA） | 未查到對外服務 | GCA 憑證對象為政府機關 | 未查到 | 未查到 | [T4] |

### TWCA

- 遵循 IETF RFC 3161，簽發標準 Time-Stamp Token。【中】[T1]
- 只傳雜湊值，TWCA 不接收原始檔案。【中】[T1]
- 提供網頁介面與 API。API 時，業者必須自行計算雜湊。【中】[T1]
- 頁面稱時戳是「具法律效力的時間證據」，但沒有引用任何條文或判決。【中】[T1]
- 產品頁沒有寫時間精準度與可用性承諾。【中】[T1]
- TWCA 實務作業基準（110-11-08 生效）有寫：UTC 正負 1 秒，致力高可用，損害賠償依合約，視業務類型收費。出處為 §5.1、§6.1.2、§6.4、§7.1.2。【高】[T8]
- SLA 百分比與價格仍查不到。這兩項維持未查到。
- 申請方式是填聯絡表單，或電話 02-2370-8886 分機 9。【中】[T1]

### 中華電信 ePKI

- 時戳政策對齊 RFC 3628、RFC 3161、RFC 5816 與 ETSI EN 319 421。【高】[T3]
- 時間精準度在 UTC 正負 1 秒內。【高】[T3]。T2 只見搜尋摘要，不再當依據。
- 不保證服務不中斷，也不保證精準度。【高】[T3]
- 責任限於中華電信違反法律所造成的錯誤。不負擔利潤損失與間接損害。【高】[T3]
- 營運方式是收費，並與用戶簽訂合約。【高】[T3]
- 官網列出「時戳憑證管理中心 eTSCA」，CPS v1.01 於 2020-04-30 公告。【中】[T5]
- 產品頁寫明 RESTful API、GPS 時間源、國家標準時間備援，並有專用聯絡窗口。【中】[T9]
- 我只讀到實務作業基準（eTSAPS v1.1）的文字。eTSCA CPS 的內文本次未讀取。

### 政府機關

- GCA 的 CPS 版本紀錄 Ver1.3 有政府機關設立時戳機構的項目。稽核已讀全文。【中】[T6]
- 這只代表政府機關可以自建 TSA。它不代表政府對民間提供時戳服務。
- GCA 入口網頁說明憑證對象是政府機關（構）與單位。【中】[T4]
- 查過：gca.nat.gov.tw（頁面內容抓取為空）、moica.nat.gov.tw（抓取為空）、gcp.nat.gov.tw 與搜尋結果。
- 結論：未查到政府對民間的時戳 API。需要向 GCA 客服（02-2192-7111）確認才算查證完成。

## 2. 國際 RFC 3161 服務

| 服務 | 端點 | 費用 | SLA | 呼叫限制 | 來源 |
|---|---|---|---|---|---|
| FreeTSA | https://freetsa.org/tsr | 免費。可商用 | 無 SLA，盡力而為 | 每個 IP 每秒最多 1 次請求 | [I1] |
| FreeTSA 專用實例 | 另行配置 | 一年 500 歐元捐款 | 無 SLA | 設計約 100 次/秒 | [I1] |
| DigiCert | http://timestamp.digicert.com | 未查到 | 未查到 | 未查到。CertCentral API 的限制不適用此端點 | [I2] |
| Sectigo | http://timestamp.sectigo.com 與 /qualified（eIDAS） | 未查到 | 未查到 | 官方頁建議每次請求間隔 15 秒以上 | [I3] |
| GlobalSign | REST API，Qualified、AATL、Code Signing 三種 | 官網價格欄空白，需聯絡業務 | 只寫高可用，無百分比 | 只寫可處理數千請求，無數值 | [I4] |

### 補充

- FreeTSA 的 TSA 憑證於 2026 年 3 月到期。3 月 16 日起簽發的時戳有效至 2040 年 2 月。【中】[I1]
- FreeTSA 的 CPS 沒有日期，也沒有具名營運者，只有一個個人信箱。【中】[I7]
- DigiCert 頁面沒有提到使用條款。旗下 QuoVadis 的 TSA 揭露聲明（2021 版）要求信賴者依正式契約文件信賴時戳。稽核已讀全文。【中】[I5]
- 這份 QuoVadis 文件不一定適用公開端點。
- Sectigo 的免費狀態有衝突。官方頁沒寫價格，社群 gist 稱已不再免費。社群說法為【低】。[I6]
- 查過：DigiCert 知識庫與程式碼簽署產品頁（只有程式碼簽署憑證價格）、DigiCert 開發者文件、Sectigo 資源頁與 eIDAS 揭露聲明、GlobalSign 時戳頁。
- 部分頁面以程式碼簽署為主要情境，用途條款待確認。GlobalSign 頁另有 AATL 與 Qualified 類型，DigiCert 頁沒談用途。拿來錨定稽核事件前，必須與供應商確認條款。

## 3. 法律效力（只列原文與公開見解，不下結論）

**必須由法務確認。本節不是法律意見。**

### 電子簽章法

- 現行版修正於民國 113 年 5 月 15 日，主管機關為數位發展部。【高】[L1]
- 第 2 條定義電子簽章與數位簽章，沒有定義時戳。【高】[L1]
- 全文沒有任何條文使用「時戳」「時間戳記」或 timestamp。【高】[L1]
- 第 4 條：符合本法規定的電子文件與電子簽章，不得僅因電子形式而否認法律效力。【高】[L1]
- 第 6 條：以經許可憑證機構簽發的憑證所作的數位簽章，推定為本人親自簽名或蓋章。【高】[L1]
- 第 8 條第 2 項：電子文件得併同保存日期、時間與其他足以驗證真偽的資料。這裡沒有使用「時戳」一詞。【高】[L2]
- 第 9 條規範發文與收文時間，以進入資訊系統的時間為準。它不處理時戳。【高】[L1]

### 民事訴訟法

- 第 363 條：文書外的物件有與文書相同效用者，準用文書的規定。【高】[L3]
- 須以科技設備呈現內容者，得提出呈現內容的書面並證明與原件相符。【高】[L3]
- 原先引用的判決案號與案情已刪除。稽核打開引用 URL，全文無該案號，也無簡訊字樣，追不到。

### 本次查到與沒查到

- 查到：電子簽章法與民事訴訟法都沒有條文把時戳的證據力明文化。
- 範圍：本筆記只讀這兩部法。全國法規資料庫以「時戳」檢索有 5 筆法條命中，筆記原先未揭露。[檢索結果](https://law.moj.gov.tw/Law/LawSearchResult.aspx?cur=Ld&ty=ONEBAR&kw=%e6%99%82%e6%88%b3)
- 稽核讀了其中 2 筆，都未規定證據力。其餘 3 筆未讀，看來是郵政、無人載具、醫事憑證收費，似乎無關。
- 未查到判決原文，待法務檢索。
- 沒查到：台灣法院採信 RFC 3161 時戳的判決。
- 沒查到：數位發展部對時戳的函釋。
- 查過：全國法規資料庫、搜尋引擎。沒有查司法院裁判書系統。建議法務以「時戳」「電子存證」「第363條」檢索。
- 中國大陸的可信時間戳判決不能直接套用台灣。

### 對選型的含意（假設，待法務確認）

- 本平台的錨定目的是偵測重算，不是產出法庭證據。簽署舉證仍由點點簽 Audit Trail 承擔（ADR-0007）。
- 若這個定位成立，時戳的法律效力不是選型的硬條件。
- 若未來要拿稽核紀錄當訴訟證據，必須回頭請法務評估。

## 4. 其他錨定方式

| 方式 | 優點 | 缺點 | 信心 |
|---|---|---|---|
| AWS S3 Object Lock（Compliance 模式） | 任何使用者包括 root 都不能刪或覆寫。有 SEC 17a-4、CFTC、FINRA 的 Cohasset 評估 | 保護的是物件，不是時間。時間來源是 AWS。刪除帳號可繞過。若平台用同一雲端帳號，風險相同。架構只寫 S3 相容物件儲存，沒有選定 AWS，此點為假設。S3 相容也不等於支援 Object Lock，須確認供應商支援 Compliance 模式 | 【高】[A1] |
| Amazon QLDB | 無 | InfoQ 2024-07 預告 2025-07-31 終止服務，AWS 建議改用 Aurora PostgreSQL。已終止是推論，官方公告未取得。不可選 | 【中】[A2] |
| OpenTimestamps（Bitcoin） | 日曆伺服器免註冊、免 API key、免費（捐款與無 API key 可追溯）。驗證不需信任日曆（推論）。可用 Merkle 聚合 | 日曆靠捐款維運，由志工維運為推論。無 SLA。確認有延遲，官網未寫時間。Bitcoin 以外的鏈未支援。沒有 RFC 3161 的 CA 背書 | 【中】[A3] [A4] |
| 其他公鏈（以太坊等） | 公開、無單點 | 本次未逐一查證費用與穩定性 | 【低】 |

### 補充

- S3 Object Lock 必須在有版本控制的 bucket 才能使用。【高】[A1]
- Compliance 模式下，唯一的提早刪除途徑是刪除整個 AWS 帳號。【高】[A1]
- S3 的請求與儲存單價：未查到。查過 aws.amazon.com/s3/pricing，抓取結果缺價格表。
- 用量只有每年數百到數千個小物件，費用預期可忽略。這是推論，不是查證結果。
- OpenTimestamps 的每個日曆各自發 Bitcoin 交易，以及「驗證不需信任日曆」「志工」三點：A3 與 A4 的 README 都沒有這些字句，標為推論。A4 原始碼未讀。【低】

## 5. 錨定週期的影響

PRD P0-23 寫「每日」，架構 4.7 寫「每小時」。1 小時是架構的假設。本票只列影響，週期由 A 線決定。

### 呼叫次數

每個週期只送一個 Merkle 樹根，與組織數量無關。

| 項目 | 每日 | 每小時 | 差異 |
|---|---|---|---|
| 每年錨定呼叫 | 365 | 8,760 | 24 倍 |
| 每年存的時戳憑證筆數（`audit.anchors`） | 365 | 8,760 | 24 倍 |
| 未錨定窗口（可被重算而未被錨定的區間） | 最長 24 小時 | 最長 1 小時 | 縮短 23 小時 |
| 竄改偵測延遲（`verifyChain()` 每日才比對） | 約 24 小時 | 仍可達約 24 小時 | 不變 |

週期縮短的是未錨定窗口，不是偵測延遲。依 `architecture.md` 1463、1465 行，`verifyChain()` 每日比對。架構 4.7 的相關句子也有同樣問題。
加上 `verifyChain()` 每日驗證，不會增加錨定呼叫。若驗證時要查回執，另有讀取成本，本次未估。

### 費用

| 服務 | 每日（365 次） | 每小時（8,760 次） | 差異 |
|---|---|---|---|
| TWCA | 年費制，會員期間不限次數 | 同左 | 0（金額未查到。前提：API 用量同適用，待 TWCA 確認。基準寫視業務類型收費） |
| 中華電信 ePKI | 未查到計價方式 | 未查到 | 無法計算 |
| FreeTSA | 0 | 0 | 0。但 8,760 次無 SLA 保障 |
| DigiCert、Sectigo | 未查到 | 未查到 | 無法計算 |
| GlobalSign | 需聯絡業務 | 需聯絡業務 | 無法計算 |
| OpenTimestamps | 0（捐款制） | 0 | 0 |

### 呼叫限制檢查

- FreeTSA：每 IP 每秒 1 次。每小時 1 次遠低於限制。
- Sectigo：官方頁建議間隔 15 秒以上。每小時 1 次也遠低於限制。

### 影響摘要

- 若選 TWCA 年費制，且 TWCA 確認 API 用量同適用，週期不影響費用，只影響憑證儲存量。
- 若選按次計費的服務，費用差 24 倍。必須先取得報價才能算。
- 週期越短，錨定失敗的重試與告警越頻繁。必須定義失敗時的行為。

## 6. 選型建議

這些建議附前提。最後的決定留給 grilling。

### 建議 A：TWCA 與中華電信並列為主錨候選

- 前提 1：取得兩家的報價與條款。年費金額目前都未知。
- 前提 2：API 規格可由業者使用。TWCA 的規格在客戶後台，中華電信有 RESTful API 產品頁。
- 前提 3：兩家的 SLA 百分比都要書面確認。TWCA 基準寫致力高可用，中華電信文件寫不保證不中斷。
- 前提 4：法務確認時戳的角色，見第 3 節。
- 比較：「在地」與「只傳雜湊」不能區分兩家。只傳雜湊是 RFC 3161 的做法。目前唯一差異是年費，金額未知。
- 中華電信的用戶必須先持有 ePKI 憑證。這是額外步驟。
- 取得報價與條款前，不選主錨。

### 建議 B：加一個獨立副錨

- 前提：主錨單點中斷時，不能讓稽核寫入停擺。
- 選項 B1：OpenTimestamps。免費，驗證不需信任營運者，但有確認延遲且無 SLA。
- 選項 B2：S3 Object Lock Compliance 模式。前提是平台使用的物件儲存供應商支援 Compliance 模式，架構尚未選定 AWS，此點為假設。若與平台同屬一家雲端供應商，單一供應商風險仍在。
- 理由：兩個錨點由不同組織營運，可降低單一供應商風險。

### 不建議

- 不建議以 FreeTSA 為唯一錨點。無 SLA，營運者資訊不透明。
- 不建議使用 QLDB。已終止服務。

### 待 grilling 決定

1. 錨定目的是偵測竄改，還是產出訴訟證據？這決定法律效力是否為硬條件。
2. 週期取每日或每小時？A 線決定。
3. 是否需要副錨？
4. 錨定失敗時，稽核寫入是否繼續？

### 待辦（外部確認）

1. 向 TWCA 取得報價、API 規格、SLA 百分比書面說明，並確認 API 用量是否同適用於不限次數。精準度已見基準，可請 TWCA 確認。
2. 向中華電信 ePKI 確認個人或組織憑證申請與時戳費用，並向產品頁的專用窗口確認 RESTful API 規格。
3. 向 GCA 客服確認是否對民間提供時戳。
4. 請法務確認第 3 節。
5. 請 DigiCert、Sectigo、GlobalSign 提供條款（僅在考慮國際備援時）。

## 查不到的項目

| 項目 | 查過的地方 |
|---|---|
| TWCA 價格、SLA 百分比、API 規格 | twca.com.tw 首頁與產品頁（價格與 API 在客戶後台）。精準度已在實務作業基準查到 |
| 中華電信時戳費用 | eca.hinet.net、時戳實務作業基準。eTSCA CPS 內文未讀取 |
| MOICA 與 GCA 對民間的時戳 | moica.nat.gov.tw、gca.nat.gov.tw（抓取為空）、gcp.nat.gov.tw、搜尋結果 |
| DigiCert、Sectigo 費用與 SLA | 官方知識庫、產品頁、開發者文件 |
| GlobalSign 價格 | 官方時戳頁（價格欄空白） |
| S3 請求與儲存單價 | aws.amazon.com/s3/pricing（抓取缺價格表） |
| 台灣法院對 RFC 3161 時戳的判決 | 全國法規資料庫、搜尋引擎。未查司法院裁判書系統 |
| 數位發展部對時戳的函釋 | 搜尋引擎 |
| 其他公鏈的錨定費用 | 未逐一查證 |
| AWS 官方的 QLDB 終止公告原文 | AWS 文件頁 404，部落格頁抓取未含日期，改用 InfoQ |

## 引用清單

### 台灣時戳服務

- [T1] TWCA，TSA 時戳即服務。https://www.twca.com.tw/product/ac8b6a90-77f2-4a20-ab9a-8bf671be81aa 查閱 2026-11-07。
- [T2] 中華電信，時戳服務政策 v1.0（2017-04-12）。http://eca.hinet.net/download/TSA_CP_v1.0.pdf 搜尋結果摘要，查閱 2026-11-07。
- [T3] 中華電信，時戳實務作業基準 eTSAPS v1.1（2019-10-09）。http://eca.hinet.net/download/eTSAPS-v1.1.pdf 查閱 2026-11-07。
- [T4] GCP 政府憑證入口網，GCA 介紹。https://gcp.nat.gov.tw/views/about/about_1.html 查閱 2026-11-07。
- [T5] 中華電信 ePKI 首頁。https://eca.hinet.net/ 查閱 2026-11-07。
- [T6] GCA 憑證實務作業基準 v2.0.1。https://gca.nat.gov.tw/download/GCA_CPS_v2.0.1.pdf 稽核已讀全文，查閱 2026-11-07。
- [T7] 內政部憑證管理中心。https://moica.nat.gov.tw/ 抓取為空，查閱 2026-11-07。
- [T8] TWCA 實務作業基準（110-11-08 生效）。https://www.twca.com.tw/upload/saveArea/filePage/20220425/7ed58f7012d1455785e7f4336bd55d10/7ed58f7012d1455785e7f4336bd55d10.pdf 稽核報告補入。
- [T9] 中華電信時戳服務頁。https://chtca.hinet.net/solution-03.html 稽核報告補入。

### 國際時戳服務

- [I1] FreeTSA 首頁與使用政策。https://www.freetsa.org/index_en.php 與 https://www.freetsa.org/freetsa.html 查閱 2026-11-07。
- [I2] DigiCert RFC 3161 說明。https://knowledge.digicert.com/general-information/rfc3161-compliant-time-stamp-authority-server 查閱 2026-11-07。
- [I3] Sectigo 時戳伺服器。https://sectigo.com/resources/time-stamping-server 查閱 2026-11-07。
- [I4] GlobalSign Timestamping-as-a-Service。https://globalsign.com/timestamp-service 查閱 2026-11-07。
- [I5] QuoVadis TSA 揭露聲明 v1.11。https://digicert.com/content/dam/digicert/pdfs/legal/quovadis/archive/2023/qv-tsa-disclosure-statement-1.11-approved.pdf 稽核已讀全文，查閱 2026-11-07。
- [I6] 社群 gist（Sectigo 狀態）。https://gist.github.com/Manouchehri/fd754e402d98430243455713efada710 僅見搜尋摘要，查閱 2026-11-07。
- [I7] FreeTSA CPS。https://www.freetsa.org/freetsa_cps.html 查閱 2026-11-07。

### 法律

- [L1] 電子簽章法（113-05-15 修正）。https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0080037 查閱 2026-11-07。
- [L2] 電子簽章法第 8 條。https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=J0080037&flno=8 查閱 2026-11-07。
- [L3] 民事訴訟法第 363 條。https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=B0010001&flno=363 查閱 2026-11-07。
- [L4] 已移除。LawPlayer 評析的案號與案情追不到。
- [L5] 全國法規資料庫「時戳」檢索結果。https://law.moj.gov.tw/Law/LawSearchResult.aspx?cur=Ld&ty=ONEBAR&kw=%e6%99%82%e6%88%b3 查閱 2026-11-07。

### 其他錨定方式

- [A1] AWS，S3 Object Lock。https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html 查閱 2026-11-07。
- [A2] InfoQ，AWS 終止 QLDB（二手來源，2024-07-26 預告）。https://www.infoq.com/news/2024/07/aws-kill-qldb 查閱 2026-11-07。
- [A3] OpenTimestamps 官網。https://opentimestamps.org/ 查閱 2026-11-07。
- [A4] OpenTimestamps server 原始碼。https://github.com/opentimestamps/opentimestamps-server 查閱 2026-11-07。
- [A5] 專案內文件：`docs/research/asset-mgmt-platform/prd.md` P0-23（936 至 961 行）、`architecture.md` 4.7 節（1454 至 1491 行）。

## 信心標示說明

- 【高】官方原文直接支持。
- 【中】官方頁面支持，但有缺漏，或僅見搜尋摘要。
- 【低】二手來源、社群說法，或推論。

## 稽核修正紀錄

依 [稽核報告](../audit/audit-phase1-map-research.md) 第四節。13 條發現全部套用。

| 發現 | 處理方式 |
|---|---|
| 1 | 補 TWCA 基準的精準度、可用性、賠償與收費。待辦 1 改寫。SLA 百分比與價格維持未查到 |
| 2 | 建議 A 改為 TWCA 與中華電信並列，取得報價前不選主錨 |
| 3 | 刪除「持政府許可」 |
| 4 | 補中華電信產品頁的 RESTful API、GPS 時間源與專用窗口，並加入待辦 2 |
| 5 | 欄名改為未錨定窗口，另列偵測延遲。標註架構 4.7 有同樣問題，本筆記不改架構 |
| 6 | 結論與第 5 節加前提：待 TWCA 確認 API 用量同適用 |
| 7 | 刪除判決案號與案情，移除 L4 |
| 8 | 改為未查到判決原文，待法務檢索 |
| 9 | 寫明檢索範圍，揭露 5 筆命中。報告只給 3 筆的大意，另 2 筆已讀的名稱報告未列，故未寫名稱 |
| 10 | S3 與 B2 標為假設，補須確認供應商支援 Compliance 模式 |
| 11 | OTS 三句標為推論並降為【低】，捐款與無 API key 保留 |
| 12 | 改為部分頁面以程式碼簽署為主要情境，用途條款待確認 |
| 13 | 長引改寫，T6 改為已讀全文 |

信心調整：中華電信 ±1 秒只引 T3。GCA 那條由【低】升【中】。QuoVadis 去掉僅見摘要。QLDB 維持【中】並註明已終止是推論。
