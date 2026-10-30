# 顧問級提案：skill 與 plugin 盤點

盤點日期：2026-10-30。範圍：已啟用的 skill 與 plugin，加上 catalog 可安裝的項目。本檔只盤點，沒有安裝任何東西，也沒有開始做提案。

## 結論

直接可用：簡報（`anthropic-skills:pptx`）、競品對比（`product-management:competitive-brief`）、風險（`operations:risk-assessment`）、服務流程（`operations:process-doc`）、系統架構（`engineering:system-design`、`engineering:architecture`）、財務假設表（`anthropic-skills:xlsx`）、研究（`anthropic-skills:deep-research`）、資料視覺化（`dataviz`、`data:create-viz`）、圖解（`artifact-diagramming`、`eli5`）。

缺口，要自己補：

1. 甘特圖：沒有專用 skill。用 pptx 的原生堆疊橫條圖（隱形第一個系列當起點偏移）畫，或用 `artifact-diagramming` 加 inline SVG 畫，再貼進投影片。`product-management:roadmap-update` 只產 Now/Next/Later 與表格，不產圖。
2. 顧問簡報結構（金字塔原理、SCQA、行動標題）：已啟用的 skill 裡沒有。`anthropic-skills:pptx` 只有一段「一頁一個訊息、金字塔結構」的原則。要完整框架，需安裝 `strategy-frameworks`（含 `pyramid-principle`）。
3. 市場規模（TAM/SAM/SOM）：沒有已啟用的 skill。用 `deep-research` 找來源，在 `xlsx` 自己建 top-down 與 bottom-up 兩種算法交叉驗證。
4. MECE 議題樹、假設樹：沒有已啟用的 skill。可安裝 `strategy consultant`（含 `hypothesis-tree`、`problem-definition`），或由主對話手寫。
5. C4 模型專用 skill：沒有。用 `engineering:system-design` 定內容，`artifact-diagramming` 畫 SVG。

兩個已知限制：

- `dataviz` 出現在 skill 清單，但本機找不到它的 SKILL.md 檔，下表的描述只來自清單上的說明文字。使用前要用 Skill tool 載入才能確認內容。
- `anthropic-skills:pptx` 自己規定：使用者沒有明說要 .pptx 檔、且 session 提供投影片 Artifact 類型時，要改用 Artifact 的 slides 類型。主對話必須先確認使用者要 .pptx 還是 Artifact 簡報。

## 表一：已啟用的 skill

