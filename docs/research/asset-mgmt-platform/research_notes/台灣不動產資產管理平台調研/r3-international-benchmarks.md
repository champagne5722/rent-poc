# 國外不動產科技（PropTech）標竿：資產與租賃管理 SaaS、媒合平台、數位 escrow、亞洲案例、租金與押金產品、失敗案例

調研基準日：2026-10-29。數字以 2025 會計年度為主，舊資料已標年份。資料品質分三級：

- 一級：公司新聞稿、SEC 文件、公司官網定價頁，本次有實際讀到內容。
- 二級：產業媒體與資料彙整網站，只讀到搜尋摘要，未核對原文。
- 三級：行銷頁或倡議團體文章，只當單方說法。

私人公司（Yardi、MRI、RealPage、Qualia、Snapdocs、Zumper）的營收與市佔多半未公開，已標「未公開」或標明為外部估計。

---

## 1. 資產管理與物業管理 SaaS：Yardi、AppFolio、Buildium、RealPage、Entrata、MRI Software

### Takeaway
這個市場的收費骨架是「軟體訂閱（每單位每月）加上支付、租客篩選、保險等附加服務抽成」，附加服務佔比高：AppFolio 2025 年營收約 76% 來自 Value Added Services。產品切分上，中小客戶用分級方案（Core/Plus/Max、Essential/Growth/Premium），大型與商用客戶用議價合約；API 與進階功能被當成升級誘因。

### Cited Findings

