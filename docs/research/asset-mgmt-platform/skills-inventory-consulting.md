# 顧問類 skill 盤點：strategy-frameworks 與 management-consulting

## 結論

兩個 plugin 都只有方法論文字，沒有資料來源。
它們不會上網查資料，也不會自己驗證市場假設。
市場事實必須由 Sonnet 調研先查，再餵給框架 skill。

management-consulting 比較貼近提案工作，也比較短。
strategy-frameworks 的框架內容完整，但輸出格式偏英文與韓文。
呼叫時必須要求輸出繁體中文。

## 一、通則與限制

### 呼叫名稱

- Skill tool 的名稱格式是 `plugin 名稱:skill 名稱`。
- 依 plugin.json 與 README 推斷，名稱如下。
  - `strategy-frameworks:bmc`
  - `management-consulting:strategic-analysis`
- 使用者範例的格式是 `<UUID>:bmc`。
- 主對話必須在重新載入後，用 Skill tool 清單確認實際前綴。
- 目錄名 `plugin_01DZ...` 與 `plugin_01Db...` 是安裝路徑，不是 skill 名稱。

### strategy-frameworks（版本 0.2.0，27 個 skill）

- 所有框架 skill 的 frontmatter 都是 `user-invocable: false`。
- 這表示不出現在斜線選單，但模型可用 Skill tool 呼叫。
- `/think` 是唯一的路由入口，會依關鍵字選 1 到 3 個框架。
- `/think` 的流程是分類、選框架、執行、綜合，最後給 3 個行動。
- `/think:select` 只推薦框架，不執行。
- `/think:compare` 把 2 到 3 個框架套在同一問題上比較。
- `/think` 的輸出有框線與表情符號，語言以英文為主。
- `/think` 的 Detection Matrix 含韓文關鍵字。
- README 與 `/think` 提到 `/toc` 與 `/triz`，但這次安裝沒有這兩組。
- 路由表中的 TOC 與 TRIZ 路徑不可用。
- SKILL.md 內寫的 `/think:bmc`、`/porter:forces` 等子指令，這次安裝都不是真實指令。
- 建議直接用 Skill tool 呼叫框架，不經 `/think`。
- 框架 skill 的標題有韓文雙語標籤，輸出前必須指定「全程繁體中文，不含韓文」。
- 每個框架都沒有外部資料，也沒有網路查詢。
- 每個框架都不強制問使用者，但輸入太少時會產出泛泛內容。

### management-consulting（版本 2.2.0，16 個 skill）

- README 寫明呼叫方式：`/management-consulting:strategic-analysis`。
- 每個 SKILL.md 約 40 行，是原則型指引，不是逐步範本。
- 細節放在 `references/` 子檔，用到時才讀。
- 全部是英文，沒有內建模板，也沒有固定步驟數。
- 原則：缺資料時標註缺口後繼續，只在答案會改變決策時才問。
- 原則：不編造數字、基準、客戶經驗或來源。
- 原則：預測、事實、判斷、示意例子要分開標示。
- 原則：建議的負責人與日期標為提案，不寫成承諾。
- 輸出沒有固定長度，由使用者的要求決定。
- 沒有網路查詢能力，需要外部資料時依賴主對話提供。

## 二、strategy-frameworks：逐項盤點

「步驟」欄是 SKILL.md 內的主流程段數。
「輸入」皆為自然語言問題描述，另列需補的背景。

### bmc（商業模式圖）

- 呼叫：`strategy-frameworks:bmc`
- 輸入：公司或產品、目標客群、現有收入模式。
- 輸出：9 個區塊的畫布、區塊互動、最危險的假設、建議。
- 另有價值主張畫布（客戶輪廓、價值地圖、適配度）。
- 另有 5 種模式比對：免費增值、平台、剃刀刀片、訂閱、長尾。
- 步驟：9 個區塊，加 VPC、模式、假設驗證三段。
- 有用章節：商業模式（三階段各畫一張）、BRD 的價值主張。
- 限制：一階段一張畫布，共三張。
- 限制：多邊平台模式（房東、房客、經理人）要自行指定。
- 限制：內容建議先有 JTBD 與市場資料。
- 限制：SKILL.md 約 600 行，輸出很長，需限制範圍。