| 名稱 | 類別 | 用途 | 輸出格式 | 備註 |
|---|---|---|---|---|
| `anthropic-skills:pptx` | 簡報 | 用 pptxgenjs 建立、編輯、讀取 .pptx | .pptx | 原生圖表，內建 `validate.py` 與轉圖 QA。沒有固定設計系統，見下節 |
| `dataviz` | 資料視覺化 | 任何圖表的配色、標記、圖例、軸線規範 | 圖表程式碼、SVG、HTML | 本機無 SKILL.md，只知清單說明。有色彩驗證器與預設色盤 |
| `data:create-viz` | 資料視覺化 | 用 Python 從資料產出圖表 | PNG 或互動圖 | 附帶 `data:data-visualization` 的選圖準則（背景型 skill，不可直接叫用） |
| `data:build-dashboard` | 資料視覺化 | 做儀表板 | HTML | 提案用不到，除非要附 demo |
| `product-management:competitive-brief` | 競品 | 競品分析：概覽、功能矩陣、定位、強弱項、機會與威脅、策略含意 | Markdown | 流程會先問使用者範圍。內含評分量表與矩陣範本。可接著產 battlecard |
| `sales:competitive-intelligence` | 競品 | 交戰型競品話術與 battlecard | 文件 | 偏銷售，綁 CRM 與逐字稿。本案只在要做 battlecard 時用 |
| `product-management:roadmap-update` | 時程 | 建立或調整產品 roadmap，Now/Next/Later 或季度欄 | Markdown 表格 | 沒有圖。內含 RICE、MoSCoW、ICE。要先問使用者要什麼格式 |
| `product-management:write-spec` | 需求 | 把想法寫成 PRD，含目標、非目標、成功指標 | Markdown | 倉庫已有 `brd.md`、`prd.md`，建議直接引用，不重寫 |
| `product-management:brainstorm` / `product-brainstorming` | 發想 | 發想與挑戰假設 | 對話 | 可用在商業需求說明前的壓力測試 |
| `product-management:synthesize-research` | 研究 | 把訪談、問卷、回饋整理成主題與優先序 | Markdown | 市場驗證若有訪談資料才用 |
| `anthropic-skills:deep-research` | 研究 | 多來源研究，派子 agent 平行查，產出敘事報告 | 報告檔 | 必須有 Agent 工具。適合市場驗證與競品蒐證 |
| `engineering:system-design` | 架構 | 需求、高階設計、資料模型、規模、取捨 | Markdown，圖為 ASCII 或文字描述 | 沒有 C4 範本，圖要另外畫 |
| `engineering:architecture` | 架構 | 撰寫或評估 ADR，列選項與取捨 | Markdown（ADR 格式） | 用在「為何選這個技術」的章節 |
| `mattpocock-skills:codebase-design` / `domain-modeling` | 架構 | 程式碼層設計與領域詞彙 | 文件 | 與提案關聯低，只在對齊 `GLOSSARY.md` 時用 |
| `operations:risk-assessment` | 風險 | 風險登錄表，3x3 可能性乘影響矩陣，含緩解與負責人 | Markdown 表格 | 六類風險：營運、財務、合規、策略、聲譽、資安 |
| `operations:process-doc` | 流程 | SOP、RACI、流程圖 | Markdown，流程圖為 ASCII | 用在服務流程章節。要視覺化需另畫 |
| `operations:status-report` / `capacity-plan` | 營運 | 狀態報告、人力容量 | Markdown | `capacity-plan` 可支援人力與時程假設 |
| `sales:close-plan` | 商業案例 | 為什麼買、為什麼現在、ROI 框架、成交行動計畫 | 文件 | 綁 CRM 與逐字稿，且寫法偏賣方。只借其 ROI 框架，不建議直接叫用 |
| `anthropic-skills:xlsx` | 財務 | 建立與編輯試算表，含公式 | .xlsx | 財務假設與敏感度表用它 |
| `data:statistical-analysis` / `analyze` | 分析 | 統計與資料分析 | 對話、圖 | 敏感度分析與情境用 |
| `artifact-diagramming` | 圖解 | 判斷何時畫圖、怎麼畫出真實機制、inline SVG 技巧 | HTML 內的 SVG | 適合甘特圖、模組圖、流程圖。明暗主題都可讀 |
| `artifact-design` | 版面 | Artifact 頁面的設計準則 | HTML | 寫任何 Artifact 前必須先載入 |
| `eli5` | 圖解 | 給外行人的大圖少字說明 | HTML Artifact | 倉庫已有 `eli5-architecture.html`、`eli5-business-model.html` |
| `anthropic-skills:docx` / `pdf` / `docs` | 文件 | 提案書本文、PDF 匯出 | .docx、.pdf、Docs | 簡報之外若要附說明書使用 |
| `superpowers:writing-plans` | 計畫 | 把規格拆成執行步驟 | Markdown | 主對話規劃分工時可用 |
| `i-have-adhd-zh-tw:i-have-adhd-zh-tw` | 文字風格 | 全域規定的台灣繁中風格 | 無 | 所有產出必須遵守 |

已啟用的 plugin：`operations`、`design`、`engineering`、`sales`、`product-management`、`data`、`cowork-plugin-management`、`productivity`（共 8 個）。

## 表二：可安裝的 plugin（目前未啟用）

安裝需要使用者同意，本次沒有安裝。

