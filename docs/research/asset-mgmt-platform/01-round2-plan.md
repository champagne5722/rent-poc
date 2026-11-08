# 第二輪計劃：依商業方向做市場調研，再寫 BRD、PRD 與 Roadmap

日期：2026-10-30
狀態：2026-10-30 完成。產出見第五節，簡報 https://claude.ai/artifact/1LsLZLvdW64wSBSF5xxua5
前一輪：[00-research-plan.md](00-research-plan.md)、[調研報告](reports/台灣不動產資產管理平台調研.md)
Skill 盤點：[skills-inventory.md](skills-inventory.md)、[skills-inventory-consulting.md](skills-inventory-consulting.md)

## 一、這一輪要回答的問題

第一輪的商業假設（包租代管業者的押金隔離）不是使用者的方向，作廢。這一輪照使用者的商業方向規劃與設計。設計前先做市場調研，看清市場與商業風險，結果進 BRD 的風險章與配套。

### 使用者的商業方向

| 編號 | 方向 | 調研要回答的風險問題 |
|---|---|---|
| D1 | 切入點：「資產管理＋買賣＋租賃」整合給屋主的服務，市場上還沒有 | 誰做到哪裡、為什麼沒人整合、整合的法規與牌照障礙是什麼 |
| D2 | 客群：屋主，高端客戶是最終目標 | 需求有多強、替代方案的成本、願付價格的依據、市場規模 |
| D3 | 三階段路線：Phase 1 租賃與電子合約；Phase 2 銷售與信託帳戶；Phase 3 全資產管理 | 每階段的法規、牌照、合作方前提與風險 |
| D4 | 經理人（寄售代管業者）是 Phase 1 的關鍵使用者，必須驗證證照與身分 | 證照制度、公開查驗管道、個資限制 |
| D5 | Phase 2 信託帳戶委託外部信託，經理人等直接向銀行查帳 | 現成的查帳服務、授權方式、信託帳戶要不要提前 |

調研結論寫成「風險等級與配套」，不寫成「方向成立與否」。

### 議題樹（MECE，依金字塔原理）

```
依使用者的方向規劃，商業風險在哪裡？
├─ 需求面：誰有「資產管理＋買賣＋租賃」整合的需求？多痛？現在怎麼解？   → R10
├─ 供給面：台灣與國外有沒有人做整合？做到哪裡？為什麼沒人做？           → R15
├─ 可行性
│   ├─ 法規與牌照：Phase 1 經理人證照 / Phase 2 信託查帳 / Phase 3 繼承移交  → R11、R12、R14
│   └─ 技術：競品的系統怎麼切模組？我們的差異在哪？                       → R13
└─ 經濟性：市場有多大？誰付錢？付多少？                                   → R10 的市場規模段
```

## 二、三階段路線（使用者定）

| 階段 | 範圍 | 要處理的事 |
|---|---|---|
| Phase 1 | 物件管理＋租賃（含電子合約） | 使用者身分：甲方、乙方、經理人。經理人有營業行為，必須驗證證照與身分 |
| Phase 2 | 物件銷售 | 此時才考慮信託帳戶，讓經理人等能查帳。待查證能否委託外部信託、外部能否查帳 |
| Phase 3 | 所有資產管理（不只不動產） | 協助高端客戶管理資產：繼承、移交等所有產權內容 |

「經理人」的正式名稱由 R11 決定。候選：租賃住宅管理人員、不動產經紀人、不動產經紀營業員、代管業者。

## 三、調研子題（Sonnet ×6，平行）

### R10：需求證據與市場規模

- 要查：多屋者人數（財政部房屋稅籍、內政部統計）、高資產族群人數與不動產占比、繼承登記件數、不動產糾紛類型；高端屋主或家族對「一站式管理」的需求報導、訪談、調查；目前替代方案（仲介、代管、代書、銀行信託、家族辦公室）各自的成本與斷點。
- 要回答：D2 的需求強度與付費依據；TAM、SAM、SOM 的假設數字與來源。

### R11：經理人的身分與證照

- 要查：租賃住宅管理人員的訓練與證照、不動產經紀人與營業員的考試與登記、地政士、公司登記與營業項目代碼、內政部業者查詢系統、證照線上查驗、個資法限制。
- 要回答：D4 的查驗管道與限制；經理人的正式名稱。

### R12：信託帳戶的外部查帳與委託方式

- 要查：銀行專戶查詢服務（台新建經專戶查詢等）、信託契約可否授權第三人查詢、信託業的對帳義務、建經怎麼讓買賣方查款項、委託外部信託的契約型態。
- 要回答：D5 的現成做法；信託帳戶在 Roadmap 的位置要不要提前。

### R13：競品商模與系統設計

- 對象：台灣 591、Bananas、JGB、僑馥、第一建經；國外 AppFolio、Buildium、Yardi、貝殼找房、PropertyGuru。
- 要產出：每家一張商業模式畫布（BMC 九格）與系統模組清單，供橫向對比。

### R14：Phase 3 全資產管理的市場與法規

- 要查：信託業的家族信託與遺囑信託、私人銀行傳承服務、家族辦公室、繼承登記與遺產稅流程、代書與律師的角色、證券與保險資產的管理限制。
- 要回答：D3 的 Phase 3 風險；哪些事平台能做、哪些要合作方或牌照。

### R15：整合服務的供給盤點

- 要查：信義、永慶、台灣房屋、中信房屋的全服務線（買賣、租賃、代管、信託、裝修）；信託銀行的不動產管理信託；國外 Yardi、MRI、RealPage 是否同時涵蓋買賣與租賃；日本東急、三井不動產リアルティ的資產管理服務；美國的 family office 不動產服務。
- 要回答：D1 的競爭空白在哪裡；沒人整合的原因是法規、牌照、還是需求不足；平台進入的障礙。