#### AppFolio（美國，上市，住宅為主，中小型到大型物管公司）
- FY2025 營收 $951M，年增 20%；GAAP 營運利益 $153M（16.1%），non-GAAP 營運利益 $235M（24.7%）；2026 財測營收 $1,100M 至 $1,120M。 — [AppFolio FY2025 新聞稿（Seeking Alpha 轉載）](https://seekingalpha.com/pr/20381847)
- FY2025 營收類別：Core solutions 約 $211.5M、Value Added Services 約 $721.5M、其他約 $17.8M。Value Added Services 佔約 76%（本筆佔比為本筆記以兩數字相除算出）。 — [同上](https://seekingalpha.com/pr/20381847)
- 2025 年底管理約 940 萬單位（年增 8%），客戶 22,096 家（前一年 870 萬單位、20,784 家）。 — [Nasdaq 新聞稿搜尋摘要](https://www.nasdaq.com/press-release/appfolio-inc-announces-fourth-quarter-and-fiscal-year-2025-financial-results-2026-01)（二級，客戶數未能在新聞稿全文核對）
- 官網定價（每單位每月，起價）：Core $1.49（另有每月最低消費與 50 單位下限）、Plus $3.20、Max $5.00（皆註明有最低消費與單位數門檻，請洽業務）。 — [AppFolio Pricing](https://www.appfolio.com/pricing?facet2=management)
- 功能切分：Core 含會計報表、行銷與出租、工單、檢查與換約整備、行動工具；Plus 加上補助型與學生住宅、進階預算與分析、自訂欄位、Realm-X Flows、唯讀 API；Max 再加 Leasing CRM、Leasing Signals、讀寫 API、專屬客戶成功經理。 — [AppFolio Pricing](https://www.appfolio.com/pricing?facet2=management)
- Max 最低月費各第三方說法不一（$1,500 與 $7,500 都有人提），官網只寫「洽詢」。 — [搜尋結果彙整](https://www.costbench.com/software/property-management/appfolio/)（二級，互相矛盾）
- 對台灣平台的啟示（推論）：把會計、出租、工單做成基礎包，把 API 與 AI 助理放進高階包；收入主體要設計在支付與增值服務，不能只靠軟體月費。

#### Buildium（RealPage 旗下，小型房東與中小物管）
- 官網目前定價（2026 讀取）：Essential 每月 $65 起、Growth $202 起、Premium $420 起；官網未列各方案的單位上限，超過 5,000 單位或社區管理協會需電話洽詢。 — [Buildium Pricing](https://www.buildium.com/pricing/)
- 交易費隨方案遞減：入帳 EFT 每筆 Essential $2.35、Growth $1.35、Premium 前 12 個月免費之後 $0.60；信用卡 2.99%；租客篩選每次 $17；租客險每位住戶每月 $12 起。 — [Buildium Pricing](https://www.buildium.com/pricing/)
- Open API 列在 Premium 方案，官網未明說 Essential 與 Growth 是否提供。 — [Buildium Pricing](https://www.buildium.com/pricing/)
- 第三方網站列的舊價 $62/$192/$400 與官網新價不同，顯示 2026 年有調價；第三方文章指出 EFT 費用是「看不見的費用堆疊」。 — [aitoolsbakery 搜尋結果](https://aitoolsbakery.com/blog/buildium-pricing/)（三級）
- 對台灣平台的啟示（推論）：月費走平價平台費加交易費，費用表要公開透明，否則會被第三方文章寫成「隱藏費用」而傷害口碑。

#### Yardi（美國，私人公司，住宅、商用、社會住宅、自助倉儲等全品類）
- Yardi 為私人公司，營收、市佔未公開；外部資料庫只有推估，且彼此矛盾，本筆記不採用。 — [搜尋結果：Yardi Voyager 資料彙整](https://www.erpresearch.com/pricing/yardi-voyager)（三級）
- Voyager（大型）不公開價格，依單位數、物件類型、雲端或地端、模組組合議價。 — [ERP Research 搜尋摘要](https://erpresearch.com/en-us/yardi-voyager-software)（二級）
- Breeze（小型）官方公開價：住宅 Breeze 起價 $1/單位/月、每月最低 $100；Breeze Premier 住宅 $2/單位/月、最低 $400，綁定租客篩選與租客險並簽 12 個月約時降為 $1；社會住宅 Premier $3；社區管理協會 Premier $1（最低皆 $400）；商用 Breeze $2、最低 $200。 — [Yardi Breeze 定價頁](https://www.yardibreeze.com/blog/2024/11/yardi-breeze-pricing/)
- 對台灣平台的啟示（推論）：Yardi 用「軟體低價、綁定篩選與保險」換取附加服務收入，台灣可以把電子簽署、租客信用查詢、租金保障綁進方案。

#### RealPage（美國，Thoma Bravo 私有化，大型多戶住宅）
- Thoma Bravo 2021 年 4 月完成私有化，含淨負債約 $10.2B（另有來源寫 $9.6B，差異未釐清）。 — [BusinessWire 2021-04-22](https://www.businesswire.com/news/home/20210422005682/en/Thoma-Bravo-Completes-Acquisition-of-RealPage)
- RealPage 自稱在全球超過 2,400 萬租賃單位提供定價與營運服務；營收與客戶數無可靠公開數字（第三方列 29,800 客戶，未驗證）。 — [搜尋結果：Wikipedia 與彙整網站](https://en.wikipedia.org/wiki/RealPage)（二級）
- 2024 年 8 月美國司法部控告其收益管理軟體（原 YieldStar）促成房東間協同訂價；2025-11-24 達成和解，無罰款、無認錯，需獨立監督人，且限制使用逾 12 個月以上的非公開資料；州政府訴訟與集體訴訟仍在進行。 — [RealPage 官方公告](https://www.realpage.com/news/realpage-reaches-settlement-with-us-department-of-justice/)；[倡議團體整理](https://pestakeholder.org/news/thoma-bravos-realpage-reaches-settlement-with-doj/)（三級，描述和解細節）
- 對台灣平台的啟示（推論）：若平台匯集多家房東的租金資料，必須事先設計資料隔離與「不得跨房東共享非公開價格」的規則，避免走到協同訂價的法律風險。

#### Entrata（美國，已申請 IPO，住宅、學生、補助型、軍眷、單戶出租）
- 2026 年 5 月向 SEC 提出 IPO 申請，預計在 NYSE 掛牌，代號 ENT；截至本筆記日期未查到是否已定價。 — [CP24/Reuters 2026-05-28](https://www.cp24.com/news/money/2026/05/28/silver-lake-backed-entrata-reveals-23-revenue-jump-in-us-ipo-filing/)（二級）
- 草稿 S-1：FY2024 營收 $412.0M、淨利 $21.8M；2025 前 9 個月營收 $371.3M、淨利 $30.7M；2025-09-30 計費單位約 2,350,888。 — [Entrata DRS（SEC）](https://www.sec.gov/Archives/edgar/data/0002028464/000202846425000007/filename1.htm)
- 收費來源：月訂閱費加支付處理費，訂閱客戶必須使用 Entrata 的支付方案；合約通常三到五年；單位數是計費中的單位。 — [Entrata DRS（SEC）](https://www.sec.gov/Archives/edgar/data/0002028464/000202846425000007/filename1.htm)
- 2025 年 5 月 Blackstone 少數股權投資 $200M，估值 $4.3B。 — [Private Equity Wire 搜尋結果](https://www.privateequitywire.co.uk/blackstone-takes-minority-stake-in-entrata-at-4-3bn-valuation/)（二級）
- 產品組成：單一雲端原生「Operating System」，涵蓋 CRM、ERP、物業營運與住戶互動，超過 70 項產品（支付、水電管理、保險、住戶 app、會計、AI）。 — [Entrata DRS（SEC）](https://www.sec.gov/Archives/edgar/data/0002028464/000202846425000007/filename1.htm)
- 對台灣平台的啟示（推論）：支付綁定加長約是高營收品質的來源，但台灣要先確認金流合規（第三方支付、信託）才能複製。

#### MRI Software（美國，私募持有，商用與住宅，全球化）
- 2025-09 路透報導：持有者（TA Associates、Harvest Partners、GI Partners）評估以約 $100 億估值出售或 IPO；營收接近 $10 億、EBITDA 約 $4 億、年成長約 10%、逾半營收來自美國以外。以上皆為匿名消息來源，公司拒絕評論。 — [WHBL/Reuters 2025-09-26](https://whbl.com/2025/09/26/exclusive-private-equity-owners-of-mri-software-target-sale-or-ipo-at-10-billion-valuation-sources-say/)（二級，未證實）
- 對台灣平台的啟示（推論）：MRI 靠持續併購補齊商用、投資模型、帳務模組，台灣初期可先專注住宅租賃，再用整合方式補商用。

### Inferences
- 各家共同點：以「每單位」為計價單位，單位（unit）是核心計費與資料單位，台灣的「戶、房、車位」需要早期定義成計費單位。
- 營收品質排序：支付與附加服務（AppFolio 約 76%、Entrata 強制綁支付）比純軟體月費更高，但依賴合規與金流牌照。
- 規模差距：AppFolio 940 萬單位、Entrata 約 235 萬單位、RealPage 自稱 2,400 萬；台灣住宅租賃市場規模遠小，建議以「每單位低價加高附加滲透率」模型試算，不能照搬美國 ARPU。

### Gaps
- Yardi、MRI、RealPage 的營收、客戶數、市佔均未公開，只有推估或匿名消息。
- 各家市佔比例沒有可靠的第三方統計（找不到同一口徑的產業報告）。
- Entrata 單位費率與支付抽成比例，草稿 S-1 前 10 萬字內未揭露，後段 29 萬字未讀。

---

## 2. 租賃媒合與買賣媒合：Zillow、Rightmove、Zumper、Apartments.com、Opendoor

### Takeaway
媒合平台的錢來自「向供給端（仲介、房東、建商）收費」：Rightmove 靠按月訂閱，Apartments.com 靠分級廣告包，Zillow 靠潛在客戶費與租賃廣告。租賃是 Zillow 成長最快的線（2025 年 +39%），顯示租賃端的軟體與廣告比買賣端更有成長空間。

### Cited Findings

#### Zillow（美國，上市）
- FY2025 總營收 $2,583M（+16%）：Residential $1,704M（+7%）、Mortgages $199M（+37%）、Rentals $630M（+39%）、Other $50M（+14%）；GAAP 淨利 $23M、調整後 EBITDA $622M。 — [Zillow Q4 與 FY2025 新聞稿](https://zillowgroup.mediaroom.com/2026-02-10-Zillow-Group-Reports-Fourth-Quarter-and-Full-Year-2025-Financial-Results)
- Q4 2025 Rentals 營收 $168M（+45%），多戶住宅（multifamily）+63%；2026 財測 Rentals 約成長 30%。 — [Zillow 8-K / 彙整報導](https://www.sec.gov/Archives/edgar/data/1617640/000161764026000012/q42025991.htm)（二級摘要）
- 自 2023 起以單一報告部門披露，營收分 Residential、Rentals、Mortgages、Other；Flex 為按成交付費的潛在客戶模式（代理人只在成交時付費）。 — [Zillow FY2023 10-K（搜尋摘要）](https://www.sec.gov/Archives/edgar/data/1617640/000161764024000022/z-20231231.htm)
- 2023-09-11 買下 Spruce（科技型 title 與 escrow 公司）約 $19M 現金（淨額），初步購買價 $24M；此前 Zillow 已關閉自己的 title 與 escrow 部門（裁約 80 人）。 — [ALTA 2023-08-29](https://alta.org/news-and-publications/news/20230829-Zillow-to-Acquire-Spruce)；[OnlineMarketplaces](https://www.onlinemarketplaces.com/?p=100790)（二級）
- 對台灣平台的啟示（推論）：租賃端的 B2B（房東、建商、管理公司）收入成長快於買賣廣告；平台要先累積租賃供給，再延伸到申請、合約、支付。

#### Rightmove（英國，上市，買賣與租賃入口網站）
- FY2025（截至 2025-12-31）營收 £425.1M（+9%），營運利益 £287.9M（+12%），基本營運利益 £297.7M（+9%）。 — [Rightmove RNS 2026-02-27](https://plc.rightmove.co.uk/content/uploads/2026/02/Rightmove-RNS-27.02.26.pdf)
- ARPA（每廣告主每月平均營收）：Agency £1,530（+£90）、New Homes £2,135、總 ARPA £1,621；Agency 營收 £304.7M、New Homes £75.3M。ARPA 以廣告主按月營收除以廣告主數計算，表示收費為按月訂閱。 — [Rightmove RNS 2026-02-27](https://plc.rightmove.co.uk/content/uploads/2026/02/Rightmove-RNS-27.02.26.pdf)
- 策略成長領域（商用、房貸、租賃服務）合計營收 £29.1M（+25%），佔總營收 7%；其中 Rental Services £7.1M（+35%，產品含 Lead to Keys），Mortgages £6.8M（+46%）。 — [Rightmove RNS 2026-02-27](https://plc.rightmove.co.uk/content/uploads/2026/02/Rightmove-RNS-27.02.26.pdf)
- 2026 財測：營收成長 8% 至 10%，ARPA 成長 £110 至 £120。 — [Rightmove RNS 2026-02-27](https://plc.rightmove.co.uk/content/uploads/2026/02/Rightmove-RNS-27.02.26.pdf)
- 對台灣平台的啟示（推論）：Rightmove 基本營運利益率約 70%（£297.7M 除以 £425.1M，本筆記計算），代表「入口網站流量加月費訂閱」的邊際成本極低；但台灣已有既有入口（591 等），新平台必須以租後管理的資料與流程切入，不要正面爭流量。

#### Apartments.com（CoStar Group 旗下）
- 2014 年 CoStar 以 $585M 買下 Apartments.com。 — [The Real Deal 2014-03-04](https://therealdeal.com/2014/03/04/costar-buys-apartments-com-for-585m/)
- 2024-01 年化營收首度超過 $10 億，為 CoStar 最大單一事業。 — [CoStar 2023 年度新聞稿（BusinessWire）](https://www.businesswire.com/news/home/20240220853493/en)
- 2025 年 Q3 營收 $303M（+11%）、年化營收逾 $12 億；Q4 與全年皆約 +11%（第三方彙整，非 10-K 原文）。 — [VectorShift 彙整](https://vectorshift.ai/research/companies/costar-group/earnings/2025-q3-summary)（三級）
- 收費：物業方按年度分級廣告包購買曝光，每個廣告包附帶 CoStar Market Advantage 資料產品，網路涵蓋 ForRent.com 與 ApartmentFinder.com。 — [Apartments.com 廣告主頁](https://www.apartments.com/grow/about)；[Morningstar 摘要](https://app.researchpool.com/provider/morningstar/costar-group-inc-csgp-morningstar-csgp-report)（二級）
- 對台灣平台的啟示（推論）：把資料產品（市場租金行情）附贈在廣告包裡，可以提高續約率並拉開與純刊登網站的差距。

#### Zumper（美國，私人公司，租賃媒合）
- 營收來源歷史上包含：房東付費置頂、申請人付費查信用與背景、房東付費成交（full-service，2018 年佔約 50% 營收，CEO 說法）、Zumper Pro 訂閱。 — [Crunchbase News](https://news.crunchbase.com/venture/zumper-secures-60m-to-become-the-airbnb-for-one-year-leasing/)；[TechCrunch 2015](https://techcrunch.com/2015/06/25/real-estate-startup-zumper-raises-another-6-4-million)（二級，資料為 2015 至 2022）
- 累計融資超過 $1.5 億；目前營收未公開。 — [Multiples.vc](https://multiples.vc/private-comps/zumper)（三級）
- 對台灣平台的啟示（推論）：申請與信用查詢費、成交費可以當第二層收入，但需要與租客保護規範一起設計。

#### Opendoor（美國，上市，iBuyer）
- FY2025 營收 $4.37B（-15%），賣出 11,791 間（-13%），買入 8,241 間（2024 年 14,684 間）；年末庫存 2,867 間、$925M（2024 年 6,417 間、$2.159B）。 — [Real Estate News 2026-02-19](https://www.realestatenews.com/2026/02/19/opendoor-ceo-were-asking-you-to-hold-us-accountable)；[Opendoor FY2025 10-K](https://www.sec.gov/Archives/edgar/data/1801169/000180116926000010/open-20251231.htm)（搜尋摘要）
- FY2025 淨虧損約 $13 億（含 $9.24 億債務清償損失），2024 年為 $3.92 億；Q4 2025 單季虧損約 $11 億。 — [搜尋摘要自 10-K](https://www.sec.gov/Archives/edgar/data/1801169/000180116926000010/open-20251231.htm)；[Real Estate News](https://www.realestatenews.com/2026/02/19/opendoor-ceo-were-asking-you-to-hold-us-accountable)（二級，全年 $13 億與 Q4 $11 億兩數字未能自原文交叉核對）
- 2025-09 起新 CEO Kaz Nejatian（前 Shopify COO）主導「Opendoor 2.0」，目標 2026 年底達調整後與淨利為正；2026 年中報導指其「依計畫進行」（二級報導，未查 10-Q）。 — [Real Estate News 2026-08-05](https://www.realestatenews.com/2026/08/05/opendoor-targeting-profitability-by-end-of-2026)
- 商模：自有資金買房、翻修後轉賣，賺價差與服務費，不是媒合抽成。 — [Real Estate News](https://www.realestatenews.com/2026/02/19/opendoor-ceo-were-asking-you-to-hold-us-accountable)（二級）
- 對台灣平台的啟示（推論）：自有資產負債表做買賣價差的風險與資本需求遠高於媒合平台，初期應避免自持庫存。

### Inferences
- 與仲介的關係：Rightmove 與 Zillow 都向仲介收費而非取代仲介，這是成功模式；Opendoor 與 Zillow Offers 取代仲介，結果虧損。
- 租賃是成長最快的垂直領域（Zillow Rentals +39%、Rightmove Rental Services +35%），多戶住宅（B2B 管理公司）比個人房東成長更快。

### Gaps
- Apartments.com 的全年 2025 營收與 Homes.com 虧損數字，只找到第三方彙整，未取得 CoStar 10-K 原文。
- Zumper 現行營收與收費標準未公開；歷史資料為 2015 至 2022。
- Zillow 的潛在客戶費（Premier Agent）實際費率未取得。

---

## 3. 數位 escrow 與交易結算：Qualia、Snapdocs、Endpoint、Doma、Spruce、英國 conveyancing 平台

### Takeaway
美國有兩條路線：純軟體路線（Qualia、Snapdocs、E-Closing）服務 title 與 escrow 公司和貸款機構；自己當 title 公司路線（Spruce、Endpoint、Doma）。後者在 2023 至 2024 年因房貸量縮減而失敗或被併購。英國則由第三方支付機構（Shieldpay）與結算網路（PEXA Pay）承擔資金移轉，讓律師不再經手大額資金。

### Cited Findings

#### Qualia（美國，私人公司，title 與 escrow 生產軟體）
- 2020-12 完成 $65M Series D，估值超過 $10 億，並收購 Adeptive Software（ResWare 開發商）。 — [Pulse 2.0](https://pulse2.com/qualia-65-million-series-d-over-1-billion-valuation-adeptive-software-acquisition/amp/)；[Inman 2020-12-22](https://inman.com/2020/12/22/qualia-raises-65m-acquires-software-company)
- 2025-01 向 Old Republic 收購 RamQuest 與 E-Closing 平台，條款未公開，Old Republic 繼續使用這些平台。 — [ALTA 2025-01-30](https://www.alta.org/news-and-publications/news/20250130-Qualia-Acquires-RamQuest-E-Closing)；[HousingWire](https://www.housingwire.com/articles/qualia-acquires-ramquest-e-closing-from-old-republic/)
- E-Closing 為雲端 title 生產軟體，ClosingVue 專為 title 與 escrow 代理人設計。 — [CB Insights 搜尋摘要](https://www.cbinsights.com/company/e-closing)（二級）
- 營收、近年估值：未公開（Multiples.vc 的 $15 億與 $6,500 萬營收缺乏來源，不採用）。 — [Multiples.vc](https://multiples.vc/private-comps/qualia)（三級）
- 對台灣平台的啟示（推論）：Qualia 的做法是用軟體當地端 title 公司的作業系統，併購補齊功能；台灣的代書與地政士流程適合先做「作業軟體」而非自己收款。

#### Snapdocs（美國，私人公司，貸款 eClosing）
- 2021 年 $150M Series D（Tiger Global 領投），累計融資約 $260M，估值超過 $15 億。 — [BusinessWire 2021-05-25](https://www.businesswire.com/news/home/20210525005345/en)（搜尋摘要）
- 2024-10 公告 eClosing 方案支援所有貸款與結案類型，2025 年將加入 title 公司功能。 — [BusinessWire 2024-10-15](https://www.businesswire.com/news/home/20241015543324/en)（搜尋摘要）
- 對台灣平台的啟示（推論）：電子簽約與結案文件協調是可獨立收費的模組，台灣可由租約電子簽署延伸到買賣交屋。

#### Endpoint（美國，First American 旗下）
- 由 First American 與 BCG Digital Ventures 於 2018 年合作成立；2020-11 First American 追加 $40M，累計 $70M；2021 年財報電話會議稱其為 First American 全資持有，並提及另有 $1.5 億承諾額度。 — [First American 新聞 2020-11-11](https://www.firstam.com/news/2020/endpoint-40-million-investment-from-faf-20201111.html)；[ROIC 2021 Q3 逐字稿](https://www.roic.ai/quote/FAF/transcripts/2021-year/3-quarter)（二級）
- 對台灣平台的啟示（推論）：產權保險與 title 業者會自建數位通路，新創需要與大型業者建立供應或合作關係，而不是直接競爭。

#### Spruce（美國，科技型 title 與 escrow）
- 2016 年成立；2023-09-11 被 Zillow 收購，初步購買價 $24M。 — [ALTA 2023-08-29](https://alta.org/news-and-publications/news/20230829-Zillow-to-Acquire-Spruce)（搜尋摘要）
- 對台灣平台的啟示（推論）：科技 title 公司的規模難以獨立撐起估值，最後被入口網站買走當作下游整合。

#### Doma（美國，原上市，title 保險與 escrow）
- 2024-03-28 宣布由 Title Resources Group 以 $6.29/股現金私有化（約 $8,500 萬），2024-09-27 完成；科技業務拆為 Doma TechCo，由 Centerbridge 持有多數。 — [Davis Polk](https://www.davispolk.com/experience/doma-take-private-acquisition-title-resources-group)；[Inman 2024-04-01](https://www.inman.com/2024/04/01/title-underwriter-trg-inks-85m-merger-deal-to-take-doma-private/)；[BusinessWire 2024-09-27](https://www.businesswire.com/news/home/20240927923404/en/Doma-Closes-Previously-Announced-Go-Private-Transaction)
- 2023 年虧損 $1.244 億，2023 年已出售自有 title 生產業務；產品原本針對再融資，後轉向購屋貸款；觀察者認為房貸量大幅下滑是失敗主因。 — [National Mortgage News](https://nationalmortgagenews.com/news/doma-to-sell-to-title-resources-group-for-85-million)（二級，成因為業界觀察而非公司聲明）
- 對台灣平台的啟示（推論）：不要依賴單一景氣循環的交易量（再融資或買賣），租賃管理的經常性收入更抗景氣。

#### 英國 conveyancing
- 2025-06 PEXA 與 Muve 完成英國第一筆全數位化購屋交易，貸款機構為 Hinckley & Rugby Building Society，款項透過 PEXA Pay 結算；PEXA Pay 為第七個在英格蘭銀行清算的淨額結算付款機制。 — [Property Reporter](https://www.propertyreporter.co.uk/pexa-finalises-the-uks-first-fully-digital-home-purchase.html)（二級）
- Shieldpay（持牌付款服務業者）提供「數位保險箱」：驗證買賣雙方，雙方同意後才放款，成交時直接付給賣方，而不是經過賣方律師；Council for Licensed Conveyancers 稱其為里程碑，SRA 委託研究指出市場對數位化的接受度並非普遍。 — [Law Gazette](https://www.lawgazette.co.uk/practice/digital-escrow-service-removes-need-for-lawyer-to-hold-client-cash/5066293.article)
- InfoTrack 自稱服務超過 2,400 間律師事務所與 25,000 名 conveyancers，約佔英格蘭與威爾斯從業者三分之二。 — [Legal Futures](https://www.legalfutures.co.uk/associate-news/infotrack-celebrates-a-decade-of-digital-conveyancing/print/)（搜尋摘要）
- 對台灣平台的啟示（推論）：台灣已有價金信託與履約保證機制，平台應與銀行或信託業者合作做資金託管，自己只做流程與狀態，不持有資金。

### Inferences
- 資金持有：本次查到的案例中，純軟體平台（Qualia、E-Closing、Snapdocs）沒有被報導持有資金；持有資金的是 title 公司、持牌付款服務業者（Shieldpay）與結算網路（PEXA Pay）。「平台自己持有資金」只出現在自己當 title 公司的模型，而這個模型在 Doma 案例中失敗。（此為推論，Qualia 等公司是否碰觸資金，本次未查到原文）
- 分工模式：銀行與貸款機構提供款項，title 公司或律師負責產權與法律意見，平台負責文件、狀態、通知與電子簽署。

### Gaps
- Qualia 與 Snapdocs 是否直接碰觸客戶資金，沒有查到原文，推測不碰（未證實）。
- Endpoint 最新營運狀況（2023 年後）未查到。
- Mortgage Pay、Homeprofiler 等英國其他平台資料，搜尋未涵蓋。
- SRA 對客戶資金（client money）規範原文未取得。

---

## 4. 亞洲：GA technologies（RENOSY）、Zigbang、Dabang、PropertyGuru、28Hse、貝殼找房

### Takeaway
亞洲幾個平台的共同點是「向仲介收廣告費」加「自營買賣或服務」。貝殼的 ACN 是最特別的做法：把一筆交易拆成多個角色，讓不同門市的經紀人按貢獻分佣。日本 GA technologies 走線上賣投資用不動產並用 SaaS（ITANDI）補經常性收入；韓國直方（Zigbang）近年持續虧損並轉向廣告。

### Cited Findings

#### 貝殼找房（KE Holdings，中國，上市）
- FY2025 GTV RMB 3,183.3B（-5.0%）：存量房 RMB 2,151.5B（-4.2%）、新房 RMB 890.9B（-8.2%）；淨營收 RMB 94.6B（+1.2%）；淨利 RMB 2,991M（-26.7%）。 — [KE Holdings FY2025 新聞稿（Finviz 轉載）](https://finviz.com/news/337356/ke-holdings-inc-announces-fourth-quarter-and-fiscal-year-2025-unaudited-financial-results-and-a-final-cash-dividend)
- 家居裝修與家具淨營收 RMB 15.4B（+4.4%）；住房租賃（Carefree Rent）淨營收 RMB 21.9B（+52.8%），以租賃佣金與租期管理費淨額認列。 — [同上](https://finviz.com/news/337356/ke-holdings-inc-announces-fourth-quarter-and-fiscal-year-2025-unaudited-financial-results-and-a-final-cash-dividend)
- 門市 61,139 間（+18.5%）、經紀人 523,009 人（+4.6%）；連接經紀人（connected agents）服務的存量房 GTV RMB 1,349.4B（+1.6%），營收以淨額認列為平台、加盟與加值服務費；鏈家品牌的交易以總額佣金認列。 — [同上](https://finviz.com/news/337356/ke-holdings-inc-announces-fourth-quarter-and-fiscal-year-2025-unaudited-financial-results-and-a-final-cash-dividend)
- 淨營收除以 GTV 約 2.97%（本筆記自行計算，非公司揭露的抽成率，且因淨額與總額認列混合而失真）。 — 由上述數字計算
- ACN（經紀人合作網路）：把交易拆成房源端（錄入人、維護人、實勘人、鑰匙人）與客源端（推薦人、成交人、合作人）等角色，按角色貢獻比例分佣；報導說最多可拆成 10 個角色。 — [36氪搜尋結果](https://www.36kr.com/p/3728533793813248)；[投資界 2020-07](https://news.pedaily.cn/202007/457862.shtml)（二級，未逐篇核對）
- 2020 年報導：2019 年超過 70% 的存量房交易透過 ACN 跨店完成；楼盘字典（樓盤字典）累積逾 2.4 億戶房屋資料，作為「真房源」承諾的底層資料。 — [投資界 2020-08](https://news.pedaily.cn/20200811/3864.shtml)（二級，2020 年資料）
- 平台抽成比例：官方未公開；有前員工說法稱外部仲介成交時平台約抽 8 個點，缺官方佐證。 — [36氪](https://www.36kr.com/p/818016195353991)（三級）
- 對台灣平台的啟示（推論）：樓盤字典式的標準化房屋主資料（address、戶、屋況）是真房源與定價的基礎，應該在平台第一版就設計成可擴充的資料模型。

#### GA technologies（日本，東證成長市場，RENOSY）
- FY2025（2025 年 10 月期）合併營收約 ¥2,489 億（+31.1%），營運利益約 ¥71 億、淨利約 ¥39 億；FY2026 公司計畫營收 ¥3,230 億、營運利益 ¥100 億。 — [edinetdb.jp 彙整](https://edinetdb.jp/company/3491)；[envalith 彙整](https://envalith.com/en/companies/3491/overview)（二級，非公司原文）
- RENOSY 為線上不動產交易平台，不動產銷售（flow）佔營收超過 97%；經常性收入來自訂閱式管理與 ITANDI SaaS（ARR 約 ¥48 億、5,211 家客戶）。 — [envalith 彙整](https://envalith.com/en/companies/3491/segments)（二級，網站有期間標示混亂，僅供參考）
- 對台灣平台的啟示（推論）：GA 的流量與成交靠線上，但營收仍以賣屋為主；SaaS 是穩定現金流來源，台灣可以把「租賃管理 SaaS」當作第一個經常性收入產品。

#### Zigbang（韓國，直方）
- 2023 年營收約 $9,380 萬（+47%），營運虧損 KRW 408 億，歸因於整合三星 SDS 智慧家庭 IoT 業務。 — [OnlineMarketplaces](https://www.onlinemarketplaces.com/articles/zigbang-experiences-healthy-sales-boosts-in-2023/)
- 2024 年營收 KRW 1,014 億（-21.8%）。 — [OnlineMarketplaces FY2024](https://www.onlinemarketplaces.com/?p=104068)（二級）
- 2026 年股東會揭露：預售廣告業務由 2024 年約 KRW 12 億增為 2025 年 KRW 116 億，公司由「仲介為主」轉向「廣告為主」，2025 年 EBITDA 虧損收斂至約 KRW 6 億，預期 2026 Q1 起轉正。 — [VentureSquare](https://www.venturesquare.net/?p=1069032)（二級）
- 韓國平台主要營收來自向持照仲介收的廣告費，成交量下滑時營收直接受損。 — [Herald Business](https://mbiz.heraldcorp.com/article/10805461)（二級）
- 對台灣平台的啟示（推論）：只靠廣告費會跟著景氣起伏，租賃管理 SaaS 的訂閱收入可以對沖。

#### Dabang（韓國，Station3）
- 2021 年營收 KRW 246 億（-10%），公司說明因對疫情中的合作仲介提供廣告折扣；2025 年營收需付費才能查看，未取得。 — [Bizhankook](https://www.bizhankook.com/bk/article/23587)；[The VC](https://thevc.kr/station3)（二級）
- 2017 年在首爾冠岳區設「Dabang Care Center」，接到檢舉後現場確認並下架虛假物件；後續推出電子契約。 — [Ajunews 2017](https://www.ajunews.com/view/20170711091901604)；[Ajunews 2021](https://www.ajunews.com/view/20210929173837354)（二級）
- 對台灣平台的啟示（推論）：虛假房源是租屋平台的信任成本，驗證機制必須進入產品與營運流程，不能只靠事後檢舉。

#### PropertyGuru（新加坡，EQT 私有化）
- 2024 年 EQT Private Capital Asia 以 $11 億全現金收購，2024-12-15 完成。 — [OnlineMarketplaces](https://onlinemarketplaces.com/articles/eqt-completes-acquisition-of-propertyguru-group)
- 2023 年營收 S$1.5 億（+11%）、調整後 EBITDA S$1,900 萬；全年 ARPA S$4,977（+22%）。 — [PropertyGuru FY2023 新聞稿](https://www.businesswire.com/news/home/20240229847316/en/PropertyGuru-Reports-Fourth-Quarter-and-Full-Year-2023-Results)
- 2024 Q2：新加坡持牌經紀人 16,577 人、續約率 81%，新加坡市場營收 S$2,500 萬（+16%），Fintech 與資料服務營收僅 S$160 萬且 EBITDA 率 -185%。 — [OnlineMarketplaces](https://onlinemarketplaces.com/?p=103311)（二級）
- 2025 年私有化後裁員逾 170 人，關閉房貸與居家服務單位，回歸核心入口網站。 — [OnlineMarketplaces](https://www.onlinemarketplaces.com/?p=104418)；[Digg 摘要](https://digg.com/tech/d85cc799-4584-487f-a34c-2f72bbeb77ad)（二級）
- 對台灣平台的啟示（推論）：延伸到房貸與居家服務的邊緣業務虧損嚴重，初期應守住核心。

#### 28Hse（香港）
- 提供住宅、辦公、商舖、車位刊登；以分級付費置頂為收入，宣稱不收佣金；收購 REA Group 的 Squarefoot.com.hk 資產。 — [App Store 頁面](https://apps.apple.com/hk/app/28hse-com-xiang-gang-wu-wang/id902344223)；[Elite Agent](https://eliteagent.com/?p=208008)（三級）
- 營收：未公開（只有 iOS App 內購估計）。
- 對台灣平台的啟示（推論）：免佣、付費置頂的輕量模式可行，但規模小、難以做深度營運。

### Inferences
- 亞洲多數平台以仲介為付費客戶；貝殼用 ACN 與品牌加盟把仲介綁進系統，是最重的模式，也是最難複製的。
- 租賃端表現：貝殼住房租賃營收年增 52.8%，顯示規模化租賃管理有市場。

### Gaps
- GA technologies、Zigbang 的數字來自彙整網站或媒體，未讀到公司財報原文。
- ACN 實際分佣比例、平台抽成率，官方未公開；現有說法都是前員工或評論。
- 28Hse 財務資料未公開。
- Zigbang 2025 全年總營收與 Dabang 2025 營收未取得。

---

## 5. 租金支付與押金替代：Bilt、Rhino、Jetty、Obligo

### Takeaway
這類產品把租金流量變現。Bilt 靠房租支付導流到信用卡與購物（interchange 與推薦費），押金替代產品（Rhino、Jetty、Obligo）向租客收取不退費用或月費，對房東提供保障。三種機制不同：保險（Rhino）、保證保險或保證債券（Jetty）、銀行授權額度（Obligo），租客仍須為損害負責。

### Cited Findings

#### Bilt
- 2025-07 完成 $2.5 億融資，估值 $107.5 億，General Catalyst 與 GID 共同領投，UWM 投入 $1 億。 — [FinTech Futures](https://www.fintechfutures.com/venture-capital-funding/bilts-valuation-soars-to-10-75bn-following-250m-funding-round)
- 每年處理逾 $450 億的租金與 HOA 付款，透過大型物管公司網路。 — [Yahoo Finance](https://finance.yahoo.com/news/points-rent-startup-bilt-announces-211000136.html)（二級）
- 營收模式：向商家收取的 interchange 費與推薦費；Fast Company 報導多數營收來自物管公司合作；營收規模有兩種說法（已達 $10 億年營收，或預期 2026 Q1 超過 $10 億），互相矛盾。 — [Finovate](https://finovate.com/bilt-raises-250-million-at-10-billion-valuation/)；[Caplight](https://www.caplight.com/company/bilt-rewards)（二級）
- 發卡合作銀行由 Wells Fargo 轉為 Column N.A.（2026 年 1 月前後上線 Bilt 2.0，各來源時間略有差異）。 — [Fast Company 搜尋摘要](https://finance.yahoo.com/news/points-rent-startup-bilt-announces-211000136.html)（二級）
- 對台灣平台的啟示（推論）：房租付款是穩定且高頻的金流入口，但台灣需先確認收款是否涉及第三方支付或電子支付執照，可由銀行或持牌支付業者負責，平台提供管理與對帳。

#### Obligo
- 費用為押金要求的某個百分比，由機器學習依地區、物件類型、帳戶餘額、押金對租金比等個人資料決定；通常預付一個租期（最長 12 個月），不退費，續約可能再收一次；不包含房東於租期結束時對損害或欠租的請求。 — [Obligo Help Center](https://help.myobligo.com/en/articles/6414763-how-does-the-obligo-fee-work)
- 運作方式（外部說明）：預先授權房東可在有損害時從租客帳戶提款，租客可分期；Obligo 自稱使用銀行信用狀（Wells Fargo），並與 Jetty 的保證債券做對比（行銷說法）。 — [Brick Underground](https://www.brickunderground.com///node/45771)；[Obligo 官方頁](https://depositfree.myobligo.com/eliminate-security-deposits-2024)（二級與三級）
- 對台灣平台的啟示（推論）：以信用評估取代押金的做法，需要個資與徵信授權，且費用結構必須清楚揭露不退費性質。

#### Jetty
- 一次性不退費用或每月不退費用兩種；外部文章指保證債券型產品一次性費用通常約為押金的 17.5%。 — [Jetty 官網](https://www.jetty.com/move)；[Nonprofit Quarterly](https://nonprofitquarterly.org/security-deposit-alternatives-the-misleading-marketing-of-renters-choice/)（二級與三級，倡議立場）
- 對台灣平台的啟示（推論）：一次性費用對租客現金流較不友善，若要導入，建議提供月繳選項並明列租客仍須負損害責任。

#### Rhino
- 以保險取代現金押金，租客付月費；外部報導說低至每月約 $5，紐約市 HPD 文件說明 $1,000 保額約每月 $4，涵蓋欠租、超額損害與滯納金。 — [BadCredit.org](https://www.badcredit.org/news/rhino-offers-renters-insurance-on-their-deposits/)；[NYC HPD 文件](https://www.nyc.gov/assets/hpd/downloads/pdfs/services/rhino-overview.pdf)（二級）
- 與保險公司和再保險公司合作；2021 年 $9,500 萬融資。 — [Fintech Global 2022-11-10](https://fintech.global/2022/11/10/rhino-partners-with-panel-of-insurers-and-reinsurers-to-bolster-growth/)；[TechCrunch 2021-01-26](https://techcrunch.com/2021/01/26/rhino-raises-95m-to-scale-its-rental-deposit-replacing-insurance-product)
- 倡議團體批評：租客付費不等於免責，保險或保證金賠付後仍可向租客追償，且不退費。 — [Oregon 立法證詞](https://apps.oregonlegislature.gov/liz/2021R1/Downloads/PublicTestimonyDocument/22517)；[Baltimore Sun 評論 2021](https://www.pressreader.com/usa/baltimore-sun/20210416/281822876626517)（三級，倡議立場）
- 2025-02-06 Rhino 與 Jetty 合併，稱服務超過 600 萬租賃單位，為最大押金保險公司。 — [Bradford Era（新聞稿轉載）](https://bradfordera.com/2025/02/06/rhino-and-jetty-merge-to-create-the-largest-security-deposit-insurance-company-in-the-market)
- 對台灣平台的啟示（推論）：押金替代需要保險或金融機構作後盾，台灣可評估與產險公司合作「租金保障險」，不建議平台自行承擔賠付風險。

### Inferences
- 通則：費用不退費、租客仍負賠償責任、房東需加入網路才能使用，三個特徵在所有案例都成立。
- 規模：合併後 Rhino 加 Jetty 聲稱涵蓋 600 萬單位，說明押金替代必須依附管理系統分發（房東與物管軟體整合）才有規模。

### Gaps
- Rhino、Jetty、Obligo 現行具體費率（百分比或月費）：官方頁未公開，只有舊報導。
- Jetty 官網頁面本次未成功讀取，其運作機制僅有二級說明。
- Bilt 實際營收與抽成比例：公司未公開，兩種說法互相矛盾。
- Rhino 理賠率、損失率：未公開。

---

## 6. 公開的架構資訊：工程部落格、技術演講、資料模型、API 設計

### Takeaway
能查到的公開架構資訊偏少，且多半來自招募文與第三方整合文件。可確認的設計原則有三點：單一程式碼基礎的多租戶（Entrata）、以單位（unit）為核心的資料階層（Buildium API）、以方案分級控制 API 權限（AppFolio、Buildium）。

### Cited Findings
- Entrata 自述：多租戶、單一程式碼基礎，所有客戶執行同一版本、無客製程式碼；單一登入；Unified Data Layer 將每位客戶的交易與互動整合為單一資料來源；擴充式整合框架連接超過 500 家第三方；未說明公開 API。 — [Entrata DRS（SEC）](https://www.sec.gov/Archives/edgar/data/0002028464/000202846425000007/filename1.htm)
- AppFolio 把 API 分級：Plus 方案提供唯讀 API，Max 方案提供讀寫 API；Stack 是整合市集，標準版與進階版整合分屬不同方案；Realm-X Flows、Assistant 為 AI 與流程自動化功能。 — [AppFolio Pricing](https://www.appfolio.com/pricing?facet2=management)
- Buildium Open API 為 REST；核心物件為 rental properties、units、tenants、leases、rent payments、maintenance requests；單位在物件之下（路徑形如 `/rentals/{id}/units`）；各第三方文件對路徑細節說法不一，須以官方文件為準。官網定價頁列 Open API 於 Premium 方案。 — [Jentic 彙整](https://jentic.com/apis/buildium.com/buildium)；[Buildium Pricing](https://www.buildium.com/pricing/)（二級，路徑為第三方整理）
- Yardi Voyager 官方說法為「統一資料庫」整合應付、應收、總帳與報表；招募文顯示使用 Microsoft SQL Server 並要求 SSRS、SSIS 技能；Standard Interface Partnership Program 以服務導向架構開放合作夥伴介接。 — [Yardi SaaS Answers](https://www.yardi.com/blog/yardi-saas-answers/)；[Yardi 公告](https://www.yardi.com/?p=280989)；[招募文](https://portfoliojobs.cerberus.com/companies/firstkey-homes-2/jobs/41994047-yardi-developer)（二級，架構為推論自招募文）
- Zillow：2021 Kafka Summit 演講《How Zillow Unlocked Kafka to 50 Teams in 8 Months》（高資料品質、生產者與消費者解耦、即時房屋資料）；較早的資料湖用 Kinesis Firehose 寫入 S3，Spark 處理歷史資料；Zestimate 的流程設計參考 Lambda Architecture。 — [Kafka Summit 2021](https://www.kafka-summit.org/sessions/how-zillow-unlocked-kafka-to-50-teams-in-8-months)；[Zillow 新聞：串流資料架構](https://www.zillow.com/news/streaming-data-architecture/)；[Zestimate Lambda 簡報（SlideShare）](https://www.slideshare.net/slideshow/zestimate-lambda-architecture/76310834)
- 通用的 property、unit、lease 層級（Property → Unit → Lease → Tenant/Resident）在 Buildium 與 Entrata 描述中一致，但多數公司未公開完整 schema。 — [Buildium API 彙整](https://jentic.com/apis/buildium.com/buildium)（二級）

### Inferences
- 建議資料模型從 `Property（建物或社區）→ Unit（可出租單位）→ Lease（租約）→ 當事人（租客、房東、代理人）` 起步，並把帳務分錄、工單、文件掛在 Lease 與 Unit 底下，與 Buildium、Entrata 公開描述一致。
- 多租戶單一程式碼基礎，加上依方案分級的 API，是多家公司採用的設計；台灣平台第一版可採用，降低客製化維護負擔。

### Gaps
- AppFolio 工程部落格與架構演講：本次搜尋未找到任何官方來源。
- Yardi 與 RealPage 的完整資料模型與 API 規格：未公開，只能靠招募文推測。
- Zillow 的房源資料模型與 API 設計：只找到資料管線層級資訊，未找到房源 schema。

---

## 7. 失敗案例與原因：Zillow Offers、WeWork 住宅線、各國 iBuyer

### Takeaway
失敗共同點是「自持資產、用演算法預測房價、槓桿與景氣循環疊加」。Zillow Offers 在 2021 年因無法預測房價而關閉；WeLive、Common 的共居模式面對高裝修成本與法規；Redfin、Doma 在利率上升與交易量下滑中收攤或被併購。

### Cited Findings

#### Zillow Offers（2021，已關閉）
- 2021-11-02 宣布關閉：Q3 認列約 $3.04 億存貨減值，預期 Q4 再損失 $2.40 億至 $2.65 億；裁員約 25%；Q3 合併淨損 $3.28 億；Homes 部門稅前損失 $4.22 億。 — [Zillow Q3 2021 IR 新聞稿](https://investors.zillowgroup.com/news-and-events/news/news-details/2021/Zillow-Group-Reports-Third-Quarter-2021-Financial-Results--Shares-Plan-to-Wind-Down-Zillow-Offers-Operations/default.aspx)
- CEO Rich Barton 稱預測房價的不確定性「遠超預期」，擴大規模會造成過大的獲利與資產負債表波動。 — [Zillow Q3 2021 IR 新聞稿](https://investors.zillowgroup.com/news-and-events/news/news-details/2021/Zillow-Group-Reports-Third-Quarter-2021-Financial-Results--Shares-Plan-to-Wind-Down-Zillow-Offers-Operations/default.aspx)
- FY2021 全年存貨減值 $4.079 億。 — [Zillow FY2021 10-K（搜尋摘要）](https://www.sec.gov/Archives/edgar/data/1617640/000161764022000013/z-20211231.htm)（二級）
- 10-K 風險因子原文：Zillow Offers 是「依賴準確評估房屋價值與管理庫存的未經驗證商業模式」。 — [Zillow FY2021 10-K](https://www.sec.gov/Archives/edgar/data/1617640/000161764022000013/z-20211231.htm)
- 業界分析：Insider 調查指在五大市場，64% 近期上架的房屋掛牌價低於 Zillow 當初買價。 — [Banker & Tradesman 搜尋摘要](https://bankerandtradesman.com/zillow-to-shutter-ibuyer-business/)（二級）
- 對台灣平台的啟示（推論）：平台不應承擔房價預測風險；若要提供估價或收購，必須用夥伴資金並設定單邊曝險上限。

#### 其他 iBuyer
- Redfin 的 RedfinNow 在 2023-06 完成收攤，最後六季損失逾 $6,500 萬；主因包括資金成本上升與房價下行期降價壓力。 — [NAR Magazine](https://www.nar.realtor/magazine/real-estate-news/the-broken-promise-of-the-ibuyer)；[RISMedia 2022-12-16](https://www.rismedia.com/2022/12/16/where-does-ibuying-go-from-here/)（二級）
- Opendoor 2022 年買入近 35,000 間，2024 年 14,684 間，2025 年 8,241 間；另有兩次裁員，比例分別為 22%（2023 年 4 月）與 17%（年份未核對）。 — [HousingWire](https://www.housingwire.com/articles/ibuyers-opendoor-offerpad-losses-struggles/)；[Real Estate News](https://www.realestatenews.com/2026/02/19/opendoor-ceo-were-asking-you-to-hold-us-accountable)（二級）
- NAR 資料：約 1% 的賣家透過 iBuyer 賣屋。 — [NAR Magazine](https://www.nar.realtor/magazine/real-estate-news/the-broken-promise-of-the-ibuyer)（二級）
- 其他國家 iBuyer 的虧損資料：本次未取得。

#### WeWork 住宅線（WeLive）與共居
- WeLive 僅建成兩處，WeWork 在招股書承認它「可能不會產生有意義的營收或現金流」；住宅改建成本與法規高於辦公空間；之後 WeWork 退出管理，Rudin 接手華爾街館。 — [Scaled and Failed 搜尋結果](https://scaledandfailed.substack.com/p/issue-10-coliving)；[The Real Deal 2020-06-08](https://therealdeal.com/2020/06/08/wework-may-abandon-welive/)（二級）
- Common（共居營運商）曾快速擴張並與大型房東簽約，仍因無法達到獲利目標而結束營運，疫情加重壓力。 — [Propmodo](https://propmodo.com/?p=9316)（二級）
- ResiLife、Pierce Capital 的資料：本次未查到。

#### 其他風險案例
- Doma（見第 3 節）：依賴景氣循環的交易量，2023 年虧損 $1.244 億。
- PropertyGuru 2025 年裁員逾 170 人並關閉房貸與居家服務（見第 4 節）。
- RealPage 面臨反壟斷訴訟（見第 1 節）。

### Inferences
- 失敗模式一：自持存貨加預測模型（Zillow Offers、Opendoor）。
- 失敗模式二：把輕資產邏輯硬套重資產實體（WeLive、Common）。
- 失敗模式三：依賴單一景氣循環交易量（Doma、iBuyer）。
- 台灣平台的防線：以經常性訂閱收入為主，避免自持資產、避免直接持有客戶資金、避免跨房東共享訂價資料。

### Gaps
- Zillow Offers 買入與賣出總棟數、全年累計總損失：本次未取得 10-K MD&A 的確切數字（只讀到 10-K 前 10 萬字）。
- 各國（英國、澳洲、日本、新加坡）iBuyer 的虧損案例：未查到。
- WeLive 實際虧損金額：未查到。

---

## 附錄：來源品質與衝突備註

- AppFolio 官方新聞稿全文未取得（Nasdaq 頁逾時），營收與類別數字取自 Seeking Alpha 轉載的新聞稿，客戶數取自搜尋摘要。
- Buildium：官網現價（$65/$202/$420）與第三方舊價（$62/$192/$400）不同，以官網為準；Open API 的方案範圍，官網只明列 Premium。
- AppFolio Max 最低月費各來源差五倍，以官網「洽詢」為準。
- Opendoor 2025 全年淨損 $13 億與 Q4 單季 $11 億，兩數字來自不同的二級來源，未交叉核對 10-K 原文。
- Rightmove：營運利益 £287.9M 與基本營運利益 £297.7M 是不同口徑（後者排除股權激勵費用），兩者均出自公司 RNS，並無衝突。
- Bilt 營收有兩種說法互相矛盾（已達 $10 億或預期 2026 Q1 達到），不要引用單一數字。
- 貝殼 ACN 分佣與平台抽成比例，官方未公開；市面說法來自評論與前員工。
- 搜尋工具回傳的是摘要；標「二級」的項目建議在引用到正式報告前，回頭核對原始網頁。