| id | 名稱與來源 | 用途 | 是否建議安裝 |
|---|---|---|---|
| `plugin_01DbJH8cEvSwCMLPD1xNkgyp` | management-consulting（社群） | 16 個 skill：`proposal-development`、`strategic-analysis`、`financial-modeling`、`implementation-planning`、`client-deliverables`、`writing-style` 等 | 建議。最貼近「顧問提案」，且 reach 為 contained，不接外部服務 |
| `plugin_01DZ2Ap4TCRsT3WeTGtLaMmp` | strategy-frameworks（社群） | 47 個框架，含 `pyramid-principle`、`porter`、`swot-pestel`、`blue-ocean`、`bmc`、`wardley`、`scenario-planning`；`/think` 自動選框架 | 建議。補金字塔原理與市場分析框架的缺口，contained |
| `plugin_01SheLJ9aF6dn6rodJtpAg6L` | strategy consultant（社群） | `problem-definition`、`hypothesis-tree`、`research`、`sense-check`、`synthesis`、`client-report`，另有多個驗證用 agent | 可選。補 MECE 議題樹與查核流程；reach 為 remote，且帶 google-drive、ms365 連線，沒有需要就不裝 |
| `plugin_0168VBwhXxc3CsNcYb44A6Pd` | pitch-agent（Anthropic FSI） | 3-statement、DCF、comps、`pitch-deck`、`pptx-author` | 可選。財務建模較重，偏投資銀行。若提案要附 DCF 或情境財模再裝 |
| `plugin_013ewyEoijt5SqZ8zCGjD8m3` | market-researcher（Anthropic FSI） | `competitive-analysis`、`sector-overview`、`comps-analysis`、`pptx-author` | 可選。產業概觀可用，但偏上市公司同業比較，與租賃市場契合度低 |
| `plugin_01KLzYDymQoiJBfYsgLdHtq6` | Agentic user research at scale / Evermuse（社群） | 含 `market-sizing`、`competitor-analysis`、`competitive-battlecard`、`business-model`、`pricing-strategy`、`gtm-strategy` | 暫不建議。需要 Evermuse MCP 與帳號，reach 為 remote。市場規模改用 `deep-research` 加 `xlsx` 自建 |
| `plugin_016kUiDJgJUupDHAoMugQ8SR` | Competitive Intel（社群） | 競品深度報告、battlecard、一頁 PDF | 暫不建議。偏業務現場使用，`competitive-brief` 已夠用 |
| `plugin_01478VTScUUrebCnFQYJj9Nc` | Competitive Skills by LMTY（社群） | 16 個競爭型 skill，含 `competitive-executive-market-brief` | 暫不建議。要接 LMTY MCP 才完整 |
| `plugin_018xWMECrWMnHDCmgVxqAGWH` | Pitch Deck Advisor（社群） | 新創募資簡報檢視 | 不建議。本案是客戶提案，不是募資 |
| `plugin_015PFsSfe2ja6kaJ4WYqpYjN` / `plugin_01MR2Dk4uQ5BxDXN7nLYCvkp` | roadmapsmith / Work Unit Roadmap | 程式碼倉庫內的 ROADMAP.md 與開發階段流程 | 不建議。名稱像 roadmap，但用途是開發流程，不產出提案用的甘特圖 |

甘特圖與 C4 圖在 catalog 中查無對應 plugin（以 timeline、C4、gantt 等關鍵字搜尋）。另有 Figma MCP 的 `generate_diagram`（FigJam 圖）可畫流程圖與架構圖，但需要 Figma 授權與檔案，本次沒有驗證可用性。

## pptx skill 工作流摘要