### jtbd（待完成工作）

- 呼叫：`strategy-frameworks:jtbd`
- 輸入：目標使用者與其情境，最好有訪談或轉換故事。
- 輸出：核心工作敘述、功能、情感、社會三類工作。
- 輸出：8 步工作地圖、進步的力量、機會地形、競爭集合。
- 步驟：工作敘述、三面向、8 步工作地圖、ODI 機會算法。
- 有用章節：市場與競品（競爭者包含替代做法）、PRD 的使用者角色。
- 限制：真正的 JTBD 需要使用者訪談。
- 限制：沒有訪談時，只能產出假設版，必須標示。
- 限制：機會算法需要重要性與滿意度評分，我們沒有這份資料。

### porter（五力、價值鏈、通用策略）

- 呼叫：`strategy-frameworks:porter`
- 輸入：產業範圍與市場邊界。
- 輸出：五力評分、價值鏈、通用策略建議。
- 步驟：五力、價值鏈、通用策略三段，另有鑽石模型。
- 有用章節：市場與競品、假設驗證。
- 限制：必須先定義產業邊界。
- 限制：邊界選錯，五力就失真。
- 限制：不動產仲介、物管、買賣、資管可能是不同產業，建議分開跑。
- 限制：鑽石模型是國家層級，本案不需要。
- 限制：評分需要市場資料，由調研提供。

### blue-ocean（藍海策略）

- 呼叫：`strategy-frameworks:blue-ocean`
- 輸入：現有競爭因素與競品。
- 輸出：策略畫布、ERRC 表（消除、減少、提升、創造）。
- 輸出：三層非顧客、六條路徑、BOI 指數驗證。
- 步驟：5 步（畫布、ERRC、非顧客、六路徑、BOI 驗證）。
- 另有 2017 年藍海轉型 5 步流程。
- 有用章節：商業模式差異化、「沒有整合服務」假設的反面檢驗。
- 限制：藍海是策略論述，不是證據。
- 限制：不能拿它證明「市場沒有整合服務」。
- 限制：那個結論必須由競品調研支撐。

### scenario-planning（情境規劃）

- 呼叫：`strategy-frameworks:scenario-planning`
- 輸入：核心問題、時間範圍（預設 5 年）、產業背景。
- 輸出：驅動力清單、2x2 矩陣、4 個情境敘事。
- 輸出：訊號指標、風洞測試、強健策略與觸發條件。
- 步驟：8 步。
- 有用章節：風險、Phase 2 與 Phase 3 的路線取捨。
- 限制：Phase 2 信託帳戶受法規影響大。
- 限制：Phase 3 繼承與移交受法規影響大。
- 限制：法規情境要由調研先給事實。
- 限制：不可替情境指定機率，skill 本身也這樣要求。

### swot-pestel（SWOT 加 PESTEL）

- 呼叫：`strategy-frameworks:swot-pestel`
- 輸入：公司或計畫，以及所處市場。
- 輸出：SWOT、TOWS 策略矩陣、PESTEL 六面向、整合表。
- 步驟：3 個框架（SWOT、TOWS、PESTEL），再整合。
- 有用章節：外部環境、法規風險。
- 限制：PESTEL 的政治與法律面必須有台灣法規事實。
- 限制：事實由 Sonnet 調研提供。
- 限制：本案尚無公司本體，SWOT 的 S 與 W 只能寫成對自身能力的假設。

### stp（區隔、目標、定位）

- 呼叫：`strategy-frameworks:stp`
- 輸入：產品概念與候選客群。
- 輸出：區隔依據、目標策略、定位圖、定位宣言。
- 步驟：3 步（區隔、目標、定位）。
- 有用章節：目標客群、Phase 1 的首批使用者。
- 限制：沒有市場資料時，區隔只是假設。
- 限制：Phase 3 高端客戶的定位要另外跑一次。

### lean-startup（精實創業）

