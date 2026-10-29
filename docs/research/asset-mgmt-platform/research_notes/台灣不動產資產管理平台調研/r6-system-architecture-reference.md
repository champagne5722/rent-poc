# R6：不動產資產管理平台的系統架構參考

調研日期：2026-10-29。

讀這份筆記前的三個提醒：

1. 本次搜尋工具回傳的多是摘要，不少官方頁面（財金公司、藍新、綠界費率頁、全國法規資料庫部分頁面）回 403 或 404，無法讀原文。條文與數字凡是只靠摘要的，Cited Findings 內都標「待核對原文」。
2. 「Inferences」是調研員的推論，不是來源明載的事實。架構選項的優缺點多屬此類。
3. 查不到的項目一律寫在 Gaps，沒有補猜。

---

## 1. 台灣銀行金流整合：虛擬帳號、信託專戶對帳與撥款、開放銀行、財金公司。平台怎麼知道買方的錢已入信託專戶？

### Takeaway
開放銀行（Open API）目前是「個人客戶授權第三方查詢與轉帳」的架構，未查到企業對企業（B2B）或「信託專戶入帳通知」的公開 API。平台要知道錢是否入專戶，實務上較可行的路是：銀行虛擬帳號加上銀行端對帳檔或企業端連線程式，或由信託銀行、建經公司出具入帳確認。信託專戶對帳與撥款有無公開 API，這次未查到。

