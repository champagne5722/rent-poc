# 十家不動產平台的商業模式畫布（BMC）與系統模組清單

調研日期：2026-10-30。以 2026-10 現況為準。範圍：591、Bananas、JGB Smart Property、僑馥建經、第一建經、AppFolio、Buildium、Yardi（Voyager 與 Breeze）、貝殼找房（KE Holdings）、PropertyGuru。

來源品質分級（沿用 r3）：一級是官網頁面或公司財報新聞稿，本次實際讀到；二級是第三方彙整或搜尋摘要；三級是行銷頁或單方說法。標「推論」的是我的判斷。標「未查到」代表搜尋或讀取後沒有結果，不是「不存在」。

本筆記的讀取限制，報告撰寫者請先看：
- AppFolio 開發者網站（developer.appfolio.com）與 Yardi 官網產品頁（yardi.com/product/...）讀取失敗（頁面是前端渲染，或回 403）。這兩家的 API 資源清單只能靠第三方彙整，信心低於 Buildium。
- Buildium 開發者頁面（developer.buildium.com）是把整份 OpenAPI 規格內嵌在 HTML 裡。我用 curl 下載後，以 regex 抽出所有帶引號的 `/v1/...` 路徑（共 298 條不重複路徑），這是我自己解析的結果，不是官方資源清單頁。第三方彙整稱該 API 有 326 個 endpoint（含同一路徑的多個 HTTP 方法），兩者差異來自計算單位不同。
- PropertyGuru 官網與 businesswire 新聞稿回 403，模組清單幾乎讀不到。591、貝殼、PropertyGuru 沒有對外的 API 文件。
- 工具呼叫約 46 次，略超過 45 次上限（最後一次是寫檔）。

---

## 1. 十家公司逐家檔案：BMC 九格、模組清單、資料模型線索、整合介面

### Takeaway
十家分成四型：刊登廣告型（591、PropertyGuru）、租賃管理 SaaS 型（Bananas、JGB、AppFolio、Buildium、Yardi）、買賣資金保管型（僑馥、第一建經）、交易佣金加加盟型（貝殼）。只有貝殼同時做買賣、租賃、裝修，且以交易佣金為主；SaaS 型只做租賃管理，買賣只出現在 AppFolio 與 Yardi 的「投資管理」。沒有任何一家公開宣稱涵蓋台灣語境的「屋主資產總覽、報表、稅務」三合一。

### Cited Findings

#### 1.1 591 房屋交易網（數字科技，台灣）

BMC 九格