- 呼叫：`strategy-frameworks:lean-startup`
- 輸入：商業假設清單。
- 輸出：假設表、MVP 設計、創新會計指標、轉向類型。
- 步驟：建構、衡量、學習三步循環，另有 10 個章節。
- 有用章節：路線圖的驗證關卡、各階段的進出條件。
- 限制：它假設有真實實驗。
- 限制：提案階段只能列出「要驗證什麼」，不能宣稱已驗證。

### first-principles（第一原理）

- 呼叫：`strategy-frameworks:first-principles`
- 輸入：要挑戰的既有假設。
- 輸出：假設清單、基本事實、重建方案、差距。
- 步驟：5 步（辨識假設、拆解、五個為什麼、重建、找差距）。
- 有用章節：議題拆解，檢驗「市場沒有整合服務」的前提。
- 限制：內容短（約 120 行），產出偏通用。
- 限制：需要使用者給出具體假設。

### disruptive-innovation（破壞式創新）

- 呼叫：`strategy-frameworks:disruptive-innovation`
- 輸入：進場者、現有業者、客群。
- 輸出：低階或新市場破壞判定、性能軌跡、三條件檢驗。
- 輸出：現有業者的回應選項。
- 步驟：三條件檢驗，加兩種破壞類型。
- 有用章節：競品為何沒做整合（現有業者的流程與價值觀限制）。
- 限制：本案是整合型產品，不一定符合破壞式創新。
- 限制：先跑三條件檢驗，不符合就不要硬套。

### real-options（實物選擇權）

- 呼叫：`strategy-frameworks:real-options`
- 輸入：投資決策、不確定性來源、可分階段的選項。
- 輸出：選擇權辨識、類型（延後、擴張、放棄、分階段）。
- 輸出：決策樹或二項式估值，或定性評分。
- 步驟：辨識 7 類選擇權，再選 4 種估值法之一。
- 有用章節：三階段路線的關卡設計、財務假設。
- 限制：量化估值需要現金流與波動度。
- 限制：本案資料不足，建議只用定性評分與決策樹。

### think（路由器）

- 呼叫：`strategy-frameworks:think`
- 步驟：4 步（分類、選框架、執行、綜合）。
- 輸出：框線格式報告，附 3 個行動。
- 限制：輸出格式與本案風格衝突。
- 限制：路由表一半指向未安裝的 TOC 與 TRIZ。
- 建議：只當「選框架」的參考，不實際呼叫。
- 對本案的路由結果等同：新創與新服務走 BMC、STP、行銷組合、精實創業。
- 對本案的路由結果等同：進入新市場走 SWOT-PESTEL、Porter、STP、藍海、BMC。

## 三、management-consulting：逐項盤點

### strategic-analysis（策略分析）

- 呼叫：`management-consulting:strategic-analysis`
- 輸入：決策、決策者、期限、成功標準、限制，以及已有證據。
- 輸出：議題拆解、可檢驗的假設、選項比較、建議。
- 輸出格式不固定，可以是段落、議題樹或工作計畫。
- 結構：框定問題、診斷與比較、證據與不確定性、交付決策，共 4 段。
- 參考檔：`market-and-competition.md`（市場規模、競品、研究轉決策）。
- 參考檔：`strategic-frameworks.md`（依問題選框架）。
- 有用章節：假設驗證的議題拆解、市場與競品、商業模式。
- 限制：不上網，外部事實由主對話或調研提供。
- 限制：要求每個結論可追溯來源，缺資料會標示未驗證。
- 限制：框架不設最低數量，不會硬湊。

### implementation-planning（實施計畫）

- 呼叫：`management-consulting:implementation-planning`
- 輸入：已核可的建議、限制、里程碑、資源、基準。
- 輸出：成果與驗收標準、工作流、相依關係、關卡、RACI、風險與觸發條件。
- 結構：選可行做法、排序、指派與控管、交付與檢查，共 4 段。
- 參考檔：`scheduling-and-resourcing.md`（排程、資源、效益、復原）。
- 有用章節：三階段路線與實施計畫、風險。
- 關卡概念：依證據釋放承諾，結果為繼續、有條件繼續、修訂、停止。
- 限制：不會替沒有核可的日期與負責人編造承諾。
- 限制：日期與負責人必須標為提案。
- 限制：本案沒有客戶方資源資料，容量與預算只能寫假設。

### financial-modeling（財務建模）