### 稽核與合成

- Opus 稽核員一位，稽核 R10 到 R15。重點：證據強度、數字口徑、法條條號。
- Sonnet 報告撰寫員一位，合成「第二輪調研報告」。第一章必須是五個方向的風險等級與配套表。

## 四、Skill 分工

| 工作項目 | Skill | 執行者 | 輸出 |
|---|---|---|---|
| 議題樹與風險拆解 | `pyramid-principle`（MECE、SCQ） | 主對話 | 本計劃第一節 |
| 調研流程 | `anthropic-skills:deep-research` | 主對話協調 | 筆記、稽核、報告 |
| 需求與市場分析 | `management-consulting:strategic-analysis`、`strategy-frameworks:porter`、`jtbd` | 主對話在報告之上套框架 | BRD 市場章 |
| 商業模式 | `strategy-frameworks:bmc` | 主對話 | BRD 商模章，九格畫布 |
| 競品橫向對比 | `product-management:competitive-brief` 加 R13 的 BMC | 主對話 | `competitive-brief.md` |
| 三階段路線與實施計畫 | `management-consulting:implementation-planning`、`strategy-frameworks:real-options`、`product-management:roadmap-update` | 主對話 | BRD 路線章，甘特圖資料 |
| 財務假設 | `management-consulting:financial-modeling`、`anthropic-skills:xlsx` | Opus | `financial-model.xlsx` |
| 風險與配套 | `operations:risk-assessment` | 主對話 | BRD 風險章 |
| BRD 撰寫 | `product-management:write-spec`、`management-consulting:writing-style`、`pyramid-principle` | 主對話 | `brd.md` v2 |
| PRD 撰寫 | `product-management:write-spec` | Opus | `prd.md` v2 |
| 系統架構 | `engineering:system-design`、`engineering:architecture` | Opus | `architecture.md` v2 |
| 服務流程 | `operations:process-doc`、`artifact-diagramming` | 主對話 | ELI5 與簡報用 |
| ELI5 三份 | `eli5`、`artifact-diagramming`、`dataviz` | 主對話 | 三個 artifact |
| 簡報結構 | `pyramid-principle:storyboard`、`management-consulting:proposal-development`、`client-deliverables` | 主對話定 storyboard | storyboard.md |
| 簡報組裝 | Artifact Slides 類型 | Opus 一位專責 | 提案簡報 |

呼叫格式：`strategy-frameworks:<skill>`（例如 `strategy-frameworks:bmc`）、`management-consulting:<skill>`（例如 `management-consulting:strategic-analysis`）。細節見 [skills-inventory-consulting.md](skills-inventory-consulting.md)。

使用這兩組 skill 的規則：

- 不用 `/think` 路由器。它一半指向沒安裝的框架，直接呼叫需要的框架。
- 框架 skill 的輸出有表情符號與韓文標籤。呼叫時指定全程繁體中文，進正式文件前清掉格式。
- 框架 skill 沒有網路查詢。先由調研筆記提供事實，再套框架評分。
- `management-consulting` 禁止編造數字與客戶經驗。缺資料標「待補」，與本案規則一致。
- `writing-style` 只當審稿檢查表。與全域 `ste100-zh-tw` 輸出風格衝突時，以輸出風格為準。
- 「市場上沒有整合服務」的結論只能來自 R15 的調研，寫成「在調查範圍內未發現」。

## 五、產出物

| 檔案 | 內容 |
|---|---|
| `research_notes/.../r10` 到 `r15` | 六份調研筆記 |
| `audit/audit-round2.md` | 稽核紀錄 |
| `reports/第二輪調研報告.md` | 第一章是五個方向的風險等級與配套表 |
| `brd.md` v2 | SCQ 導入、市場調研結論、BMC、五力、三階段路線、風險與配套、財務假設摘要 |
| `prd.md` v2 | Phase 1：物件管理、租賃、電子合約、三種身分與經理人驗證 |
| `architecture.md` v2 | 模組邊界圖、三階段演進的系統範圍、Phase 2 信託查帳介面 |
| `competitive-brief.md` | 商模矩陣加系統模組矩陣 |
| `financial-model.xlsx` | 單位經濟、三階段收入假設、TAM/SAM/SOM |
| `storyboard.md` | 簡報每頁的行動標題與視覺 |
| 提案簡報（Artifact Slides） | 標題：商業需求說明、市場驗證、競品橫向對比、服務流程、產品路線、系統架構、風險配套、財務假設、下一步 |
| `eli5-business-model.html` v2 | 服務模組圖、三階段甘特圖、BMC 圖解 |
| `eli5-architecture.html` v2 | 系統模組與邊界、資料流、三階段系統範圍甘特圖 |
| `eli5-competitors.html` | 十家競品的商模與系統模組橫向對比 |

## 六、執行順序

1. 使用者確認本計劃。
2. 平行派出 R10 到 R15。
3. Opus 稽核，必要時補一輪。
4. 報告撰寫員合成第二輪報告，主對話確認五個方向的風險等級。
5. 主對話套框架：SCQ、BMC、五力、real options，寫 BRD v2 與競品對比。Opus 平行做財務模型。
6. Opus 平行改 PRD v2 與架構 v2。
7. 主對話寫 storyboard，Opus 組裝簡報。
8. 主對話做三份 ELI5。
9. 回報。

調研若發現某階段有法規上的硬障礙，BRD 照方向規劃，並在該階段寫明障礙與配套，由使用者決定取捨。