| 格 | 內容與來源 |
|---|---|
| 客群 | 房東與屋主（自刊）、經紀人、建築與代銷公司；租客與買方免費使用。來源：[591 首頁導覽](https://www.591.com.tw/)（有「房東/代理人」「經紀人」「建築/代銷公司幫助」） |
| 價值主張 | 流量與曝光：日流量約 100 萬人次、會員 465 萬、線上物件超過 50 萬筆（2024 法說會，第三方整理）；買方工具含房貸試算器、實價登錄、環景 720 專區。來源：[富果研究 5287 法說會](https://blog.fugle.tw/post/earnings-call-5287-2025-03-31)；[591 首頁](https://www.591.com.tw/) |
| 通路 | 網站、數字 App（「591APP 隨時隨地找房」）；公司稱靠 AI 工具、社群內容與行銷活動維持成長。來源：[591 首頁](https://www.591.com.tw/)；[聯合新聞網](https://udn.com/news/story/7254/9373900) |
| 顧客關係 | 自助為主：「AI自助服務」含套餐延期、修改物件資料、極速退點、7-11 儲值；另有在線客服、電話客服、客服信箱。來源：[591 首頁](https://www.591.com.tw/) |
| 收入來源 | 刊登費（住宅每筆 30 天：普通 400、超級 VIP 999、黃金曝光 1,699 元）、多筆套餐、加值（定時更新 150 元/15 天、加急標籤 150 元/30 天、精選推薦 1,500 元/30 天、行動版置頂 400 元/30 天）、售屋套餐（給經紀人，3 筆 1,200 元至 35 筆 9,800 元）、新建案廣告與列表排序方案、圖片廣告。不收成交佣金。來源：[591 收費標準](https://www.591.com.tw/home/help/chargeIntro/1)；[591 售屋套餐](https://www.591.com.tw/home/help/chargeIntro/2)；[roo.cash](https://roo.cash/blog/?p=48813) |
| 關鍵資源 | 流量與品牌、物件庫、會員資料。公司自稱市占超過八成（自述，未驗證）。來源：[富果研究](https://blog.fugle.tw/post/earnings-call-5287-2025-03-31) |
| 關鍵活動 | 平台營運、廣告銷售、客服、內容與行銷。刊登審核流程未查到。 |
| 關鍵夥伴 | 經紀人、建設與代銷公司；選單可見「裝修服務」「室內設計」「好日子驗屋」「修水電」（導流服務，合作對象未讀到）；7-11 儲值。來源：[591 首頁](https://www.591.com.tw/) |
| 成本結構 | 未拆分。公司整體毛利率 2024 約 69.8%；2025 合併營收 23.19 億元、營業淨利 9.25 億元，591 占營收 69%。來源：[富果研究](https://blog.fugle.tw/post/earnings-call-5287-2025-03-31)；[聯合新聞網](https://udn.com/news/story/7254/9373900) |

模組清單（十類，用 591 自己的名稱）

| 類別 | 模組 |
|---|---|
| 物件與單位 | 「所有物件」「地圖找房」「社區找房」「屋主物件」「獨立套房/整層住家/分租套房/雅房」分類；以刊登物件為單位，無房東端的單位管理 |
| 租賃與合約 | 「租屋手冊」「契約下載」（租屋工具）；未見線上簽約 |
| 買賣與交易 | 「新建案」「預售屋」「中古屋」「法拍屋」「屋主委賣」「降價物件」「急售物件」「土地」「店面」「辦公」「廠房」；「房貸試算器」「實價登錄」「找經紀人」 |
| 帳務與金流 | 點數儲值、退點、7-11 儲值（平台自身收費用）；無租金或價金金流 |
| 維修與工單 | 無（「修水電」「好日子驗屋」為導流） |
| 租客或買方入口 | 「會員中心」 |
| 身分與權限 | 註冊、登入；身分分流為「房東/代理人」與「經紀人」；實名或權狀驗證流程未查到 |
| 報表 | 無對房東的報表；買方端有「實價登錄」「最新房貸利率」 |
| 整合與 API | 未查到公開 API |
| 行動裝置 | 數字 App、591APP |

來源（模組表）：[591 首頁](https://www.591.com.tw/)

資料模型線索：以「刊登物件（listing）」為中心，上層有「社區」，沒有 property、unit、lease、tenant、owner 的層級。推論自首頁導覽，591 不是管理系統。

整合介面：7-11 儲值；無公開 API、webhook、電子簽章。

#### 1.2 Bananas（台灣，租屋管理）

BMC 九格

| 格 | 內容與來源 |
|---|---|
| 客群 | 房東、包租代管業者、房仲、租客；約半數社宅包租代管業者是客戶。來源：[Bananas 官網](https://www.bananas.com.tw)；[鏡週刊 2026-10-02](https://www.mirrormedia.mg/story/20261002fin001) |
| 價值主張 | 「簽署租約線上化」「租金對帳自動化」「一站式管理」「100% 租金保障服務」；業者用「BMS 物件管理系統」。來源：[Bananas 官網](https://www.bananas.com.tw) |
| 通路 | 網站、iOS、Android；租客端有「Bananas 租客 APP」。業者客戶通路未查到。來源：[Bananas 官網](https://www.bananas.com.tw) |
| 顧客關係 | App 自動提醒繳款；客服信箱 services@bananas.com.tw。來源：[Bananas 官網](https://www.bananas.com.tw)；[App Store](https://apps.apple.com/app/id1626379117) |
| 收入來源 | 管理費約 6%（公司自述，媒體專訪）；租金保障方案（「啾安心」）；BMS 軟體費。官網只放「方案價格」連結，價格本次未讀到。來源：[鏡週刊](https://www.mirrormedia.mg/story/20261002fin001)；[Bananas 官網](https://www.bananas.com.tw) |
| 關鍵資源 | 託管戶數近 4 萬（2024 年近 1 萬）；591 創辦人王震宇投資並成為主要股東；已獲利（自述）。來源：[鏡週刊](https://www.mirrormedia.mg/story/20261002fin001) |
| 關鍵活動 | 軟體開發、租金收付與對帳、租金保障的風險控管（自稱壞帳率低於 1%）。來源：[鏡週刊](https://www.mirrormedia.mg/story/20261002fin001) |
| 關鍵夥伴 | 銀行信託帳戶（文中提到凱基銀行配合）；社宅包租代管業者；兆基也與其合作。來源：[鏡週刊](https://www.mirrormedia.mg/story/20261002fin001) |
| 成本結構 | 未公開。 |

模組清單

| 類別 | 模組 |
|---|---|
| 物件與單位 | 「BMS 物件管理系統」（單位層級細節未查到） |
| 租賃與合約 | 「簽署租約線上化」：電子合約、合約管理、雲端存放 |
| 買賣與交易 | 無 |
| 帳務與金流 | 「租金對帳自動化」、帳務管理、租金帳單「支援線上支付」；信託收付見鏡週刊，官網未提信託 |
| 維修與工單 | BMS 內有「追蹤管理維修狀態」「計算維修費用」 |
| 租客或買方入口 | 「Bananas 租客 APP」：自動提醒繳款、每月自動產生帳單 |
| 身分與權限 | BMS「組織共同管理」；多層次驗證（密碼與圖像識別） |
| 報表 | 「即時數據報表」「雲端報表」「數據分析」 |
| 整合與 API | 官網未提供 API 或第三方整合資訊；另有「金啾管理系統」(jjj.bananas.com.tw)，與 BMS 的關係未說明 |
| 行動裝置 | iOS、Android App（租客端為確定；房東端 App 官網只寫多平台支援） |

來源（模組表）：[Bananas 官網](https://www.bananas.com.tw)；[App Store 租客 App](https://apps.apple.com/app/id1626379117)

資料模型線索：官網用「物件」「合約」「帳務」「維修」四類，單位層級未見。電子簽章技術與法律效力官網未說明。

整合介面：銀行信託收付（媒體報導）；無公開 API。

#### 1.3 JGB Smart Property（金箍棒，台灣）

BMC 九格

| 格 | 內容與來源 |
|---|---|
| 客群 | 各規模的中小型租賃管理業者、屋主、租客。來源：[JGB 官網](https://www.jgbsmart.com) |
| 價值主張 | 租約、租戶、租期、租金、修繕管理，雲端存放租約，刊登空置房源，會計，智慧居家設備串接，即時績效分析。來源：[JGB 官網](https://www.jgbsmart.com) |
| 通路 | 官網、LINE 官方帳號（搜尋結果列出，內容未讀）。來源：[搜尋結果](https://page.line.me/902nacdp) |
| 顧客關係 | 訂閱制；租客可免註冊簽約（電子簽）。來源：[JGB 官網](https://www.jgbsmart.com)；本 repo [JGB 實測筆記](../../../jgb-competitor-and-official-contract.md) |
| 收入來源 | 訂閱（價格未公開，官網無方案頁）；付款提到「一次性虛擬帳號」，金流費率未查到。來源：[JGB 官網](https://www.jgbsmart.com) |
| 關鍵資源 | 員工約 20 人；最近一輪 2022-12 Seed 約 US$1.8M（第三方資料庫，二級）；IoT 設備串接能力。來源：[Yourator](https://www.yourator.co/companies/jgbsmart)；[CB Insights](https://www.cbinsights.com/company/jgb-smart-property/financials) |
| 關鍵活動 | 軟體開發與營運；智慧設備整合。 |
| 關鍵夥伴 | IoT 硬體（後台「裝置管理」含門鎖、智慧電錶、攝影機、小白盒）；電子簽供應商未查到。來源：本 repo [JGB 實測筆記](../../../jgb-competitor-and-official-contract.md) |
| 成本結構 | 未公開。 |

模組清單（側欄原名，來自 2026-08-02 登入實測）

| 類別 | 模組 |
|---|---|
| 物件與單位 | 「物件管理」下的「社區總表」「物件總表」；物件編輯 wizard：基本資料、標題與照片、附設家具、核實訊息、720 VR、物件介紹、建物謄本、廣告資訊 |
| 租賃與合約 | 「租約管理」：合約 wizard（承租方資訊、租賃契約、點交、出租方資訊、選填）；合約生命週期：待發送、待租客簽回、待管理者簽名、執行中、歷史；類型分 DIY 與電子簽 |
| 買賣與交易 | 物件「廣告資訊」可選招租或買賣（只到廣告層，無成交流程） |
| 帳務與金流 | 「帳務管理」（實測筆記未展開）；合約內「租金費用」「帳單設定」「收款方式」；一次性虛擬帳號 |
| 維修與工單 | 「修繕管理」 |
| 租客或買方入口 | 租客簽回（可免註冊）；官網稱租客、屋主、廠商溝通協作 |
| 身分與權限 | 「人員管理」；「其他設定」的簽約資訊（出租方預設資料跨合約重用） |
| 報表 | 「總覽」；官網稱「即時績效分析」 |
| 整合與 API | 「裝置管理」（IoT 串接）；公開 API 未查到 |
| 行動裝置 | 官網稱手機或平板即可管理（搜尋摘要）；原生 App 未確認 |

來源（模組表）：本 repo [JGB 實測筆記](../../../jgb-competitor-and-official-contract.md)；[JGB 官網](https://www.jgbsmart.com)

資料模型線索：社區 → 物件 → 租約 → 承租方；設備採三層（平台詞彙、物件設備清單、合約點交快照），合約快照與物件脫鉤。無跨物件的家電資產個體管理。以上出自實測筆記。

整合介面：IoT 裝置、虛擬帳號收款、電子簽（供應商未知）、可上傳內政部契約附件。

#### 1.4 僑馥建經（台灣，履約保證）

BMC 九格

| 格 | 內容與來源 |
|---|---|
| 客群 | 買賣雙方、不動產經紀業、地政士（特約）、建商（預售屋履約擔保）。來源：[僑馥 業務介紹](https://www.ctop.tw/escrow/services)；[預售屋履約擔保](https://www.ctop.tw/finance/guarantee) |
| 價值主張 | 價金進銀行信託專戶，與銀行及僑馥財務獨立；簽約當場發保證書；買賣方、經紀業、地政士可用作業系統與 APP 查進度與價金；不與仲介業相互投資。來源：[僑馥 履保特色](https://www.ctop.tw/escrow/featured) |
| 通路 | 經紀業與特約地政士導入案件；住商 2.0 履約保證合作（土地與建物分由僑馥、安新處理）。來源：[理財周刊 2022-09-26](https://www.moneyweekly.com.tw/ArticleData/Info/Article/89780/) |
| 顧客關係 | 案件制，簽約當場發保證書；糾紛案例頁；進度查詢。來源：[僑馥 履保特色](https://www.ctop.tw/escrow/featured)；[糾紛案例](https://www.ctop.tw/escrow/flaw) |
| 收入來源 | 履約保證費：官網未列費率。市場行情約成交價萬分之二至六，常由買賣雙方各半。專戶利息按銀行牌告活儲計給客戶（不是僑馥收入）。預售屋履約擔保、建築融資、都更信託另有業務，收費未查到。來源：[僑馥 FAQ](https://www.ctop.tw/escrow/faq)；[工商時報 2023-09-13](https://www.ctee.com.tw/news/20230913701296-430605) |
| 關鍵資源 | 合作銀行（中國信託、第一銀行）、特約地政士網絡、保證能力與品牌；董事長稱可服務住商 1,000 多家加盟店。來源：[僑馥 業務介紹](https://www.ctop.tw/escrow/services)；[理財周刊](https://www.moneyweekly.com.tw/ArticleData/Info/Article/89780/) |
| 關鍵活動 | 履保審核、製作結算表、撥款、預售屋工程進度查核與財務稽核。來源：[預售屋履約擔保](https://www.ctop.tw/finance/guarantee) |
| 關鍵夥伴 | 中國信託、第一銀行（專戶）；特約地政士；經紀業；住商。 |
| 成本結構 | 專戶撥出的匯款手續費由僑馥吸收；其餘未公開。來源：[僑馥 FAQ](https://www.ctop.tw/escrow/faq) |

模組清單

| 類別 | 模組 |
|---|---|
| 物件與單位 | 無（以「案件」為單位） |
| 租賃與合約 | 無（只見買賣）；履約保證專用買賣契約書、保證書、履約保證申請書（紙本文書） |
| 買賣與交易 | 買賣價金履約保證；預售屋履約擔保；建築融資、都更信託；「糾紛案例」 |
| 帳務與金流 | 銀行信託專戶（每案專屬 14 碼帳號）、結算、撥款、「履約保證費發票查詢」 |
| 維修與工單 | 無 |
| 租客或買方入口 | 「買賣方案件查詢」 |
| 身分與權限 | 「經紀業與地政士登入」；「特約地政士名單」；「加入特約地政士／線上申辦履約保證」 |
| 報表 | 下載專區、發票查詢（無分析報表） |
| 整合與 API | 銀行信託專戶；公開 API 未查到 |
| 行動裝置 | 有 APP（官網稱作業系統與 APP 可查進度，APP 名稱未讀到） |

來源（模組表）：[僑馥 業務介紹](https://www.ctop.tw/escrow/services)；[履保特色](https://www.ctop.tw/escrow/featured)；[履保流程頁](https://www.ctop.tw/escrow/procedure)；[加入合作](https://www.ctop.tw/escrow/join)

資料模型線索：「案件」是核心，掛買方、賣方、標的、價金、專戶、地政士、經紀業。無 unit、lease 層級。

整合介面：銀行專戶（中信帳號前五碼 81623、第一銀行前五碼 28500）；電子發票；地政士以傳真與系統交換稅單文件。來源：[僑馥 業務介紹](https://www.ctop.tw/escrow/services)；[r1 筆記整理](./r1-taiwan-b2b-services.md)

#### 1.5 第一建經（台灣，履約保證）

BMC 九格

| 格 | 內容與來源 |
|---|---|
| 客群 | 買賣方、地政士、經紀業。來源：[第一建經官網](https://www.first1.com.tw/) |
| 價值主張 | 買賣雙方經經紀業成交後，以銀行信託專戶管理價金；提供系統、APP、LINE Bot 追蹤案件。來源：[第一建經官網](https://www.first1.com.tw/) |
| 通路 | 經紀業與地政士；iOS/Android APP；LINE Bot（@firstrobot）。來源：[第一建經官網](https://www.first1.com.tw/) |
| 顧客關係 | 買賣方、地政士、經紀業各有登入入口；LINE Bot 查詢。來源：同上 |
| 收入來源 | 履保費：官網不列收費。市場行情見 1.4。來源：[第一建經官網](https://www.first1.com.tw/) |
| 關鍵資源 | 合作銀行（永豐、第一、台新）；永豐信託網查詢頁聲明專戶委託人與受益人都是第一建經（搜尋摘要）。來源：[第一建經官網](https://www.first1.com.tw/)；[永豐信託網](https://trust.sinopac.com/ETrust/Web/PT/PT0001/53549920) |
| 關鍵活動 | 價金管控、案件進度追蹤、文件索取與下載。 |
| 關鍵夥伴 | 永豐銀行、第一銀行、台新銀行；第一銀行官網也把它列為四家合作建經之一。來源：[第一銀行 建經公司履保價金](https://www.firstbank.com.tw/sites/fcb/1565687622858) |
| 成本結構 | 未公開。 |

模組清單

| 類別 | 模組 |
|---|---|
| 物件與單位 | 無（案件制） |
| 租賃與合約 | 無（只見買賣）；索取契約 |
| 買賣與交易 | 價金履約保證 |
| 帳務與金流 | 銀行信託專戶、收款追蹤、「電子發票專區」 |
| 維修與工單 | 無 |
| 租客或買方入口 | 買賣方登入系統 |
| 身分與權限 | 買賣方、地政士、經紀業三種登入 |
| 報表 | 文件下載；分析報表未查到 |
| 整合與 API | LINE Bot；銀行專戶；公開 API 未查到 |
| 行動裝置 | iOS、Android APP |

來源（模組表）：[第一建經官網](https://www.first1.com.tw/)

資料模型線索與整合介面：同 1.4，案件制；官網未公開欄位細節。

#### 1.6 AppFolio（美國，上市）

BMC 九格

| 格 | 內容與來源 |
|---|---|
| 客群 | Single Family、Multifamily、Commercial、Community Associations（HOA）、Student Housing、Affordable Housing；截至 2025 年底管理約 940 萬單位、客戶 22,096 家（客戶數為二級）。來源：[AppFolio 物管頁](https://www.appfolio.com/property-manager)；[Nasdaq 新聞稿搜尋摘要](https://www.nasdaq.com/press-release/appfolio-inc-announces-fourth-quarter-and-fiscal-year-2025-financial-results-2026-01) |
| 價值主張 | 單一雲端平台涵蓋會計、出租、工單、行動工具，加 AI 助理 Realm-X。來源：[AppFolio Pricing](https://www.appfolio.com/pricing) |
| 通路 | 官網「Get a Quote」；AppFolio Stack Marketplace（整合市集）。來源：[AppFolio 物管頁](https://www.appfolio.com/property-manager) |
| 顧客關係 | Standard Support（Core）、Enhanced Support（Plus）、Dedicated Customer Success Management（Max）；「Staffing & Training」。來源：[AppFolio Pricing](https://www.appfolio.com/pricing)；[AppFolio 物管頁](https://www.appfolio.com/property-manager) |
| 收入來源 | FY2025 營收 $951M：Core solutions 約 $211.5M、Value Added Services 約 $721.5M（約 76%）、其他約 $17.8M。軟體費每單位每月：Core $1.49、Plus $3.20、Max $5.00（有最低消費與單位數門檻，Core 下限 50 單位）。10-K 稱 Value Added Services 的絕大部分來自電子支付、租客篩選與風險減輕服務，部分為訂閱制、部分按次計費；支付收入以總額認列（搜尋摘要，二級）。來源：[FY2025 新聞稿](https://seekingalpha.com/pr/20381847)；[AppFolio Pricing](https://www.appfolio.com/pricing)；[10-K](https://www.sec.gov/Archives/edgar/data/1433195/000143319526000011/appf-20251231.htm) |
| 關鍵資源 | 940 萬單位的資料、Realm-X AI、Stack 整合生態。來源：同上 |
| 關鍵活動 | 軟體研發、支付與篩選營運、AI 功能（Realm-X Flows、Leasing Performer、Accounting Performer）。來源：[AppFolio Pricing](https://www.appfolio.com/pricing) |
| 關鍵夥伴 | Stack Standard 與 Premium Integrations 的第三方（名單未讀到）。 |
| 成本結構 | FY2025 GAAP 營運利益 $153M（16.1%）；non-GAAP $235M（24.7%）；成本細項本次未取得。來源：[FY2025 新聞稿](https://seekingalpha.com/pr/20381847) |

模組清單（官網原名；方案欄標示於括號）

| 類別 | 模組 |
|---|---|
| 物件與單位 | 「Inspections & Unit Turns」（Core）；「Custom Fields」（Plus）；底層資料為 properties、units（見資料模型） |
| 租賃與合約 | 「End-to-End Marketing & Leasing」（Core）；「Leasing CRM」「Leasing Signals」（Max）；「Realm-X Leasing Performer」；「Affordable Housing Capabilities」「Student Housing Capabilities」（Plus）；電子簽名官網物管頁未列 |
| 買賣與交易 | 無買賣成交；物管頁列有「Investment Management」（投資人管理，細節未讀到） |
| 帳務與金流 | 「Property Accounting & Reports」（Core）；「Advanced Budgeting & Accounting」（Plus）；「Accounting Performer」（Bill Entry & Financial Close 在 Plus、Budgeting 在 Max）；「Purchase Orders & Inventory Tracking」（Core）；「Maintenance Scheduling & Automated Billing」（Plus）。支付與篩選的產品名官網定價頁未列 |
| 維修與工單 | 「Work Order Management」（Core） |
| 租客或買方入口 | 住戶端「FolioSpace Online Portal」「Resident Experience」；屋主端「Owner Portal」（物管頁僅見登入入口，功能細節未讀到） |
| 身分與權限 | 「Scale & Control」（Plus，內容未讀到）；開發者角色見資料模型 |
| 報表 | 「Advanced Data Analysis」（Plus）；「Accounting & Reporting」 |
| 整合與 API | 「AppFolio Stack Standard Integrations」（Core）、「Premium Integrations」（Plus）；「AppFolio API (read only)」（Plus）；「AppFolio API (read/write)」（Max）；「Realm-X Flows」（Plus） |
| 行動裝置 | 「Mobility & Convenience」（Core）；App 名稱未讀到 |

來源（模組表）：[AppFolio Pricing](https://www.appfolio.com/pricing)；[AppFolio 物管頁](https://www.appfolio.com/property-manager)

資料模型線索：Stack API（夥伴用，唯讀）公開 15 個 endpoint，資源為 bills、charges、properties、units、tenants、work-orders、vendors、bank accounts、attachments；owners 與 occupancies 不在已知清單。來源：[Jentic AppFolio](https://jentic.com/apis/appfolio)；[搜尋摘要](https://docs.propexo.com/pms-guidance/appfolio/integration-and-partnership)（二級）。Database API（客戶用）是報表式介面，網址形如 `https://<公司>.appfolio.com/api/v1/reports`，以 Client ID 與 Client Secret 授權，限 System Administrator 產生。來源：[Aptly 整合說明](https://aptly.helpkit.so/integrations/vVQpukZPcgx25GULuxrwjv/integrating-aptly-with-appfolio-api-plus-and-max-users/7eBtxbAky1ZW98PUBWt4Kx)。

整合介面：Stack 夥伴 API（OAuth 2.0，需夥伴註冊，二級說法）；Database API 限 Plus（唯讀）與 Max（可選唯讀或讀寫）；Stack Marketplace；webhook、電子簽章、金流商名稱本次未查到。來源：[Supergood 搜尋摘要](https://supergood.ai/api-report-card/appfolio)。

#### 1.7 Buildium（RealPage 旗下，美國）

BMC 九格

| 格 | 內容與來源 |
|---|---|
| 客群 | 小型房東與中小物管、社區協會（官網列「Community Associations」）；超過 5,000 單位需電話洽詢。來源：[Buildium Pricing](https://www.buildium.com/pricing/)；[Buildium Features](https://www.buildium.com/features/) |
| 價值主張 | 會計、出租、維修、入口網站與 AI 助理一套；透明定價。來源：[Buildium Pricing](https://www.buildium.com/pricing/) |
| 通路 | 官網自助訂閱與定價頁；Buildium Marketplace；Buildium Academy、Help Hub、Training & Webinars。來源：[Buildium Features](https://www.buildium.com/features/) |
| 顧客關係 | Onboarding、Customer Care；Growth 起有 Live Phone Support；Premium 有 Priority Support；Buildium Rewards。來源：同上；[Buildium Pricing](https://www.buildium.com/pricing/) |
| 收入來源 | 訂閱：Essential $65、Growth $202、Premium $420 起（月）。交易費：入帳 EFT $2.35 / $1.35 / 首 12 月免費後 $0.60；出帳 EFT $0.99；信用卡 2.99%；銀行帳戶設定 $99；eSignature $5 / $1 / 無限；租客篩選 $17（Growth 起 Enhanced $20；申請人付費 $35）；租客險每戶每月 $12 起；1099 e-Filing 每批 $50 加每張 $4.50；Showings Coordinator 每月 $41 起；遠端列印支票 $30 設定加每張 $1.50；房屋檢查 $99 設定加月費 $40 至 $95。來源：[Buildium Pricing](https://www.buildium.com/pricing/) |
| 關鍵資源 | RealPage 母公司；Open API 與 Marketplace 生態。來源：[r3 筆記](./r3-international-benchmarks.md) |
| 關鍵活動 | 軟體研發、支付與篩選整合、AI（官網稱 Agentic AI、Buildium's AI Assistant）。來源：[Buildium Features](https://www.buildium.com/features/) |
| 關鍵夥伴 | TransUnion（篩選）、MSI（租客險）、Nelco（1099）、Tenant Turner（看房協調）、HappyCo（檢查）、PayNearMe（現金繳款）、RevSpring（支票與郵寄）、Dropbox Sign（電子簽）、All Property Management（潛在客戶服務）。來源：[Buildium Pricing](https://www.buildium.com/pricing/) |
| 成本結構 | 未公開（子公司，無獨立財報）。 |

模組清單（官網原名）

| 類別 | 模組 |
|---|---|
| 物件與單位 | 「Property Management Website」；「Custom Fields」（Growth）；底層 rentals、units（見資料模型） |
| 租賃與合約 | 「Online Leasing」「Tenant Screening」「Rental Listing Syndication」「eSignature」「Showings Coordinator」 |
| 買賣與交易 | 無 |
| 帳務與金流 | 「Property Accounting」「Collect Rent Online」（ePay）「Bank Reconciliation」「EFT Approvals」「Bank Account Setup」「1099 e-Filing」「Retail Cash Payments」「Remote Check Printing」 |
| 維修與工單 | 「Maintenance Requests」「Maintenance Contact Center」「Task and Work Order Management」「Property Inspections」 |
| 租客或買方入口 | 「Resident Center」「Resident Center Resources」；屋主端「Property Owner Portal」（定價頁寫 Owners Portal） |
| 身分與權限 | 「Staff Time Tracking」（定價頁列）；API 有 users、userroles（見資料模型）；細部權限模組名稱未讀到 |
| 報表 | 「Standard & Bulk Reporting」「Customized Reports」「Custom Dashboard」「Business Performance」「Analytics & Insights」 |
| 整合與 API | 「Buildium Marketplace」「Open API」（Premium）「Workflow Automations」（Premium） |
| 行動裝置 | 官網功能頁與定價頁均未列 App（未查到，不代表沒有） |

來源（模組表）：[Buildium Pricing](https://www.buildium.com/pricing/)；[Buildium Features](https://www.buildium.com/features/)

資料模型線索（Buildium 是十家裡唯一能讀到完整 API 路徑結構的，來源：[Buildium 開發者頁面](https://developer.buildium.com/)，內嵌 OpenAPI 規格，路徑為我解析）：

| 資源群（`/v1/` 之下） | 路徑數 | 下層結構 |
|---|---|---|
| rentals | 40 | 物件 `/rentals/{propertyId}`；單位 `/rentals/units`、`/rentals/units/{unitId}`（含 amenities、images、notes、listing、listingcontacts）；屋主 `/rentals/owners`；appliances 及其 servicehistory；meterreadings、epaysettings、vendors |
| leases | 43 | 租約 `/leases/{leaseId}`；承租人 `/leases/tenants`；charges、credits、payments、refunds、recurringcharges、recurringpayments、renewals、moveouts、applieddeposits、rentersinsurance、epaysettings、partialpaymentsettings |
| associations | 65 | 社區協會 → ownershipaccounts、owners、units、tenants、boardmembers、committees、architecturalrequests、appliances；帳務結構與 leases 對稱 |
| applicants / applications | 10 / 11 | 申請人與申請單、groups |
| bankaccounts / glaccounts / generalledger / bills / budgets / creditcardaccounts | 26 / 3 / 5 / 9 / 2 / 8 | 帳務骨幹 |
| tasks | 19 | categories、contactrequests、rentalownerrequests、residentrequests、todorequests、history |
| workorders / vendors / inventoryassets / assetcategories | 2 / 11 / 1 / 1 | 維修與資產 |
| communications / files / customfields / propertygroups / users / userroles / clientleads | 11 / 7 / 5 / 2 / 2 / 2 / 2 | 通用 |
| administration | 3 | account、accountinglockperiod、residentsettings/partialpaymentsettings |

層級：Rental property → Unit；Lease 是頂層資源，掛承租人（tenant）與單位；Rental owner 掛在 rentals 之下；協會（association）是另一條平行的資料線，owner 透過 ownershipaccount 對應單位。

整合介面：REST；憑證用 client-id 與 secret 一組（規格出現 `client-id` 字樣）；沙盒 apisandbox.buildium.com（二級）；webhook 存在（二級來源提到 Payment、Tenant、Lease 事件，簽章 HMAC-SHA256），但我解析的規格路徑中沒有 webhook 資源，事件名稱與訂閱方式未查到官方說明。來源：[Metro2 整合指南搜尋摘要](https://metro2.switchlabs.dev/integrations/buildium)；[Carly 部落格](https://www.usecarly.com/blog/buildium-api/)。API 方案門檻說法衝突：定價頁只在 Premium 列 Open API；另有第三方指南稱 Essential、Growth 也能用。

#### 1.8 Yardi（Voyager 與 Breeze，美國，私人公司）

BMC 九格（兩個產品線分欄）

| 格 | Voyager（大型） | Breeze（小型） |
|---|---|---|
| 客群 | 住宅、商用、補助型、senior 等多品類單一資料庫。來源：[ERP Research 搜尋摘要](https://erpresearch.com/en-us/yardi-voyager-software) | 住宅、商用、補助型（Premier）、協會（Premier）、自助倉儲與 MH（洽詢）。來源：[Yardi Breeze Pricing](https://yardibreeze.com/pricing) |
| 價值主張 | 官方稱「統一資料庫」整合應付、應收、總帳與報表。來源：[Yardi SaaS Answers](https://www.yardi.com/blog/yardi-saas-answers/) | 簡化版住宅管理，公開定價 |
| 通路 | 業務報價；Standard Interface Partnership Program 夥伴 | 官網公開定價與表單 |
| 顧客關係 | 未查到 | 「Setup & Support」 |
| 收入來源 | 議價，依單位數、物件類型、雲端或地端、模組組合；不公開價格。來源：[ERP Research](https://erpresearch.com/en-us/yardi-voyager-software)（二級） | 住宅 Breeze $1/單位/月、最低 $100；Premier 現頁寫 $1（附條款）、最低 $400（r3 曾記 Premier 起價 $2，綁定篩選與租客險簽 12 個月降為 $1，兩者差異可能是頁面改版，以現頁為準）；商用 Breeze $2、最低 $200；補助型 Premier $3、最低 $400；協會 Premier $1、最低 $400。加購（未標價）：ScreeningWorks Pro、Bill Pay；Premier 另有 RentCafe Property Websites、RentCafe Chat IQ、Investment Manager、Utility Billing、Utility Invoice Processing、CHECKscan Full Service、PayScan Full Service、RentCafe Connect、ScreeningWorks Pro Income Verification。來源：[Yardi Breeze Pricing](https://yardibreeze.com/pricing)；[r3 筆記](./r3-international-benchmarks.md) |
| 關鍵資源 | 單一資料庫、SQL Server 技術棧（招募文推論）、夥伴介接計畫。來源：[招募文](https://portfoliojobs.cerberus.com/companies/firstkey-homes-2/jobs/41994047-yardi-developer)（推論） | RentCafe 房源網站、PayNearMe 等 |
| 關鍵活動 | 軟體研發與實施顧問（推論） | 軟體研發 |
| 關鍵夥伴 | 介面夥伴，類別含 Master Data API、Maintenance API（搜尋摘要）；租金支付、租客篩選、租客險不開放給夥伴，保留給 Yardi 自家模組（Supergood 的解讀，二級）。來源：[Supergood](https://supergood.ai/api-report-card/yardi-voyager) | PayNearMe；RentCafe.com 等房源網站。來源：[Yardi Breeze Pricing](https://yardibreeze.com/pricing) |
| 成本結構 | 未公開（私人公司） | 未公開 |

模組清單

| 類別 | Voyager（二級，官網產品頁讀取失敗） | Breeze（一級） |
|---|---|---|
| 物件與單位 | 統一資料庫下的物件與單位；模組名未讀到 | 「Property Management」 |
| 租賃與合約 | 行銷、出租（marketing、leasing） | 「Marketing & Leasing」 |
| 買賣與交易 | 無買賣成交；有 investment management（投資會計，模組名稱見 Breeze Premier 加購「Investment Manager」） | 無；「Investment Manager」加購 |
| 帳務與金流 | 應收（含住戶開帳單、自動或手動收款）、應付、總帳、Payment Processing、Online Payments、CHECKscan、procurement、invoice processing | 「Rent Collection」「Accounting」「Accounts Payable」 |
| 維修與工單 | maintenance management、energy management | 「Maintenance」；24/7 維修客服中心加購（名稱未讀到） |
| 租客或買方入口 | RentCafe 住戶入口（出租、續約、繳租、報修） | 租客入口與 App；Premier 另有商用租客入口、投資人入口、CRM |
| 身分與權限 | 未查到；Yardi 說明租戶入口可選 MFA | 「Owner Tools」（屋主入庫、按持分比例管理物件、計算屋主付款並保留準備金、屋主報表經 email 或入口網站分享） |
| 報表 | 內建報表（細節未讀到） | 屋主報表等 |
| 整合與 API | Standard Interface Partnership Program；Master Data API；Maintenance API | 列表網站、PayNearMe；API 官網未提 |
| 行動裝置 | 未查到 | 租客 App、Premier 另有 |

來源（模組表）：[Yardi Breeze Pricing](https://yardibreeze.com/pricing)；[Yardi Breeze 搜尋摘要](https://softwareconnect.com/reviews/yardi-breeze/)；[Yardi Voyager 搜尋摘要](https://www.yardi.com/documents/voyager_residential.pdf/)

資料模型線索：Voyager 官方說法是統一資料庫；Master Data API 可取得 resident/tenant、unit、lease、property 資料，Maintenance API 取得工單。Breeze Owner Tools 顯示有「物件持分（ownership fraction）」概念，即物件可有多位屋主。完整 schema 未公開。

整合介面：Voyager 為 SOAP web services 加有限 REST，只對通過 Standard Interface Partnership Program 的夥伴開放；第三方稱夥伴須成立 2 年以上且有 3 家以上 Voyager 客戶（Supergood 的說法，二級，未經 Yardi 確認）。金流為自家 Yardi Payment Processing。

#### 1.9 貝殼找房（KE Holdings，中國，上市）

BMC 九格

| 格 | 內容與來源 |
|---|---|
| 客群 | 買賣方與租客（C 端）；經紀人與門店（B 端，含鏈家自營與加盟、連接品牌）；裝修客戶；開發商（新房）。2025 年底門店 61,139 間、經紀人 523,009 人（活躍 445,632 人）。來源：[KE FY2025 新聞稿](https://finviz.com/news/337356/ke-holdings-inc-announces-fourth-quarter-and-fiscal-year-2025-unaudited-financial-results-and-a-final-cash-dividend) |
| 價值主張 | 「integrated online and offline platform for housing transactions and services」；樓盤字典作為真房源底層（2020 年報導累積逾 2.4 億戶資料，舊資料）；ACN 讓跨店經紀人按貢獻分佣。來源：[KE 新聞稿](https://finviz.com/news/337356/ke-holdings-inc-announces-fourth-quarter-and-fiscal-year-2025-unaudited-financial-results-and-a-final-cash-dividend)；[投資界 2020-08](https://news.pedaily.cn/20200811/3864.shtml) |
| 通路 | Beike App、Lianjia App、Weixin Mini Programs；實體門店；行動 MAU 2025 Q4 平均 43.8M。來源：[KE 新聞稿](https://finviz.com/news/337356/ke-holdings-inc-announces-fourth-quarter-and-fiscal-year-2025-unaudited-financial-results-and-a-final-cash-dividend) |
| 顧客關係 | 經紀人面對面服務為主（推論：新聞稿以經紀人與門店規模作主要營運指標）。 |
| 收入來源 | FY2025 淨營收 RMB 94.6B：存量房 25.0B（-11.3%）、新房 30.6B（-9.1%）、家居裝修與家具 15.4B（+4.4%）、住房租賃 Carefree Rent 21.9B（+52.8%，按服務費淨額認列）、其他 1.6B。交易佣金（鏈家總額認列；連接經紀人以平台、加盟與加值服務費淨額認列）為主體。外部仲介成交時平台抽成比例官方未公開。來源：[KE 新聞稿](https://finviz.com/news/337356/ke-holdings-inc-announces-fourth-quarter-and-fiscal-year-2025-unaudited-financial-results-and-a-final-cash-dividend)；[36氪](https://www.36kr.com/p/818016195353991)（三級，前員工說法約 8 個點） |
| 關鍵資源 | 鏈家品牌、樓盤字典、經紀人網絡、現金與短投 RMB 55.5B。來源：同上 |
| 關鍵活動 | 平台營運、ACN 規則維護、租賃營運、裝修與家具。 |
| 關鍵夥伴 | 加盟與連接品牌（搜尋摘要提到 Deyou）、經紀人、房東。Shell Finance 等金融業務新聞稿未提。來源：[EDGAR 搜尋摘要](https://keholdings.gcs-web.com/news-releases/news-release-details/ke-holdings-inc-files-its-annual-report-form-20-f-4) |
| 成本結構 | FY2025 營業成本 RMB 74.4B（毛利率 21.4%）：佣金分成 20.9B、內部佣金與薪酬（鏈家經紀人）17.7B、租賃成本 20.0B（+47.0%）、裝修成本 10.6B、門店 2.9B、其他 2.4B。營業費用 18.1B：銷售與行銷 7.3B、一般行政 8.1B、研發 2.6B。淨利 RMB 2,991M（-26.7%）。來源：[KE 新聞稿](https://finviz.com/news/337356/ke-holdings-inc-announces-fourth-quarter-and-fiscal-year-2025-unaudited-financial-results-and-a-final-cash-dividend) |

模組清單（只能從新聞稿與報導整理，沒有官方功能頁，信心中低）

| 類別 | 模組 |
|---|---|
| 物件與單位 | 樓盤字典（楼盘字典）；ACN 的房源端角色：錄入人、維護人、實勘人、鑰匙人 |
| 租賃與合約 | 住房租賃 Carefree Rent（租賃佣金與租期管理費）；合約功能未查到 |
| 買賣與交易 | 存量房、新房交易；ACN 客源端角色：推薦人、成交人、合作人（最多拆 10 個角色，二級） |
| 帳務與金流 | 佣金分成機制；Shell Finance 等金流產品新聞稿未提，未查到 |
| 維修與工單 | 家居裝修與家具（裝修業務）；租賃維修未查到 |
| 租客或買方入口 | Beike App、Lianjia App、Weixin Mini Programs |
| 身分與權限 | ACN 角色權限；經紀人與門店管理 |
| 報表 | 未查到 |
| 整合與 API | 未查到公開 API |
| 行動裝置 | Beike App、Lianjia App |

來源（模組表）：[KE 新聞稿](https://finviz.com/news/337356/ke-holdings-inc-announces-fourth-quarter-and-fiscal-year-2025-unaudited-financial-results-and-a-final-cash-dividend)；[36氪](https://www.36kr.com/p/3728533793813248)；[投資界 2020-07](https://news.pedaily.cn/202007/457862.shtml)

資料模型線索：以樓盤字典的「房屋（戶）」為主資料，交易按角色拆分；租賃另有租期管理。無 property-unit-lease-tenant 的公開層級。

整合介面：無公開 API；金流與電子簽章未查到。

#### 1.10 PropertyGuru（新加坡，EQT 私有化）

BMC 九格

| 格 | 內容與來源 |
|---|---|
| 客群 | 消費者（約 4,000 萬月訪客，2022 年資料）；經紀人（月連接逾 5 萬人，2024）；開發商；銀行與估價師。來源：[Phillip Securities 報告（2022-09）](https://www.poems.com.sg/stock-research/PGRU/propertyguru-group-ltd-dominant-property-platform)；[Q2 2024 新聞稿](https://www.silicon.co.uk/press-release/propertyguru-reports-second-quarter-2024-results) |
| 價值主張 | 對經紀人與開發商：觸及買方；對金融機構：貸款導流與資料服務。 |
| 通路 | 入口網站與 App（官網讀取失敗，未確認） |
| 顧客關係 | 經紀人續約率 81%（新加坡，2024 Q2）。來源：[Q2 2024 新聞稿](https://www.silicon.co.uk/press-release/propertyguru-reports-second-quarter-2024-results) |
| 收入來源 | 經紀人年費訂閱（新加坡、馬來西亞、泰國、印尼，分級）；越南按刊登數計費；加值（如「exposure booster」）；開發商數位廣告；SaaS 流程自動化；房貸仲介佣金（新加坡）；資料服務訂閱。2021 年約 41% 營收來自經紀人訂閱（2022 年舊資料）。來源：[Phillip Securities 報告](https://www.poems.com.sg/stock-research/PGRU/propertyguru-group-ltd-dominant-property-platform) |
| 關鍵資源 | 逾 210 萬筆刊登（2024 H1）；市占：新加坡 76%、馬來西亞 96%、越南 75%（2022 年券商報告引用）。來源：同上；[Q2 2024 新聞稿](https://www.silicon.co.uk/press-release/propertyguru-reports-second-quarter-2024-results) |
| 關鍵活動 | 平台營運、廣告銷售、貸款導流、資料服務。 |
| 關鍵夥伴 | 貸款機構；母公司 EQT（2024-12 完成 US$11 億私有化）。來源：[OnlineMarketplaces](https://onlinemarketplaces.com/articles/eqt-completes-acquisition-of-propertyguru-group) |
| 成本結構 | 2023 年營收 S$150M、調整後 EBITDA S$19M；2025 年私有化後裁員逾 170 人並關閉房貸與居家服務。來源：[r3 筆記](./r3-international-benchmarks.md)（內含 businesswire 與 OnlineMarketplaces 引用） |

2024 H1 營收 S$77.2M：新加坡 48.5M、馬來西亞 14.1M、越南 8.6M、其他亞洲 3.1M、Fintech 與資料服務 2.9M。來源：[Q2 2024 新聞稿](https://www.silicon.co.uk/press-release/propertyguru-reports-second-quarter-2024-results)

模組清單（官網讀取失敗，以下只含券商報告與新聞稿的描述，多數類別為未查到）

| 類別 | 模組 |
|---|---|
| 物件與單位 | 房源刊登（逾 210 萬筆） |
| 租賃與合約 | 未查到（租賃刊登是否為獨立產品線未確認） |
| 買賣與交易 | 房源刊登、開發商廣告；房貸仲介（新加坡；2025 年已關閉，r3） |
| 帳務與金流 | 無 |
| 維修與工單 | 無（居家服務已關閉，r3） |
| 租客或買方入口 | 消費者搜尋（細節未讀到） |
| 身分與權限 | 經紀人帳號與訂閱分級（細節未讀到） |
| 報表 | 「Data Services」訂閱（專有市場資料與工作流工具） |
| 整合與 API | 未查到 |
| 行動裝置 | 未查到 |

資料模型線索：以「刊登」與「經紀人」為主；無 property-unit-lease-tenant。

整合介面：未查到公開 API；貸款導流對接銀行（細節未查到）。

### Inferences
- 推論：十家的「核心計費單位」分三種：刊登則數（591、PropertyGuru 越南）、每單位每月（AppFolio、Yardi Breeze、r3 的 Entrata）、案件或成交額（僑馥、第一建經、貝殼）。Bananas 的 6% 管理費是租金比例，屬第四種。台灣平台設計時要早決定計費單位。
- 推論：Buildium 與 AppFolio 的 API 都用「租約為頂層、單位掛在物件下」的結構，與本專案 `property → unit → lease → tenant` 的層級方向一致。Buildium 把協會（association）與出租（rentals）拆成兩條平行資料線，值得台灣「社區 vs 單戶」設計參考。
- 推論：AppFolio 營收 76% 來自附加服務、Buildium 與 Yardi 把篩選、租客險、電子簽、支付做成按次或加購，三家的模式一致：軟體費壓低，主收入在金流與附加服務。台灣沒有對應的合規金流，等於把這條收入線擋住。
- 推論：JGB 與 Bananas 在台灣都停在「記錄加對帳」；僑馥與第一建經則證明「案件進度、款項狀態、多方登入」在買賣端已商品化。租賃端的信託收付只有 Bananas 在報導中提到。

### Gaps
- AppFolio 開發者文件、Yardi 官網產品頁、PropertyGuru 官網、貝殼官網功能頁：讀取失敗或不存在，資料模型與模組清單用第三方補足，信心低。
- Voyager 的模組清單：官方 PDF 與產品頁都讀不到，只拿到搜尋摘要的概述。
- Bananas、JGB 的實際方案價格：官網未列或需登入。JGB 的「帳務管理」模組細節未實測。
- 僑馥、第一建經的履保費率與成本結構：未公開。僑馥 APP 的名稱與功能：未讀到。
- PropertyGuru 2025 年之後的營收：私有化後未公開。
- AppFolio 的支付與篩選產品名稱、費率：定價頁未列，10-K 只有搜尋摘要。
- 591、貝殼、PropertyGuru 的 API 與整合：未查到公開文件。

---

## 2. 資料模型層級對比（property、unit、lease、tenant、owner）

### Takeaway
只有四家（AppFolio、Buildium、Yardi、JGB）有 property 到 unit 到 lease 到 tenant 的層級，且只有 Buildium 能讀到完整路徑。owner 在 Buildium 是獨立資源（rental owner 與 association owner 兩套），在 Yardi Breeze 是「按持分比例」，在 AppFolio 公開的 Stack API 清單中沒出現。

### Cited Findings
- Buildium：物件、單位、屋主在 `/v1/rentals` 之下；租約與承租人在 `/v1/leases` 之下；協會另有 `/v1/associations`，含 ownershipaccounts 與 owners — [Buildium 開發者頁面](https://developer.buildium.com/)（我解析內嵌 OpenAPI，298 條路徑）
- Buildium 租約之下掛 charges、payments、refunds、recurringcharges、renewals、moveouts、applieddeposits、rentersinsurance — 同上
- AppFolio Stack API（唯讀、15 個 endpoint）資源：bills、charges、properties、tenants、units、work-orders、vendors、bank accounts、attachments — [Jentic](https://jentic.com/apis/appfolio)（二級）；搜尋摘要稱 owners 與 occupancies 不在清單 — [Propexo 文件](https://docs.propexo.com/pms-guidance/appfolio/integration-and-partnership)（二級）
- AppFolio Database API 走 `/api/v1/reports` 報表端點，不是資源式 REST — [Aptly 整合說明](https://aptly.helpkit.so/integrations/vVQpukZPcgx25GULuxrwjv/integrating-aptly-with-appfolio-api-plus-and-max-users/7eBtxbAky1ZW98PUBWt4Kx)
- Yardi Master Data API 可取得 resident/tenant、unit、lease、property 資料；Breeze Owner Tools 支援按持分比例管理物件 — [Yardi 介面夥伴搜尋摘要](https://www.yardi.com/documents/voyager_residential.pdf/)；[Yardi Breeze 搜尋摘要](https://softwareconnect.com/reviews/yardi-breeze/)（二級）
- JGB：社區 → 物件 → 租約；設備三層（詞彙、物件清單、合約快照） — 本 repo [JGB 實測筆記](../../../jgb-competitor-and-official-contract.md)
- 591、PropertyGuru：以刊登為單位；僑馥、第一建經：以案件為單位；貝殼：以樓盤字典的房屋為主資料 — 見 1.1、1.4、1.5、1.9、1.10

### Inferences
- 推論：Buildium 的「單位掛在 rentals 路徑下，租約是頂層」說明租約是流動的（同單位多任租客），單位是穩定的。本專案的契約快照設計（JGB 做法）與此一致。
- 推論：「屋主」要獨立成資源，因為 Buildium 與 Yardi 都需要屋主報表與屋主付款（owner distribution），這正是資產管理端的資料基礎。

### Gaps
- AppFolio 的 owner、occupancy、lease 在 API 的實際資源名稱：官方文件讀不到。
- Yardi 的完整 schema：未公開。
- Bananas、Entrata 之外的台灣業者單位層級：未查到。

---

## 3. 買賣與租賃是否同時涵蓋；是否涵蓋屋主端資產管理

### Takeaway
同時涵蓋買賣與租賃的只有三家（591、貝殼、PropertyGuru），都停在刊登或佣金，沒有租後管理（591、PropertyGuru）或沒有屋主端資產管理（貝殼）。租賃 SaaS 四家（AppFolio、Buildium、Yardi、JGB）涵蓋「屋主入口」，但「屋主資產總覽、報表、稅務」三者齊備的沒有，稅務只見 Buildium 的美國 1099 申報。

### Cited Findings
- 591 同時有出租、出售、新建案、土地、店面、辦公、廠房，並有「房東/代理人」入口，但沒有租後管理 — [591 首頁](https://www.591.com.tw/)
- 貝殼同時有存量房、新房、租賃（Carefree Rent，營收 +52.8%）、裝修 — [KE FY2025 新聞稿](https://finviz.com/news/337356/ke-holdings-inc-announces-fourth-quarter-and-fiscal-year-2025-unaudited-financial-results-and-a-final-cash-dividend)
- JGB 物件的「廣告資訊」可選招租或買賣，但只到廣告層 — 本 repo [JGB 實測筆記](../../../jgb-competitor-and-official-contract.md)
- 僑馥、第一建經只做買賣價金履保；兩家官網都未見租賃產品 — [僑馥](https://www.ctop.tw/escrow/services)；[第一建經](https://www.first1.com.tw/)
- 屋主端：Buildium「Property Owner Portal」與 Premier 之外的 Owners Portal；AppFolio「Owner Portal」與「Investment Management」；Yardi Breeze「Owner Tools」與 Premier 的投資人入口，Voyager 另有 investment management — [Buildium Features](https://www.buildium.com/features/)；[AppFolio 物管頁](https://www.appfolio.com/property-manager)；[Yardi Breeze Pricing](https://yardibreeze.com/pricing)
- 稅務：Buildium「1099 e-Filing」（每批 $50 加每張 $4.50），僅限美國的承包商與屋主申報 — [Buildium Pricing](https://www.buildium.com/pricing/)

### Inferences
- 推論：屋主端「資產總覽」在國外是物管公司給屋主的對帳報表（owner statement、distribution），不是屋主自己管理多物件的資產系統。國外沒有一家以「屋主自管資產」為主。台灣若做屋主端資產總覽加稅務，十家中沒有直接對手，這是空白，也可能是需求不足，需另行驗證。
- 推論：買賣與租賃合一的平台（591、貝殼）都以獲客為主，租賃管理 SaaS 則完全不碰買賣成交。

### Gaps
- Yardi Voyager 與 AppFolio 的 Investment Management 實際功能：只見名稱，細節未讀到。
- 台灣屋主端稅務工具（租金所得申報）在任何一家的支援：未查到。
- PropertyGuru 租賃刊登是否為獨立產品：未確認。

---

## 4. 收入來源拆細矩陣

### Takeaway
訂閱與每單位費是國外 SaaS 的底，但主收入在交易與附加服務；台灣 SaaS 業者（JGB）的價格未公開，Bananas 用租金 6% 的管理費。只有 PropertyGuru 與 591 把廣告當主收入；只有貝殼、僑馥、第一建經的主收入是成交或價金的比例費。

### Cited Findings
欄位：訂閱／每單位費／交易手續費／加值服務／廣告／金流分潤。「有」表示該來源明確提到，「未查到」表示未公開。

| 公司 | 訂閱 | 每單位費 | 交易手續費 | 加值服務 | 廣告 | 金流分潤 |
|---|---|---|---|---|---|---|
| 591 | 無（套餐為預付刊登額度） | 每則刊登 400 至 1,699 元 | 無（不收成交佣金） | 定時更新、加急標籤、精選推薦、置頂 | 新建案廣告與列表排序、圖片廣告 | 無 |
| Bananas | BMS 價格未查到 | 未查到 | 租金約 6% 管理費（自述） | 租金保障（價格未查到） | 無 | 銀行信託，分潤未查到 |
| JGB | 有，價格未公開 | 未查到 | 虛擬帳號收款，費率未查到 | 未查到 | 無 | 未查到 |
| 僑馥 | 無 | 無 | 履保費，費率未公開（市場約萬分之二至六） | 預售屋履約擔保、融資、都更信託（收費未查到） | 無 | 專戶利息歸客戶，非收入 |
| 第一建經 | 無 | 無 | 履保費，未公開 | 未查到 | 無 | 未查到 |
| AppFolio | Core 軟體約 $211.5M（FY2025） | $1.49 / $3.20 / $5.00 每單位每月 | 支付收入（總額認列） | Value Added Services 約 $721.5M（電子支付、租客篩選、風險減輕為大宗） | 無 | 支付以總額認列，分潤比例未查到 |
| Buildium | $65 / $202 / $420 起（月） | 官網未列單位上限 | EFT $0.60 至 $2.35、信用卡 2.99% | 篩選、租客險、eSignature、1099、檢查等 | 無 | 未查到 |
| Yardi | Voyager 議價 | Breeze $1 至 $3 每單位每月（含最低消費） | 未查到 | ScreeningWorks Pro、Bill Pay、RentCafe、CHECKscan 等 | 無 | 未查到 |
| 貝殼 | 無 | 無 | 佣金為主體（存量房 25.0B、新房 30.6B、租賃 21.9B，RMB） | 家居裝修與家具 15.4B；平台、加盟與加值服務費 | 未單列 | 金融業務新聞稿未提 |
| PropertyGuru | 經紀人年費（分級） | 越南按則（ARPL S$3.46） | 房貸導流佣金（2025 已關閉相關業務） | exposure booster 等 | 開發商廣告 | 無 |

來源：591 見 [591 收費標準](https://www.591.com.tw/home/help/chargeIntro/1)；Bananas 見 [鏡週刊](https://www.mirrormedia.mg/story/20261002fin001)；JGB 見 [JGB 官網](https://www.jgbsmart.com)；僑馥見 [僑馥 FAQ](https://www.ctop.tw/escrow/faq) 與 [工商時報](https://www.ctee.com.tw/news/20230913701296-430605)；第一建經見 [官網](https://www.first1.com.tw/)；AppFolio 見 [FY2025 新聞稿](https://seekingalpha.com/pr/20381847) 與 [AppFolio Pricing](https://www.appfolio.com/pricing)；Buildium 見 [Buildium Pricing](https://www.buildium.com/pricing/)；Yardi 見 [Yardi Breeze Pricing](https://yardibreeze.com/pricing)；貝殼見 [KE 新聞稿](https://finviz.com/news/337356/ke-holdings-inc-announces-fourth-quarter-and-fiscal-year-2025-unaudited-financial-results-and-a-final-cash-dividend)；PropertyGuru 見 [Phillip Securities 報告](https://www.poems.com.sg/stock-research/PGRU/propertyguru-group-ltd-dominant-property-platform) 與 [Q2 2024 新聞稿](https://www.silicon.co.uk/press-release/propertyguru-reports-second-quarter-2024-results)。

### Inferences
- 推論：本專案若走 SaaS 路線，國外三家的「低軟體費加高附加服務」在台灣要先拆解：附加服務中的支付需要持牌通道，篩選需要徵信授權，租客險需要產險夥伴。能先上的是電子簽（點點簽）、租金保障險分潤、設備與維修轉介。
- 推論：Buildium 與 AppFolio 的軟體費差距（Buildium 官網標示「起」的月費，AppFolio 按單位）顯示兩種定價心態：平價平台費加交易費，對照單位費加最低消費。台灣小房東以數十戶為多，月費制較易理解。

### Gaps
- Bananas、JGB 的軟體費；Voyager 的單位費；貝殼的平台抽成率；各家金流分潤比例：均未公開。
- 僑馥與第一建經的履保費是否包含銀行手續費：僑馥 FAQ 只說撥出匯款手續費由僑馥吸收，其餘未明。