1. 先決定格式：使用者要 .pptx 就用此 skill；沒指定格式又有投影片 Artifact 類型時，改走 Artifact 的 slides 類型。
2. 新簡報預設做成「結構化簡報」：先定義 `THEME`（名稱、標題與內文字型、dk1/lt1/dk2/lt2/accent1-6 色票）。
3. 用 `defineSlideMaster()` 建每種版型（封面、章節分隔、僅標題、圖表加說明、表格），頁尾、logo、頁碼放版型內。
4. 顏色一律用 `pres.SchemeColor`，內容用 `placeholder` 名稱填入，章節用 `addSection` 加 `sectionTitle`。
5. 預設畫布是 10 x 5.625 吋，要寬螢幕必須先設 `pres.layout`。
6. 圖表一律用 `addChart()` 原生圖表，並設標題、資料標籤與色票。堆疊圖的資料標籤位置只能用 `ctr`、`inEnd`、`inBase`，用 `outEnd` 會損毀檔案。只有 Sankey、網路圖這類 PowerPoint 沒有的圖才用圖片。
7. 甘特圖沒有專用功能，用堆疊橫條圖加透明起點系列，或用矩形與文字方塊手排。
8. `pres.writeFile()` 寫檔後，必須執行 `applyTheme()` 把色票寫進佈景主題。輸出路徑由腳本決定，預設在目前工作目錄；本案建議寫到 `docs/research/asset-mgmt-platform/` 底下。
9. 必做三道 QA：`slide_text.py` 查內容與殘留的 lorem/TODO，`validate.py` 查檔案結構，轉 PDF 再轉 JPG 逐頁看圖（查文字溢出、重疊、對齊）。
10. 字型建議用 Arial、Calibri、Cambria 這類安全字型；繁中字型不在其清單，容器要多留約 10% 空間，且 QA 預覽不可盡信。

沒有固定設計系統。skill 要求色票貼合主題、一色主導（60 到 70%）、每頁有圖表或圖形、避免純文字頁與色條裝飾。倉庫的 commit 紀錄提到 `DESIGN.md`，色票可參考它，但本次沒有驗證檔案內容。

## 提案章節對應

| 章節 | 主要 skill | 輔助 | 缺口與做法 |
|---|---|---|---|
| 商業需求說明 | `product-management:write-spec`、`product-brainstorming` | 引用既有 `brd.md`、`prd.md`；`mattpocock-skills:grilling` 做壓力測試 | 無缺口。顧問式敘事（SCQA）需自己寫，或裝 `strategy-frameworks` |
| 市場驗證 | `anthropic-skills:deep-research` | `synthesize-research`（有訪談時）；`xlsx` 建 TAM/SAM/SOM | 沒有 market sizing skill，自建兩種算法交叉驗證，來源要標註 |
| 競品對比 | `product-management:competitive-brief` | `deep-research` 蒐證；`dataviz` 畫定位圖 | 無缺口。功能矩陣用 skill 內建的評分量表 |
| 服務流程 | `operations:process-doc`（RACI 與步驟） | `artifact-diagramming` 畫泳道圖；`eli5` 給非技術讀者 | 流程圖要自己畫成 SVG 再貼進簡報 |
| 產品路線甘特圖 | `product-management:roadmap-update`（內容與優先序） | `dataviz` 加 pptx 原生堆疊橫條圖；或 `artifact-diagramming` 的 SVG | 缺專用 skill，見結論第 1 點。可用 `capacity-plan` 檢查工時是否可行 |
| 系統架構 | `engineering:system-design`（內容）、`engineering:architecture`（ADR） | `artifact-diagramming` 畫分層圖；既有 `architecture.md`、`eli5-architecture.html` | 缺 C4 skill，用 SVG 自繪，建議畫 Context 與 Container 兩層 |
| 風險配套 | `operations:risk-assessment` | `dataviz` 畫風險熱力圖 | 無缺口。輸出表格後轉成投影片 |
| 財務假設 | `anthropic-skills:xlsx`（假設表、情境、敏感度） | `data:statistical-analysis`；`dataviz` 畫圖 | 沒有財模 skill。要 DCF 或 3-statement 可裝 `pitch-agent`，或 `management-consulting` 的 `financial-modeling` |
| 整份簡報組裝 | `anthropic-skills:pptx` | `dataviz` 管圖表風格；`docx` 或 `pdf` 出附件 | 簡報前須確認 .pptx 或 Artifact 簡報 |

建議分工順序：先用 `deep-research` 與 `competitive-brief` 蒐證（可平行），再做財務假設與風險，最後一次組裝簡報並做 QA。簡報組裝必須只由一個 agent 負責，避免風格不一致。