### Cited Findings
- 金管會的開放銀行分三階段：第一階段公開資料查詢，第二階段消費者資訊查詢（需客戶授權），第三階段交易面資訊（轉帳、支付）。銀行公會負責自律規範，財金公司負責 API 技術與資安共通標準。 — [iThome：開放銀行第三階段正式上路](https://www.ithome.com.tw/news/160855)（摘要取自搜尋結果，頁面本身回 403，待核對原文）
- 第三階段規劃開放五大類、共 35 項服務：存款、貸款、信用卡、支付、手機門號轉帳。金管會宣布核備完成相關規範並受理業者申請。 — [iThome：開放銀行第三階段正式上路](https://www.ithome.com.tw/news/160855)（同上，待核對原文）
- 第二階段共 18 支消費者資訊 API，分存款類、貸款類、其他銀行服務三大類。 — [iThome：開放銀行第二階段 Q3 上路](https://www.ithome.com.tw/news/137909)（摘要，頁面回 403；此文為 2020 年前後報導）
- 臺灣企銀的開放銀行頁面只列第一、第二階段，不含第三階段。該行的第二階段 TSP 只有集保（TDCC）的「集保e手掌握」，自 2022 年 9 月起。第二階段授權期間自 2025-11-03 起由 90 天改為 1 年。 — [臺灣企銀 開放銀行 Open API](https://www.tbb.com.tw/zh-tw/digital/innovation/open-banking/open-api)
- 中國信託於 2025-11-07 宣布啟動第三階段：客戶以「集保e手掌握」串聯中信行動銀行，執行臺幣轉帳、活存轉定存、定存解約。文中提到金管會 2025 年 8 月核准。報導只談個人客戶，未談企業客戶。 — [工商時報](https://www.ctee.com.tw/news/20251107701068-430304)
- 搜尋結果另稱第三階段有四家先導銀行（第一、華南、玉山、中信），金管會採核准制，未明定轉帳金額上限。這些內容出自搜尋摘要，來源報導列於此：[中時 wantrich 2025-11-07](https://wantrich.chinatimes.com/news/20251107900475-420101)、[鉅亨網](https://m.cnyes.com/news/id/6223711)、[經濟日報](https://money.udn.com/money/story/5636/8834610)。逐篇對應未確認，待核對。
- 同一批摘要提到遠傳退出第二階段，參與第二階段的 TSP 只剩集保，業者參與第三階段的意願待評估。該報導未標日期。 — 見上列報導，日期未確認
- 搜尋「企業 B2B API、2026 時程」未找到對應資料，第三階段內容以個人消費者的存款、貸款、信用卡、支付、手機門號轉帳為主。 — [iThome：開放銀行第三階段](https://www.ithome.com.tw/news/160855)（摘要）
- 虛擬帳號是銀行提供企業的「銷帳工具」，款項對應回實際主帳戶；銀行把各通路繳款資料整理成統一銷帳格式。 — [uptogo：虛擬帳號是什麼](https://uptogo.com.tw/科技/虛擬帳號是什麼？/)（部落格性質的二手說明）
- 國泰世華 Global MyB2B 有「即時入金連線程式」：裝在企業端，定時自動蒐集帳戶交易明細；企業可據此在偵測虛擬帳號入金後自動更新訂單狀態。金額差 1 元，銀行端直接拒絕該筆交易。 — [uptogo](https://uptogo.com.tw/?p=1867221)（第三方文章，國泰官方規格未查到）
- 大型銀行與外商銀行提供對帳檔案下載（PDF、Excel、CSV）。 — [uptogo](https://uptogo.com.tw/?p=1867221)（同上）
- 虛擬帳號服務主要開放給法人收款單位；個人通常得透過第三方金流平台申請。 — [uptogo：做金流是什麼](https://uptogo.com.tw/財經/做金流是什麼？/)（二手說明）
- 價金信託實例（僑馥建經）：價金存入銀行名下信託專戶，各期價金匯入專屬帳號，受託人為中國信託。文件未說明系統介接方式。 — [僑馥申請書 PDF](https://www.tamco.com.tw/webtamco/wp-content/uploads/2026/09/申請書%20(僑馥)-北投桃源段-.pdf)
- 價金信託實例（安信建經）：玉山銀行同時擔任信託機構與價金保證人，投入上千萬元建置「信託金流管理系統」。新聞稿未揭露 API 規格或對帳流程。 — [經濟日報：安信建經獲信託公會創新獎勵](https://money.udn.com/money/amp/story/5621/9177322)
- 價金信託與履約保證的差別：價金信託的錢不經過建經公司專戶。 — [工商時報 2023-09-13](https://www.ctee.com.tw/news/20230913701296-430605)（摘要）
- 2019 年報導：安信、安新曾被質疑以一般公司帳戶而非信託帳戶收取履約保證款，金管會考慮把銀行辦理建經價金信託納入金檢。 — [Yam 新聞 2019-08-31](https://n.yam.com/Article/20190831958108)（摘要，待核對）

### Inferences
- 開放銀行第二、三階段的授權對象是「個人本人的帳戶」，且 TSP 需經金管會核准，實際只有集保一家上線。平台不適合把它當成「確認信託專戶入帳」的通道。它較可能的用途是未來讓買方授權平台查看自己的存款來源，但目前不可行。
- 平台確認入帳的可行做法有四種，由弱到強：
  1. 買方上傳匯款證明，由建經或平台人工確認。成本最低，不能自動化，舞弊風險最高。
  2. 銀行虛擬帳號加每日對帳檔（SFTP 或網銀下載）。適用條件：信託專戶或其前端收款帳戶屬法人開立，且銀行願開虛擬帳號。優點是銷帳規則由銀行保證（金額須完全相符）。缺點是延遲為批次，且專戶所有人通常是銀行或建經，平台拿不到檔，要靠對方轉交。
  3. 銀行端企業連線程式或網銀即時明細（如 Global MyB2B 類）。優點是接近即時。缺點是各行規格不同、綁單一銀行，且資料取得者必須是帳戶持有人（建經或銀行），平台是第二手。
  4. 信託銀行或建經公司以自己的系統（如安信/玉山的「信託金流管理系統」）推送「已入帳」狀態給平台。這是最貼近現行商業模式的做法：錢的真相留在銀行，平台只收狀態事件並留存證據。
- 因此架構上應把「入帳確認」設計成可替換的轉接層（adapter），平台內部只認一個標準事件（例如 `TrustDepositConfirmed`），來源可以是人工、對帳檔或銀行推送。這樣不必在第一版就押注單一銀行。
- 信託專戶的撥款指示通常要買賣雙方共同指示（見專案 `GLOSSARY.md` 與 R1 筆記）。平台負責蒐集雙方電子簽署的指示，再交給銀行或建經執行，平台不自己執行轉帳。這與電支條例的紅線一致（見第 2 題）。

### Gaps
- 信託專戶對帳與撥款有無公開 API：未查到。各銀行信託部的技術文件需向銀行索取，搜尋只找到新聞稿。
- 財金公司在入帳通知、銷帳、跨行代收付上的服務規格：未查到。財金公司官網與 Open API 平台回 403，搜尋亦無結果。
- 玉山、中信等銀行的企業 API、Webhook 入帳通知：未查到（搜尋結果均為國外銀行與金流商）。
- 開放銀行第二、三階段在 2026 年的最新參與者與上線進度：只查到至 2025-11 的資料，2026 年無結果。
- 國泰世華即時入金連線程式的官方規格：未查到。上述資訊全來自第三方部落格。

---

## 2. 第三方支付與電子支付：藍新、綠界、LINE Pay、街口在租金代收上的限制與費率，代收代付門檻

### Takeaway
「代理收付實質交易款項」依電子支付機構管理條例屬受管制業務：保管餘額超過金管會門檻（一年日平均餘額新臺幣 20 億元）就必須申請電支執照，且款項須存專用存款帳戶並信託或銀行保證。各家對「房租」是否屬實質交易、是否接受租金代收，這次未查到任何公開條款或費率，需向業者洽談。

### Cited Findings
- 電子支付機構管理條例（全國法規資料庫，最後修正 2023-01-19）：代理收付是指收受付款方依實質交易轉入的款項，待條件成就、期間屆滿或付款方指示再交付收款方。非電支業者不得經營代理收付，但「保管代理收付款項總餘額未逾金管會所定金額」者例外；超過須於六個月內申請許可。代理收付款項須存同幣別專用存款帳戶，並全額信託或由銀行全額履約保證。 — [全國法規資料庫：電子支付機構管理條例](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=G0380237)（摘要取自工具回傳，條號在摘要中前後不一致，待核對原文）
- 門檻以「一年日平均餘額」計，2021 年 6 月由 10 億元調高為 20 億元。超過須主動申請，不申請有刑責。 — [TechNews 2024-02-07（引中央社）](https://finance.technews.tw/2024/02/07/third-party-payment-provider-daily-average-balance-check/)；10 億調 20 億的說法另見 [TechNews 2022-04-20](https://finance.technews.tw/2022/04/20/3-third-party-payment-providers-are-close-to-the-threshold-of-electricity-payment-management/)（摘要）
- 2022 年有六家業者代收付日均餘額超過 10 億但未達 20 億：樂購蝦皮、藍新科技、綠界科技、LINE Pay、拍付國際、Foodpanda。 — [TechNews 2024-02-07](https://finance.technews.tw/2024/02/07/third-party-payment-provider-daily-average-balance-check/)
- LINE Pay Money 於 2025 年 7 月獲金管會許可經營電子支付機構業務，含代理收付、儲值、國內小額匯兌。 — [中時 wantrich 2025-07-17](https://wantrich.chinatimes.com/news/20250717900632-420101)（摘要，頁面未直接讀取）
- 藍新的服務分「代收模式」（藍新撥款給商店）與「閘道模式」（收單機構直接撥款給商店）。 — [WordPress：Newebpay Payment 外掛說明](https://wordpress.org/plugins/newebpay-payment/)
- 綠界 2026 年推出「安心收付」：由買方發起訂單、撥款天期可自訂、結合 TWCA 多重驗證與會員 KYC，買賣雙方免費，定位在二手交易、個人電商等高信任需求場景。 — [理財周刊（綠界 2026 Q1）](https://www.moneyweekly.com.tw/_Article?AID=225461)；[TechNews 2026-03-05](https://finance.technews.tw/2026/03/05/secure-payment/)
- 綠界信用卡一次付清費率「一般及商務會員 2.75%、最低 5 元」只見於一篇技術部落格，年份不明，非官方。 — 搜尋結果列出的 [hackmd 筆記](https://hackmd.io/@leonsnoopy/rJVzy9JuN) 與 [iThome 鐵人賽](https://ithelp.ithome.com.tw/articles/10230353)，二者中何者載明未逐篇確認，待核對
- 歐付寶 O'Pay 的抽成：信用卡 3%、ATM 與超商每筆 15 元（舊文章，非藍新非綠界）。 — [iThome 鐵人賽](https://ithelp.ithome.com.tw/articles/10196263)（摘要，來源對應待核對）
- 租賃住宅管理業（代管業、包租業）：代管範圍含收租與押金管理；須向房東、承租人揭露代管期間、代管費用、代收租金與代收押金等；被害人可在營業保證金範圍內請求賠償。 — [租賃住宅市場發展及管理條例（臺北市法規系統）](https://laws.gov.taipei/law/LawSearch/LawExport/FL087224?type=0)；[動腦/數位時代類報導 bnext](https://www.bnext.com.tw/article/91723/master-leasing-guide)（摘要，具體條次未取得）

### Inferences
- 租金代收有三種合法形態，適用條件不同：
  1. 平台不碰錢：租客直接匯給房東（或房東的虛擬帳號），平台只做提醒與記帳。零牌照負擔，缺點是沒有「平台確認收到錢」的控制點。
  2. 銀行虛擬帳號收款：款項直接進房東或業主法人帳戶，平台讀取銷帳結果。不構成代理收付，因為平台不保管款項。前提是房東或業主法人能開虛擬帳號，個人房東可能開不了（見第 1 題）。
  3. 藍新、綠界代收模式：款項先進金流商再撥款。金流商承擔代收付監理，平台只當商家。風險是金流商是否接受「租金」類別、是否要求商家是公司登記、撥款週期（T+N）是否符合房東現金流，三項都未查到公開條款。
- 平台若自己「保管」租金或價金，會碰到電支條例（或信託業法、租賃管理業的規定）。目前平台定位是不持有款項（見專案 `00-research-plan.md` 假設 2），建議維持，並在 ADR 寫明「超過此邊界就必須取得牌照或改走信託」。
- 費率比較沒有官方資料，不宜寫進 ADR 當依據。可寫「以 TWD 信用卡 2% 至 3% 級距、ATM 或超商每筆固定費為業界慣例，需以合約報價為準」，但這句也只是推論。

### Gaps
- 藍新、綠界官方費率頁：未查到（官網回 403 或 404）。
- 藍新、綠界、LINE Pay、街口對「房租」或「租金代收」的接受政策與限制：未查到。
- 街口支付的特約商店費率與租金用途：未查到。搜尋結果談的是街口 2025 年的風險事件與提領手續費，與本題無關，未納入。
- 租賃住宅管理條例中租金代收、專戶與履約保證的具體條文與條次：未取得，只有摘要層級資訊。
- 電支條例所稱「實質交易」是否涵蓋租金：未查到解釋函令。
- 20 億門檻自 2021 年以後有無再調整：未查到更新資料。

---

## 3. 多租戶 SaaS 資料隔離：schema-per-tenant、row-level security、PostgreSQL，台灣個資法下的資料存放要求

### Takeaway
資料隔離有 silo（每租戶一個資料庫）、bridge（每租戶一個 schema）、pool（共用表加租戶欄位，用 RLS 強制）三種。PostgreSQL 的 RLS 能把「靠開發者每次記得寫 WHERE」的風險移到資料庫層，但有連線池與擁有者繞過等陷阱。個資法本身對「資料放哪個國家」是限制式而不是禁止式，未查到對私部門 SaaS 的境內存放強制規定。

### Cited Findings
- AWS 的 SaaS 白皮書指出：認證與授權不等於租戶隔離。使用者通過登入與角色檢查，仍可能讀到別的租戶資源；隔離要另外用租戶情境去限縮資源存取。 — [AWS：Tenant isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html)
- PostgreSQL RLS 做法：每張租戶表開 RLS，policy 比對 `tenant_id = current_setting('app.current_tenant')`。應用程式連線後設定該 session 變數。 — [AWS Database Blog：Multi-tenant data isolation with PostgreSQL RLS](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/)
- RLS 陷阱：超級使用者與有 `BYPASSRLS` 的角色不受限；表擁有者預設不受限，除非 `FORCE ROW LEVEL SECURITY`；PgBouncer 這類連線池可能讓 session 狀態外洩或遺失，需測試。 — [AWS Database Blog](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/)
- 同文的比較：silo 隔離最強、成本與開通最複雜；bridge（schema per tenant）省一點成本，但維護與建立仍複雜；pool 加 RLS 成本最低、營運最簡單。每租戶一個資料庫角色不易擴充，所以建議用 session 變數。 — [AWS Database Blog](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/)
- 37signals 的 Fizzy 專案走「每位客戶獨立資料庫」，並開源 Active Record Tenanted gem。 — [37signals：Rails multi-tenancy](https://dev.37signals.com/rails-multi-tenancy/)（摘要，未讀全文）
- 個人資料保護法第 21 條：主管機關得在四種情形限制非公務機關國際傳輸個資：涉及國家重大利益、國際條約或協定有特別規定、接受國對個資保護未有完善法規而有損當事人權益之虞、以迂迴方式向第三國傳輸規避本法。 — [全國法規資料庫：個人資料保護法](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=I0050021)（摘要，待核對原文）
- 該法最後修正日為 2025-11-11（民國 114 年），部分條文施行日未定；主管機關為個人資料保護委員會。 — [全國法規資料庫](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=I0050021)（摘要）
- 非公務機關損害賠償：違法侵害個資，除能證明無故意過失外須負賠償責任；難以證明實際損害時，每人每事件得請求新臺幣 500 元至 20,000 元，同一原因事實總額上限 2 億元（第 28 條，第 29 條準用）。請求權時效 2 年（知悉起）或 5 年（損害發生起）。 — [全國法規資料庫](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=I0050021)（摘要，待核對原文）
- 一篇碩士論文指出，我國個資法採相當寬鬆的原則允許制，歐盟 GDPR 則原則禁止跨境傳輸。 — [國立中央大學博碩士論文](https://etd.lib.ncu.edu.tw/detail/1a8f2dd878b43b44da21549dbb09ef39)（搜尋摘要）
- 律所建議企業及早評估跨境傳輸的國際規範趨勢，因個資會已於 2023 年掛牌，任務含推動修法。 — [理律電子報 7198](https://www.leeandli.com/TW/Newsletters/7198.htm)（搜尋摘要）

### Inferences
- 三種隔離模式的選擇，適用條件如下：
  - pool 加 RLS：租戶多（數百以上）、每租戶資料量小、營運團隊小時最合適。這是本平台第一版的預設建議。缺點是 noisy neighbor、一次設錯 policy 影響全部租戶，必須有跨租戶滲透測試。
  - schema-per-tenant：租戶數在數十到數百、需要每租戶客製欄位時適用。缺點是遷移要對每個 schema 跑一遍，租戶上千時連線與目錄表膨脹。這點是工程常識的推論，未在來源中查證。
  - database-per-tenant：大型機構客戶（銀行、大型建經）要求獨立資料、獨立加密金鑰、可離線交付時才有必要。可當「企業版」選項保留，不必第一版就做。
- 本專案現況是 SQLite 單檔（ADR-0002）。SQLite 沒有 RLS。若沿用 SQLite，隔離只能在應用層強制（例如所有查詢經過帶 `tenant_id` 的資料存取層），或走 database-per-tenant（每租戶一個 SQLite 檔，與 37signals 路線類似）。進入多租戶與金流階段，建議換到 PostgreSQL，原因是 RLS、交易隔離層級、並行寫入與備援。
- 個資法下沒有查到對私部門「資料必須存放台灣」的強制規定；風險在於主管機關可限制特定國家的傳輸，以及賠償責任以過失推定計算。實務建議是把主資料放在台灣境內或亞太資料中心，並在 ADR 明記「若客戶是金融業（銀行、信託業、保險），其監理規定可能另有境內存放與委外要求，需另查」。這一句屬推論，法源未查證。

### Gaps
- 金融業（銀行、信託業、建經如適用）委外與雲端的境內存放要求：未查。屬金管會另行規定，本次未涵蓋。
- 個資法 2025 年修正的具體內容與生效日：只取得修正日期，未取得條文差異。摘要中第 27 條顯示為「刪除」，與常識不符，疑為摘要誤讀，待核對原文。
- 台灣在地雲端區域（資料中心）的服務與價格：未查。
- PostgreSQL 各隔離模式的效能實測數據：未查到可引用的基準測試。

---

## 4. 帳務：雙式分錄帳本、事件溯源、不可竄改稽核軌跡

### Takeaway
金流帳務建議用雙式分錄帳本（每筆交易借貸平衡，只增不改），而不是在合約狀態表上直接改餘額。事件溯源能提供完整歷程與時點重建，但對外部系統呼叫、版本演進、最終一致性有明顯成本，Fowler 也提醒只有真的會用到事件歷史時才值得。稽核軌跡的 hash chain 只能偵測竄改，擋不住有寫入權限者重算整條鏈，需搭配外部錨定。

### Cited Findings
- Event Sourcing 把所有狀態變更存成有序事件，狀態可由重播重建。好處：稽核與歷史、完整重建、時點查詢、修正錯誤事件後重播、除錯、append-only 少鎖、可快照。 — [Martin Fowler：Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
- Event Sourcing 的代價：開發者介面不自然、事件多時重播慢需快照、撤銷事件需存舊值、重播會重觸發對外訊息需用 gateway 隔離、外部查詢重播結果可能不同需記錄回應、讀端有最終一致性延遲、事後加入很困難所以要早決定。 — [Martin Fowler：Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
- 帳本核心概念：account、transaction（原子的金錢事件）、entry（借或貸）。API 必須指定來源與目的，錢不可憑空移動；每次變動永久記錄，可查歷史狀態；要防止亂序與並行寫入造成的重複花用；須支援時間區間內的快速加總。 — [Modern Treasury：How to scale a ledger, Part I](https://www.moderntreasury.com/journal/how-to-scale-a-ledger-part-i)
- 同文主張：使用者增加後效能會下降，建議用專門的帳本資料庫，自建需要數年、資深工程師、會計專業與對帳工具。這是廠商立場。 — [Modern Treasury](https://www.moderntreasury.com/journal/how-to-scale-a-ledger-part-i)
- 同文未涵蓋 pending/posted/available 餘額、idempotency 與鎖定機制細節。 — [Modern Treasury](https://www.moderntreasury.com/journal/how-to-scale-a-ledger-part-i)（本次只讀到 Part I）
- Saga 模式把跨服務交易拆成一串本地交易，失敗用補償交易回復；有 compensable、pivot（不可回頭點）、retryable 三類步驟；不具 ACID 的 I（隔離），會有 lost update、dirty read 等異常，對策有 semantic lock、commutative update、pessimistic view、reread value、version file。 — [Microsoft Azure Architecture Center：Saga](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga)
- Saga 的 choreography（事件驅動、無中心）適合簡單流程少數服務；orchestration（中央協調者）適合複雜流程、避免循環依賴，但協調者成為單點。 — [Microsoft Azure Architecture Center：Saga](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga)
- 資料庫更新與發訊息必須原子，無法用分散式交易時，用 Event Sourcing 或 Transactional Outbox。 — [microservices.io：Saga](https://microservices.io/patterns/data/saga.html)
- Hash chain 寫入最快、稽核最慢；Merkle tree 批次寫入較複雜，驗證成本低；常見設計是熱路徑用 hash chain，定期把 Merkle root 提交給外部見證。 — [Design Gurus：tamper-evident audit logs](https://www.designgurus.io/answers/detail/how-do-you-design-tamperevident-audit-logs-merkle-trees-hashing)（搜尋摘要）
- 只有 hash chain 擋不住有寫入權限者重寫並重算整條鏈，也擋不住截斷日誌，需外部錨定。 — [Vapora ADR-0039：Merkle audit trail](https://repo.jesusperez.pro/jesus/Vapora/src/branch/main/docs/adrs/0039-merkle-audit-trail.md)（個人專案 ADR，搜尋摘要）
- immudb 是帶 Merkle tree 的密碼學提交日誌，作者主張應稱 tamper-evident 而非 tamper-proof。 — [Elest.io：immudb 稽核日誌](https://blog.elest.io/immudb-ai-agents-build-a-tamper-proof-audit-log/)
- Amazon QLDB 將於 2025-07-31 結束支援。此日期來自第三方部落格，需對照 AWS 官方公告。 — [OneUptime：QLDB 文件歷史](https://oneuptime.com/blog/post/2026-02-12-verify-qldb-document-history/view)（搜尋摘要，待核對）
- 本專案現況：ADR-0007 決議平台合約歷程只是 append-only 的活動時間軸（建立、送簽、簽署、拒簽、完成、撤回），稽核級舉證交給點點簽的 Audit Trail File；若未來要平台自己的稽核級紀錄，屬新 effort、需重評。 — 本專案 `docs/adr/0007-activity-history-audit-delegated-to-dottedsign.md`

### Inferences
- 建議的分層：
  - 合約與流程狀態：維持「狀態表加 append-only 事件表」（現有 Contract Event 的延伸），不必全面事件溯源。理由：Fowler 列的外部系統重播問題，在本平台特別嚴重（點點簽 webhook、銀行入帳通知都是外部事件，重播時不能重新觸發）。
  - 金流與資金：獨立的雙式分錄帳本模組，只增不改，更正用沖銷分錄。每筆分錄關聯一個業務事件 ID，以便從合約事件追到帳。對平台而言這個帳本記的是「銀行信託專戶的鏡像」，真相仍在銀行。
  - 稽核：先用資料庫層 append-only（觸發器禁 UPDATE 與 DELETE、獨立寫入角色）加 hash chain，再定期把 chain head 錨定到平台外（例如對外簽章服務或時間戳記服務）。只有 hash chain 沒有外部錨定時，對內部人員竄改的保護有限。
- 跨方流程（簽約、撥款、過戶）適用 saga 的 orchestration 版本：參與者多（買方、賣方、仲介、地政士、建經、銀行），步驟有不可逆點（過戶登記完成、款項撥出是 pivot）。orchestration 的單點風險可由「持久化狀態機加重試」處理。本專案現有 `transitions.ts` 與合約狀態機（見 `docs/domain-model.md`）可往此方向擴充。
- 自建帳本與採購帳本資料庫的取捨：Modern Treasury 的說法有廠商偏見。若只是記錄鏡像分錄、每日筆數在萬級以下，用 PostgreSQL 加約束（借貸平衡檢查、不可更新）自建通常足夠；若要承擔真實資金移動與高並行，才需要專用帳本。此判斷屬推論。

### Gaps
- Modern Treasury 系列 Part II 以後（餘額種類、idempotency、鎖定）：未讀。
- Square、Stripe、Formance 等其他帳本設計的公開文章：未查。
- PostgreSQL 實作 append-only 與 hash chain 的具體作法（觸發器、pgaudit、邏輯複寫）：搜尋未涵蓋，未查到可引用的文件。
- 台灣法規對帳務紀錄保存年限與電子保存要求（商業會計法、稅捐稽徵法）：未查。
- QLDB 官方結束支援公告：未查證。

---

## 5. eKYC 與身分驗證：自然人憑證、TW FidO、行動身分識別、銀行身分驗證 API、健保卡；驗證強度分級

### Takeaway
最強且已有電子簽章整合的路徑是行動自然人憑證（TW FidO，LoA3，點點簽已於 2026-03 整合）。金融業有官方的四級信賴等級指引，採風險基礎配對，但指引沒有規定哪種方法屬哪一級。銀行身分驗證 API 與健保卡驗證，這次未查到公開資料。

### Cited Findings
- 內政部說明：行動自然人憑證 App 通過經濟部工業局安全標章第三級，符合 FIDO 2.0，達與實體自然人憑證相同的 LoA3。取代早期只能做身分識別的 TW FidO，具身分識別與電子簽章。FIDO 伺服器只保存公鑰。 — 搜尋結果列出的 [iThome 155040](https://www.ithome.com.tw/news/155040)、[iThome 150787](https://www.ithome.com.tw/news/150787) 等報導（逐篇對應未確認，待核對）
- 行動自然人憑證註冊流程：先用實體憑證在電腦端登錄，再以 App 掃 QR Code，完成指紋或臉部辨識。 — [TechNews：Taiwan FidO 綁定自然人憑證](https://technews.tw/?p=567803)
- 金融服務業辦理數位身分驗證指引（2023-10-24，民國 112 年）：應用場景風險分低、中、高、極高四級；對應最低信賴等級為一、二、三、四。指引不指定方法對應哪一級，由機構依規模、成本、市場、複雜度、法遵自行評估；多因子驗證等僅在控制措施條文中出現。 — [人壽公會法規查詢：金融服務業辦理數位身分驗證指引](https://law.lia-roc.org.tw/Law/Content?lsid=FL102313)（摘要；頁面未載發布機關）
- 金管會鼓勵金融業組成金融行動身分識別聯盟推動金融 FIDO，聯徵中心任召集人，財金公司協助制定技術規格。報導為數年前內容。 — 搜尋結果列出的 [iThome 143424 / 145040 / 149396](https://www.ithome.com.tw/news/145040)（逐篇對應未確認）
- 點點簽已通過數發部能量登錄計畫審核，整合中華電信快意簽雲端憑證；簽署者可用自然人憑證或工商憑證驗證身分。 — [TechNews：點點簽通過數發部能量登錄](https://technews.tw/?p=1276870)（摘要）
- 點點簽於 2026 年 3 月底完成行動自然人憑證（TW FIDO）整合並全面上線。 — [中時 wantrich 2026-04-08](https://wantrich.chinatimes.com/news/20260408900270-420101)（搜尋摘要，頁面回 403，待核對）
- 地政電子謄本的網路申請歷來要求自然人憑證或工商憑證驗證身分。 — [臺北市法規系統：內政部函釋 FE012757](https://laws.gov.taipei/Law/Interpretation/Content/FE012757)（舊函釋，年代為 2006 年前後）
- 綠界「安心收付」結合 TWCA 多重驗證與會員 KYC。 — [理財周刊](https://www.moneyweekly.com.tw/_Article?AID=225461)

### Inferences
- 建議把身分驗證做成與金融指引同構的四級，並依動作風險決定最低等級。這是設計建議，不是法規要求：
  | 等級 | 方法（可行選項） | 適用動作（建議） |
  |---|---|---|
  | 1 | Email 加 OTP、手機簡訊 | 瀏覽、看自己的合約 |
  | 2 | 手機 OTP 加證件影像上傳與人工審核，或行動身分 App 生物辨識 | 租約簽署（一般住宅租賃）、租金繳納設定 |
  | 3 | 行動自然人憑證（LoA3）、實體自然人憑證、工商憑證 | 買賣契約簽署、信託指示共同指示、修改收款帳戶 |
  | 4 | 臨櫃或公證人面對面、銀行臨櫃開戶 | 不動產物權移轉、抵押權設定（本來就得由地政士與地政機關處理） |
  此表的「適用動作」欄位無來源，由調研員依風險程度擬定，需法務確認。
- 自然人憑證的優點是可兼做身分驗證與數位簽章，點點簽已整合；缺點是持卡率與 App 綁定門檻，租客族群（年輕、外地、外籍）覆蓋不完整。外籍租客的替代：居留證加人臉比對，屬等級 2。
- 健保卡驗證與銀行身分驗證 API 沒查到。建議第一版不依賴，用「TW FidO 加人工審核」覆蓋。

### Gaps
- 健保卡作為身分驗證手段的現況與 API：未查到。
- 各銀行對外的身分驗證 API（「銀行帳戶綁定驗證」、聯徵中心身分驗證服務）：未查到。
- 數位皮夾（TW DIW）、數位身分證的 2026 年進度：只查到民間懶人包說法（數位身分證 2021 年暫緩），未查到官方 2026 資料。
- 洗錢防制法對不動產經紀與地政士的 KYC 要求：不在本次範圍，未查。
- 金融行動身分識別聯盟 2026 年進度：未查。

---

## 6. 電子簽章：點點簽、DocuSign、Adobe Sign 的法律效力與 Audit Trail；哪些不動產文件可以電子簽、哪些要公證

### Takeaway
電子簽章法 2024 年全文修正後，行政機關不能再用公告排除適用，既有公告一年後失效、得展延一次最長兩年。2002 年與 2021 年的排除公告涵蓋「不動產物權之設定、移轉、負擔及證明文書」，因此物權移轉與抵押權設定類文件，在 2026 年的有效性取決於展延，這次未查到展延公告，必須向主管機關或律師確認。租賃契約、買賣契約這類債權契約本身，不在這個排除範圍的字面內，但仍需個案確認。DocuSign 與 Adobe Sign 的台灣效力與 Audit Trail 這次沒查到。

### Cited Findings
- 電子簽章法於 2024-04-30 三讀修正全文，2024-05-15 公布；頁面載明 2024-05-17 起有效。 — [全國法規資料庫：電子簽章法](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0080037)；[維基文庫：電子簽章法 113 年版](https://zh.wikisource.org/wiki/電子簽章法_(民國113年))
- 第 4 條：符合本法的電子文件與電子簽章，功能上等同實體文件與簽章，不得僅因其電子形式否認效力。第 5 條：法令要求書面者，內容可完整呈現並可日後取出供查驗，得以電子文件為之；要求簽名蓋章者得以電子簽章為之；有相對人時須給合理反對機會，未反對視為同意。 — [維基文庫：電子簽章法 113 年版](https://zh.wikisource.org/wiki/電子簽章法_(民國113年))（轉引條文）
- 第 6 條：以數位簽章簽署，使用經主管機關許可之憑證機構簽發且在有效期內的憑證，推定為本人親自簽名或蓋章。 — [全國法規資料庫](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0080037)；[理律：電子簽章法修正](https://www.leeandli.com/TW/Newsletters/7256.htm)
- 第 11 條第 1 項：第 5 條第 1 至 3 項與第 8 條第 1 項「得依法律排除其適用」。 — [全國法規資料庫](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0080037)（原文引述）
- 第 20 條（原文）：修正施行前，行政機關依原第 4 條第 3 項、第 6 條第 3 項或第 9 條第 2 項公告排除適用者，各該公告自本法修正施行之日起算一年後停止適用；但經主管機關同意者，得展延一次，展延期間以二年為限。 — [全國法規資料庫](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0080037)
- 司法程序是否不適用本法，由司法院或法務部公告（第 1 條第 2 項）。 — [維基文庫](https://zh.wikisource.org/wiki/電子簽章法_(民國113年))
- 法務部 2002-03-21 令公告排除適用電子簽章法之文書：「不動產物權之設定、移轉、負擔及證明文書」。2021-02-09 法務部函（法律字第 11003500720 號）重申設定抵押權契約不適用電子簽章法，並說明會視網路不動產交易發展與各機關研議檢討。 — [臺北市法規系統：法務部函 FE347057](https://laws.gov.taipei/Law/Interpretation/Content/FE347057)
- 內政部 2021-06-01 台內地字第 1100262356 號公告「排除電子簽章法適用之項目（地政業務部分）」，並使 2002 年舊公告停止適用。 — [內政部地政司公告頁](https://www.land.moi.gov.tw/law/lawexplaindet/100?Nid=4865)（頁面讀取失敗，文號與日期取自搜尋摘要，具體排除項目清單未取得，待核對）
- 同類公告的落日實例：金管會帳簿劃撥排除公告自 2025-05-17 停止適用。 — [搜尋結果摘要，來源為 selaw 證券期貨法令判解系統](https://www.selaw.com.tw/Chinese/AdministrativeOrderResult?guid=959d0a86-b3ea-45b9-bcaf-4bae440f4946)（逐項核對未做）
- 民法第 166 條之 1（1999 年增訂，不動產物權移轉或設定契約須公證）的施行日期由行政院會同司法院另定，全國法規資料庫標示最後施行日期「未定」，即未施行。條文本文這次未取得。 — [全國法規資料庫：民法](https://mojlaw.moj.gov.tw/LawContentSource.aspx?LSID=FL001351)
- 點點簽自稱符合電子簽章法，使用中華電信快意簽 CA 與 AATL 認可的數位憑證防竄改，會員帳戶管控與稽核軌跡。具體時間戳記實作與訴訟證據力，來源未說明。 — [iThome PR 174848](https://www.ithome.com.tw/pr/174848)；[Yourator 點點簽介紹](https://www.yourator.co/company_blogs/313)（廠商自述）
- 本專案已實作：任務完成時從點點簽下載 Audit Trail File（含各方姓名、Email、時間戳、IP、裝置）並與已簽 PDF 並列保存。 — 本專案 `docs/adr/0007-activity-history-audit-delegated-to-dottedsign.md`、`docs/dottedsign-integration.md`

### Inferences
- 第 20 條的時間推算：修正施行 2024-05-17 起一年屆滿為 2025-05-17；若主管機關同意展延，期限最長再加二年，約至 2027-05。因此 2026-10-29 這個時點，內政部 2021 年的地政排除公告可能「已停止適用」，也可能「已展延、仍有效至最晚 2027 年中」。這次兩種都沒查到證據，不能下結論。系統設計上應把「文件是否可電子簽」做成可設定的規則表（依文件類型、日期生效），不要寫死。
- 不動產交易文件的電子簽可行性（建議做分類，需法務與地政士確認）：
  - 租賃契約（住宅租賃）：債權契約，未被列入物權排除範圍，電子簽可行性高。這也是現有 rent-poc 的核心場景。
  - 買賣契約（債權契約）：字面上不在「物權之設定、移轉、負擔及證明文書」內，但實務上常與移轉登記一併辦理，需確認地政機關對附件的認定。
  - 所有權移轉登記申請書、抵押權設定契約：落在排除範圍，原則上走紙本或地政機關現行電子申請（自然人憑證），平台只做流程管理與文件備置，不做簽署。
  - 信託契約、共同指示書：是銀行與當事人之間的契約，是否能電子簽取決於銀行規定。搜尋摘要提到玉山 2026-03 推出信託線上簽約（[工商時報 2026-03-25](https://www.ctee.com.tw/news/20260325700378-439901)，頁面未讀取，待核對），顯示銀行端有此需求，細節未查。
- 平台自身的簽署策略：持續委外給簽章服務商（目前點點簽），平台保存 Audit Trail 與已簽 PDF 的雜湊；不要自己做簽章。多供應商時以 adapter 介面隔離，簽署服務商差異（座標系、webhook 格式）限在 adapter 內，本專案 `src/lib/dottedsign.ts` 已有此雛形。
- 簽章強度分級與第 5 題的信賴等級掛鉤：一般租約用等級 2 到 3，買賣與信託指示用等級 3。

### Gaps
- DocuSign、Adobe Sign 在台灣的法律效力與 Audit Trail：未查（本次沒有搜尋這兩家）。
- 內政部地政業務排除公告的現況（是否展延、排除的具體項目）：未查到。需向地政司或數發部確認。
- 哪些不動產文件必須公證（租賃逾一定年限、強制執行公證、不動產買賣）：未查到可引用條文，只確認民法 166-1 未施行。
- 民法 166-1 條文本文：未取得。
- 電子簽章在法院的實際證據力案例：未查。

---

## 7. 文件與權狀：謄本電子化、地政電傳資訊、地籍資料 API 的取得方式

### Takeaway
未查到民間系統可直接介接的地政電子謄本 API。公開管道是：民眾或業者以自然人憑證、工商憑證在地政資訊網路服務申請電子謄本（按筆收費）；國土測繪中心提供地籍圖與地號的網路地圖服務；地方政府有土地基本資料庫電子資料流通（API 申請，有收費標準）。

### Cited Findings
- 內政部自 2005-01-01 起把土地登記及地價電子資料謄本分為第一類、第二類；第一類須當場核對申請人身分，第二類可用系統帳號申請（舊函釋）。網際網路申請謄本須憑自然人憑證或工商憑證驗證身分。 — [臺北市法規系統：內政部函釋 FE012757](https://laws.gov.taipei/Law/Interpretation/Content/FE012757)（舊函釋，現行是否變動未確認）
- 高雄市土地基本資料庫電子資料流通收費：以 API 申請依附表收費；其他方式每次 400 元，另登記資料每錄 0.5 元、地籍圖每筆 1 元（2019 年修正版本）。 — 搜尋結果列出的 [高雄市文件 PDF](https://orgws.kcg.gov.tw/001/KcgOrgUploadFiles/400/relfile/73703/203635/dcd4729b-bf11-44cd-98cb-52d61809af13.pdf)（摘要，地方規定）
- 臺北市收費基準表：登記資料每錄 0.5 元、地價資料每筆 0.01 元、地籍圖每筆 1 元；資料僅供申請目的使用，不得自行重製或交付他人。 — 同上搜尋結果（摘要）
- 電子謄本收費法源多為土地法第 79 條之 2。 — 同上搜尋結果（摘要）
- 彰化縣「地政資訊網路 e 點通服務系統」單筆宗地資料每筆收費新臺幣 10 元。 — [彰化縣地政：單筆土地網路申請地籍圖說明 PDF](https://landoffice.chcg.gov.tw/files/單筆土地網路申請地籍圖DXF%20檔說明_121_1141201.pdf)（摘要）
- 機關間查詢他縣市地籍資料須申請使用「地政資訊管理系統」，首次申請經地政局初審後由內政部同意連線，此規定針對政府機關。 — 搜尋結果列出的新北市地政局文件（摘要，[7-11.pdf](https://www-ws.land.ntpc.gov.tw/001/upload/oldfile/userfiles/fc/file/7-11.pdf)）
- 內政部釋示：不動產業者蒐集或利用所有權人住址資料，不得逾越特定目的的必要範圍。 — 同上搜尋結果（摘要，未讀原文）
- 國土測繪圖資網路地圖服務（maps.nlsc.gov.tw）提供地號查詢；接合版地籍圖經地段強制接合，可能與實際坐落有誤差，資料有半年以上時間落差，正確資料以各地政機關為準。 — 搜尋結果列出的 [彰化縣政府說明 PDF](https://www2.chcg.gov.tw/main/files/32_1040908_善用網路圖資，生活更easy談『國土測繪圖資網路地圖服務』之應用.pdf)（摘要）

### Inferences
- 第一版可行的做法是「使用者授權或人工取得」：由地政士或建經以其憑證申請電子謄本，平台接收 PDF 或電子檔，做歸檔、版本與到期提醒，不做自動比對。謄本有時效性（登記狀態會變），平台應記錄「取得時間」並在撥款前要求重新取得。
- 地籍圖與地號定位可用國土測繪中心的公開網路地圖服務做展示，但接合版有誤差，不可作為權利界址依據。
- 若要做自動化（例如撥款前自動查封查詢），需與地政機關或合法的電傳資訊代理業者簽約。該路徑的資格與費用這次沒查到，建議列為後續調研項目。

### Gaps
- 內政部「地政電傳資訊」對民間法人的現行申請資格與批次介接方式：未查到。
- 全國性電子謄本 API 的規格、收費、申請流程：未查到。僅有地方政府的資料流通收費標準。
- 謄本內容的個資遮蔽規則（第一類與第二類的現行區別）：只有舊函釋，現行規定未確認。
- 政府資料開放平臺（data.gov.tw）上可用的地籍或實價登錄 API：未查。

---

## 8. 參考架構：國外 property management SaaS（AppFolio、Buildium）、escrow 平台（Qualia）；event-driven saga 用在跨方流程

### Takeaway
AppFolio、Buildium、Qualia 的內部資料模型與架構，這次未找到公開的工程部落格。可引用的是通用的 saga 與 outbox 模式，以及 37signals 公開的每租戶資料庫做法。

### Cited Findings
- AppFolio 的公開資料只確認核心技術棧為 Ruby on Rails、TypeScript、GraphQL、React（來自徵才文），沒有租戶分割或資料庫架構的公開說明。 — 搜尋結果列出的 AppFolio 徵才頁（[wearedevelopers 職缺](https://www.wearedevelopers.com/jobs/ext/7065134/sr-software-engineer-accounting)，摘要）
- Qualia 無公開的資料模型工程文章；其 Google Cloud 客戶案例談的是用 Gemini 2.5 Flash 處理交易電子郵件與文件的 AI 層「Qualia Clear」。另有第三方描述大型產權公司可在自己的基礎設施上跑部分工作流程並連回 Qualia 雲端網路（二手說法）。 — [Google Cloud：Qualia 客戶案例](https://cloud.google.com/customers/qualia)；[StackShare：Qualia](https://stackshare.io/companies/qualia/blog)；[Altss 公司檔案](https://altss.com/profile/qualia)
- Saga 的 orchestration 與 choreography、補償交易、pivot 交易、異常對策。 — [Microsoft Azure Architecture Center：Saga](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga)
- Saga 沒有隔離性，需對策；更新資料庫與發訊息必須原子，用 Transactional Outbox 或 Event Sourcing；同步請求啟動非同步 saga 時，要設計通知客戶端結果的方式（回 ID 輪詢、webhook、WebSocket）。 — [microservices.io：Saga](https://microservices.io/patterns/data/saga.html)
- 37signals 的 Fizzy 採每租戶資料庫。 — [37signals：Rails multi-tenancy](https://dev.37signals.com/rails-multi-tenancy/)（摘要）

### Inferences
- 對本平台而言，Qualia 型的 escrow 流程在業務上對應「價金信託履約」：多方、有檢查點（收件、完稅、過戶）、有不可逆動作（撥款）。可借用的是「流程檢查清單加文件收集加資金狀態」的資料模型思路，但因為沒有公開文件，只能靠 R1 筆記的建經流程（簽約前、簽約後、用印、完稅、過戶、點交、結案七段）自行建模。
- 建議的跨方流程設計：每個案件一個 orchestrator（持久化狀態機），步驟分三類：可補償（通知、文件收集、預約）、pivot（款項撥出、地政登記完成）、可重試（結案通知、對帳回寫）。外部事件（點點簽 webhook、銀行入帳通知）都先落地到 inbox 表，以事件 ID 去重（idempotency）後再推進狀態機，更新狀態與寫 outbox 在同一資料庫交易內完成。
- 現有 rent-poc 的「點點簽 webhook 事件與狀態轉移在同一次交易寫入」（ADR-0007）已符合此思路，可直接延伸。

### Gaps
- AppFolio、Buildium 工程部落格或技術演講：未查到（只做了一次 AppFolio 搜尋，結果為徵才與通用 Rails 多租戶文章）。
- Buildium 完全未搜尋。
- Qualia 的資料模型、API 設計、帳務處理：未查到。
- 國內外 escrow 平台在銀行端的整合模式（如何收款項確認）：未查到。
- AWS、Azure 針對房地產或 escrow 的參考架構：未查。

---

## 9. 通知與多方協作：多角色（買方、賣方、仲介、地政士、建經、銀行）的權限模型（RBAC 或 ReBAC）

### Takeaway
多租戶、多角色、同一案件跨組織共享的場景，純 RBAC 容易產生「每個租戶、每個案件各一組角色」的膨脹。ReBAC（以關係定義權限，如 Google Zanzibar 路線的 SpiceDB、OpenFGA）更貼合「某人對某案件是什麼關係」。但工具有營運成本，早期可先用「RBAC 加案件成員表」。

### Cited Findings
- Google 於 2019 年發表 Zanzibar 論文，之後有 Keto、SpiceDB、OpenFGA、Auth0 FGA 等實作。SpiceDB 最貼近論文，強一致（zookie）；OpenFGA 強調關係模型。兩者皆 Apache 授權，可自架或託管。 — [Deepak Gupta：Zanzibar explained](https://guptadeepak.com/ciam-compass/guides/zanzibar-explained/)；[WorkOS：開源 Zanzibar 實作](https://workos.com/blog/top-5-google-zanzibar-open-source-implementations-in-2024)（搜尋摘要）；忠實度比較表出自 Permify 自家頁面，有利益關係：[Permify](https://permify.notion.site/Differentiation-9a7b31e5e029454ca3148a9f89ed9a2a)
- OpenFGA 文件主張：RBAC 適合扁平、單租戶；遇到層級、分享或多租戶就吃力，因為「組織 42 的 admin」與「組織 43 的 admin」要各自一個角色，隨租戶倍增。同一份文件也說多數內部工具與早期 SaaS 用不著關係引擎，過早導入是過度設計。這是廠商立場。 — [OpenFGA：RBAC vs ReBAC](https://openfga.dev/docs/learn/rbac-vs-rebac.md)
- ReBAC 有學習曲線，高可用部署需實際營運投入；SpiceDB 需要持久化儲存且設計為集中式服務。 — [Start with Identity：開源授權工具比較](https://startwithidentity.com/articles/top-7-open-source-authorization-tools/)（搜尋摘要）
- AWS 白皮書：認證與授權（含角色）不等於租戶隔離，隔離要另外以租戶情境限縮資源。 — [AWS：Tenant isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html)

### Inferences
- 角色與關係的建議建模（需與 R1、R2 的角色定義對齊）：
  - 租戶（Tenant）：一家建經、一家仲介公司、一個物業管理公司。
  - 案件（Case）：一筆買賣或一份租約，屬於一個發起租戶。
  - 案件成員（CaseMember）：人或組織在該案件的關係，如 buyer、seller、agent、land_scrivener、trust_officer、bank。權限由「關係加動作」決定，例如 `bank` 只能對「信託指示」物件 read 與 confirm。
  - 這個結構本身就是 ReBAC 的資料；即使不用 SpiceDB，用資料表 `case_members(case_id, party_id, relation)` 加應用層檢查就能起步，之後再遷移到 OpenFGA 或 SpiceDB。
- 選擇條件：
  - 先用 RBAC 加案件成員表：第一版，租戶與案件角色種類 10 種以下，授權檢查在同一資料庫能完成。優點：零新增基礎設施，可與 PostgreSQL RLS 結合。缺點：若出現「跨組織共享、分享給第三方、巢狀群組」，自刻邏輯會變複雜。
  - 導入 OpenFGA 或 SpiceDB：出現多層組織（總公司與分公司）、文件級共享、需要「誰能看這份文件」的反向查詢（list objects）時。缺點：多一個高可用服務，且 RLS 與 ReBAC 兩套授權要保持一致。
- 通知：多方流程的通知要有「誰在等誰」的待辦模型（每個流程步驟標註當前負責角色與期限），避免只靠 email。這點是設計建議，無來源。本專案已有 email 簽署流程與 webhook，可作為通知通道之一。

### Gaps
- 房地產、建經領域實際採用 RBAC 或 ReBAC 的公開案例：未查到。
- 台灣個資法對「多方共享同一案件資料」的告知與同意要求（買賣雙方看到對方個資的範圍）：未查。
- OpenFGA、SpiceDB 的效能數據與在多租戶下的最佳實務：未讀文件原文，只有摘要。

---

## 10. 既有 rent-poc 系統：哪些可沿用、哪些要換

### Takeaway
合約模組（條款庫、三層文件、PDF 產生、點點簽整合、合約衍生不可變）與 antd 設計系統可沿用到新平台的「合約管理模組」。儲存層（SQLite 單檔）、授權（目前沒有多租戶）、稽核（委外給點點簽）、金流（無）需要換或新增。

### Cited Findings
- 技術棧：Next.js 16.2.11、React 19.2.4、antd 6.5.1、better-sqlite3、pdf-lib、vitest。 — 本專案 `package.json`
- ADR-0002：Next.js 單一專案加 SQLite，原因是 OAuth token 交換需在伺服器端、簽署狀態靠 webhook、PoC 要降低維護與交接成本。 — 本專案 `docs/adr/0002-nextjs-fullstack-sqlite.md`
- ADR-0007：平台合約歷程為活動時間軸，稽核級舉證交給點點簽 Audit Trail File。 — 本專案 `docs/adr/0007-activity-history-audit-delegated-to-dottedsign.md`
- 本專案另有 ADR-0006（合約不可變，以衍生取代修改）、ADR-0008（三層合約文件）、ADR-0009（DESIGN.md 驅動 antd 主題）、`src/lib/` 內的 `dottedsign.ts`、`signing.ts`、`transitions.ts`、`contract-clauses.ts`、`pdf*.ts`。 — 本專案 `docs/adr/` 與 `src/lib/` 目錄
- 專案 AGENTS.md 警告此 Next.js 版本與一般認知有破壞性差異，開發前須先讀 `node_modules/next/dist/docs/`。 — 本專案 `AGENTS.md`

### Inferences
| 模組 | 判斷 | 理由 |
|---|---|---|
| Next.js 全端、antd | 沿用 | 多租戶與 RLS 不依賴前端框架；授權檢查放在伺服器端資料存取層。API routes 與 webhook 接收模式可延續。 |
| 點點簽整合（`dottedsign.ts`、webhook） | 沿用，加 adapter 介面 | 2026-03 已整合行動自然人憑證，簽章強度可滿足等級 3。多供應商時抽出介面。 |
| 合約條款庫、三層文件、PDF 產生、不可變衍生 | 沿用 | 是平台合約管理模組的起點；ADR-0006 的不可變設計與帳務沖銷思路一致。 |
| 狀態機（`transitions.ts`） | 擴充 | 單一合約狀態機要擴成案件層級 orchestrator，加入 pivot 與補償概念。 |
| SQLite（better-sqlite3） | 要換 | 無 RLS、單檔寫入並行受限、備援與時點復原弱。換 PostgreSQL。遷移影響 `src/lib/db.ts` 與所有 `*-db.test.ts`。 |
| 租戶與授權 | 新增 | 目前無租戶、無案件成員。需加 `tenant_id`、RLS、案件成員表（見第 3、9 題）。 |
| 稽核軌跡（ADR-0007） | 保留並補強 | 點點簽 Audit Trail 管簽署；金流、權限變更、撥款指示等平台事件需自己的 append-only 加 hash chain（見第 4 題）。ADR-0007 末段已預留「若需要平台側稽核級紀錄，屬新 effort、需重評」，應新增 ADR 取代。 |
| 金流與帳本 | 新增 | 全新模組：雙式分錄鏡像帳、銀行入帳 adapter、撥款指示管理。 |
| 身分驗證 | 新增 | 等級化驗證與行動自然人憑證串接（第 5 題）。 |
| 文件庫（謄本、權狀） | 新增 | 檔案儲存（物件儲存）、版本、取得時間、到期提醒。現有 `contract-files*` 可參考。 |

建議的 ADR 清單（供後續撰寫，標題為建議）：多租戶隔離策略（PostgreSQL 加 RLS）、資料庫由 SQLite 遷移到 PostgreSQL、雙式分錄帳本設計、案件 orchestrator 與外部事件 inbox/outbox、稽核軌跡與外部錨定、入帳確認 adapter、授權模型（案件成員加 RBAC，保留 ReBAC 升級路徑）、身分驗證等級、電子簽章文件類型規則表。

### Gaps
- 本專案資料量、並行量的實際數據：未查（不在本次網路調研範圍）。
- PostgreSQL 託管方案在台灣的選項與成本：未查。
- 從 SQLite 遷移到 PostgreSQL 的工作量估計：未做。