- 呼叫：`management-consulting:financial-modeling`
- 輸入：現金流驅動因子、基準、期間、幣別。
- 輸出：增量經濟分析、NPV 或 IRR、敏感度、損益平衡門檻。
- 結構：建立模型基礎、增量經濟、測試決策、呈現與驗證，共 4 段。
- 參考檔：`cash-flow-conventions.md`、`technology-and-tco.md`、`valuation-and-risk.md`。
- 有用章節：財務假設、商業案例。
- 限制：明確禁止編造成本、預測、基準。
- 限制：沒有資料時只能給假設登記表與公式，不能給「預估值」。
- 限制：不能套用固定 10% 敏感度或固定折現率。
- 限制：要求資金可行性與投資報酬分開看。

### client-deliverables（客戶交付物）

- 呼叫：`management-consulting:client-deliverables`
- 輸入：受眾、要做的決策、證據、格式、模板。
- 輸出：報告、決策備忘錄、高層簡報的敘事線與展示頁。
- 結構：建立論證、選擇成品、交付前檢查，共 3 段。
- 參考檔：`written-reports.md`、`executive-presentations.md`、`slide-design.md`、`pptx-generation.md`。
- 附 `scripts/consulting-charts.cjs`（可編輯的 PPTX 圖表，需自備 PptxGenJS）。
- 有用章節：簡報結構與行動標題、BRD 與 PRD 的組織方式。
- 重點：標題寫成有證據支撐的結論，答案先行。
- 限制：明說銷售提案與推銷簡報要用 `proposal-development`。
- 限制：本案是提案，所以簡報結構應以 proposal-development 為主，此 skill 為輔。
- 限制：產生 PPTX 要有 Node 與 PptxGenJS，主對話另有 pptx skill 可用。

### due-diligence（盡職調查）

- 呼叫：`management-consulting:due-diligence`
- 輸入：交易或合作決策、範圍、資料室。
- 輸出：命題、證據表、發現分級、繼續或拒絕的建議。
- 結構：調查命題、轉成決策、交付，共 3 段。
- 參考檔：`commercial-operational.md`、`financial-and-integration.md`。
- 對本案價值有限，本案不是併購。
- 可借用的部分：用「必須成立的命題與推翻證據」檢驗使用者的商業假設。
- 可借用的部分：把發現分成致命、前置條件、可管理。
- 限制：只適合假設驗證的收尾，不建議整份套用。

### engagement-setup（專案啟動）

- 呼叫：`management-consulting:engagement-setup`
- 輸入：已簽訂的專案範圍、團隊、時程。
- 輸出：啟動會議、章程草稿、探索計畫、利害關係人評估。
- 結構：準備啟動、設計探索、建立工作安排、交付，共 4 段。
- 參考檔：`project-charter-template.md`、`discovery-methods.md`。
- 對本案價值低，前提是「得標之後」。
- 可借用的部分：Phase 1 啟動時的利害關係人地圖與探索計畫。
- 可借用的部分：把使用者訪談設計成「每題對應一個決策」。
- 限制：不建議在提案階段使用。

### writing-style（寫作風格）

- 呼叫：`management-consulting:writing-style`
- 輸入：要審稿或改寫的稿件，受眾與長度。
- 輸出：改寫後的稿件或審稿意見。
- 結構：一頁式規則，約 29 行。
- 規則重點：答案先行、具體名詞、主動動詞。
- 規則重點：刪除「釋放價值」這類套話。
- 規則重點：事實、預測、判斷分開。
- 規則重點：原創文字不用破折號。
- 限制：規則以英文為基礎。
- 限制：與全域 CLAUDE.md 的 `i-have-adhd-zh-tw` 與 STE100 重疊。
- 限制：兩者衝突時，以使用者全域規則為準。
- 限制：適合當審稿檢查表，不建議當生成指令。

### thought-leadership（觀點文章）

- 呼叫：`management-consulting:thought-leadership`
- 輸入：研究材料、受眾、核准的案例。
- 輸出：POV、白皮書、案例、產業簡報。
- 結構：發展論點、建立成品、使用專案經驗、審查，共 4 段。
- 參考檔：`content-and-evidence.md`。
- 對本案價值低，本案是提案而非行銷文章。
- 可借用的部分：「論點、機制、邊界條件、最強反方解釋」的檢查。
- 限制：只在要寫產業觀察章節時才用。

## 四、對應表

執行者代號：
- 主：主對話（Opus 級，負責編排、取捨、與使用者互動）。
- 調研：Sonnet 調研（負責查資料、整理來源）。
- 撰寫：Opus 撰寫（負責長篇文件與整合）。

| 工作項目 | 建議 skill | 誰執行 | 備註 |
|---|---|---|---|
| 假設驗證的議題拆解 | `management-consulting:strategic-analysis`、`strategy-frameworks:first-principles` | 主 | 把三個假設寫成可檢驗命題，並列出推翻證據。 |
| 市場與競品分析 | `management-consulting:strategic-analysis`（參考 `market-and-competition.md`）、`strategy-frameworks:porter`、`strategy-frameworks:jtbd` | 調研先查事實，主呼叫 skill 套框架 | 競品要從買方角度看，含傳統做法與替代品。 |
| 外部環境與法規 | `strategy-frameworks:swot-pestel` | 調研查台灣法規，主套框架 | 信託、電子簽章、繼承是重點。 |
| 商業模式設計 | `strategy-frameworks:bmc`、`strategy-frameworks:stp`、`strategy-frameworks:blue-ocean` | 撰寫 | 每階段一張畫布。藍海僅作差異化論述。 |
| 三階段路線與實施計畫 | `management-consulting:implementation-planning`、`strategy-frameworks:real-options`、`strategy-frameworks:lean-startup` | 撰寫，主審 | 用關卡與進出條件，不寫死日期。 |
| 情境與不確定性 | `strategy-frameworks:scenario-planning` | 撰寫 | 法規與信託情境用在 Phase 2 與 Phase 3。 |
| 財務假設 | `management-consulting:financial-modeling` | 撰寫 | 只出假設登記表與損益平衡門檻，不編數字。 |
| 風險 | `strategy-frameworks:scenario-planning`、`management-consulting:implementation-planning` | 撰寫 | 風險要附觸發條件與備案。 |
| BRD 撰寫 | `management-consulting:strategic-analysis`（結論）、`management-consulting:client-deliverables`（報告結構） | 撰寫 | 另用主對話的 pyramid-principle 與 proposal-development。 |
| PRD 撰寫 | 無直接對應 skill。可用 `strategy-frameworks:jtbd`（使用者角色與工作）。 | 撰寫 | 改用 repo 內的 spec 與 GLOSSARY 規則。 |
| 簡報結構與行動標題 | `management-consulting:client-deliverables`（參考 `executive-presentations.md`）、`strategy-frameworks:pyramid-principle` | 主定結構，撰寫產出 | 主對話另讀 proposal-development 的 `pitch-deck.md`。 |
| 提案文字風格 | `management-consulting:writing-style` 當審稿檢查表 | 主 | 優先順序：使用者全域規則高於此 skill。 |

## 五、建議的使用順序

1. 主對話先用 `strategic-analysis` 的框架，把三個假設拆成命題。
2. Sonnet 調研依命題查事實，並標示來源與日期。
3. 主對話把事實餵給 `porter`、`jtbd`、`swot-pestel`。
4. 撰寫階段用 `bmc`、`real-options`、`implementation-planning`、`financial-modeling`。
5. 最後用 `client-deliverables` 與 `writing-style` 整理並審稿。

## 六、注意事項

- 兩個 plugin 都不替我們驗證「市場上沒有整合服務」。
- 該結論只能來自競品調研，必須列出調查範圍與日期。
- 找不到不等於不存在，報告要寫成「在調查範圍內未發現」。
- strategy-frameworks 的輸出要明確指定繁體中文與台灣用詞。
- 框架 skill 的輸出含表情符號與韓文標籤，進入正式文件前必須清掉。
- `/think` 不建議使用。
- 缺 TOC 與 TRIZ，路由結果可能指向不存在的 skill。
- management-consulting 要求不編造數字，與我們的目標一致。
- 財務與市場規模若無來源，一律寫成「待補」。
