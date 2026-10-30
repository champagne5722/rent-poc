# 系統架構：台灣不動產資產管理平台

版本：v2，2026-10-30
狀態：提案草稿，待使用者審閱
依據：[BRD v2](brd.md)、[第二輪調研報告](reports/第二輪調研報告.md)、[第一輪調研報告](reports/台灣不動產資產管理平台調研.md)、`docs/adr/` 的 ADR-0001 至 ADR-0009、`docs/domain-model.md`、`GLOSSARY.md`、`src/lib/` 現有介面
取代：v1（2026-10-29），存檔為 [architecture-v1-archived.md](architecture-v1-archived.md)。v1 的商業假設已隨 BRD v1 作廢。
用詞：義務用「必須」，禁止用「不得」，許可用「得」，建議用「建議」並附條件。數字後的【高】【中】【低】沿用報告的信心標示。

平台做資料與協作層。平台不持有資金、不居間、不代管。執行交給持照者：代管業、經紀業、地政士、銀行、建經。本文件寫三件事：系統現況、三階段各加什麼、模組邊界在哪。

> **注意：** 專案使用 Next.js 16.2.11。`AGENTS.md` 警告此版本的 API、慣例與檔案結構和一般認知不同。本文件提到 Next.js 的每一處，動工前先讀 `node_modules/next/dist/docs/`，並留意 deprecation 提示。

## 0. 用詞

術語以 `GLOSSARY.md` 定義欄與 BRD 第 13 節為準。下表列本文件的固定用法。

| 詞 | 識別字 | 本文件的用法 |
|---|---|---|
| 房東 | `landlord` | 出租人。BRD 的「屋主」在系統內一律稱房東，因為 `GLOSSARY.md` 把屋主列在 _Avoid_ |
| 租客 | `tenant` | 承租人。`tenant` 只表示租客，不表示多租戶 |
| 組織 | `org` | 資料隔離單位。「多租戶」只當架構名稱 |
| 經理人 | `manager` | 角色統稱。UI 顯示法定稱謂：租賃住宅代管業者、包租業者、不動產經紀業者 |
| 執業主體 | `practice_entity` | 持有許可或登記的公司或商號，是合約當事人 |
| 執業人員 | `practitioner` | 持有證書的自然人，是簽章人 |
| 產權錨點 | `property_anchor` | 縣市＋鄉鎮市區＋段小段＋建號（含分號）的唯一鍵 |
| 租賃單位 | `rental_unit` | 掛在錨點下的可出租單位，後綴 `0000` 代表整戶 |
| 物件 | `property` | 組織視角的租賃單位，存營運資料 |
| 出租權源 | `leasing_authority` | 出租人出租該單位的依據 |
| 案件 | `case` | 跨方流程的實例：一筆租賃、一筆買賣、一件繼承 |
| 簽署任務 | `sign_task` | 點點簽側的簽署流程。它與案件是兩個實體 |
| 信託案件識別碼 | `trust_case_ref` | 外部銀行或建經給的案件編號。平台只存識別碼與狀態 |
| 入帳確認 | `deposit_confirmation` | 平台收到的「款項已入帳」事件 |
| 撥款指示 | `disbursement_instruction` | 雙方電子簽署、交建經或銀行執行的付款指令 |
| 鏡像帳 | `mirror_ledger` | 平台記錄的款項分錄副本，真相在銀行 |
| 移交包 | `handover_package` | 經理人更換時，每個租賃單位的六類資料集合 |
| 資產清冊 | `asset_inventory` | Phase 3 的全資產列表，標示來源與取得日期 |

法定文件名照原文寫，例如「委託管理契約書」「租賃契約書」。系統內的實體仍叫合約。

## 1. 需求摘要

### 1.1 系統現況

系統目前是單一 Next.js 專案。它能讓房東建立物件與租賃合約，再用點點簽完成雙方電子簽約。

| 面向 | 現況 | 位置 |
|---|---|---|
| 框架 | Next.js 16.2.11 全端，前端 React 加官方 antd | ADR-0001、ADR-0002 |
| 資料庫 | SQLite 單檔，`better-sqlite3` 同步呼叫 | `src/lib/db.ts` |
| 資料表 | `properties`、`contracts`、`contract_events`、`contract_files`、`equipment_vocabulary` | `ensureSchema()` |
| 合約狀態機 | 六態，純函式 `decideTransition()` 加同交易 `commitTransition()` | `src/lib/transitions.ts`、ADR-0006 |
| 合約文件 | 主約、補充合約、設備附件三層組裝 | ADR-0008、`src/lib/pdf.ts` |
| 範本與條款 | 平台提供並版本化，建約時快照 | ADR-0005、`src/lib/clause-library.ts` |
| 電子簽署 | 點點簽 Client Credentials，email 簽署，租客先簽、房東後簽 | ADR-0003、`src/lib/dottedsign.ts` |
| 簽署區域 | 房東在 PDF 預覽拖放簽名框 | ADR-0004、`src/lib/signature-layout.ts` |
| 已簽檔案 | 完成時保存已簽 PDF 與 Audit Trail File 到 `data/contract-files/` | ADR-0007、`src/lib/contract-files.ts` |
| 設計系統 | `DESIGN.md` runtime 直讀驅動 antd theme | ADR-0009 |
| 帳號與隔離 | 沒有登入，沒有組織 | `docs/known-simplifications.md` |

`SignerRole` 只有 `landlord` 與 `tenant` 兩種。簽署人固定兩位。這是簽章分流要改的地方，見 4.10。

### 1.2 三階段功能範圍

三階段的月份與關卡依 BRD 第 9 節。月份是相對月。每階段有關卡，證據沒到就不進下一階段。

**Phase 1（M1 至 M9）：物件管理與租賃。關卡 G1 在第 9 月。**

| 編號 | 功能 | 模組 |
|---|---|---|
| P1-01 | 經理人開通：登錄執業主體，商工 API 查公司，人工核對許可與登記證 | 經理人驗證 |
| P1-02 | 執業人員登錄：resim 人工核對證書與任職，專任衝突分流，標章「證書資料已核對」 | 經理人驗證 |
| P1-03 | 證照效期：換證提醒、逾期失效、失效停權 | 經理人驗證 |
| P1-04 | 物件登錄：產權錨點、租賃單位、重複登錄偵測 | 物件與單位 |
| P1-05 | 出租權源：謄本或授權書、權源鏈條、租客端權源標示 | 物件與單位 |
| P1-06 | 組織、帳號、三種身分、資料隔離 | 身分與組織 |
| P1-07 | 委託管理合約（代管），由專任管理人員簽章 | 合約與簽章 |
| P1-08 | 租賃合約：三層文件、點點簽、撤回後衍生、依代管或包租分流簽章 | 合約與簽章 |
| P1-09 | 租賃案件：從擬約到押金結算的流程、待辦、修繕工單紀錄 | 案件 orchestrator |
| P1-10 | 入帳確認：人工上傳匯款證明，人工審核 | 帳務 |
| P1-11 | 鏡像帳、押金台帳、逾期提醒 | 帳務 |
| P1-12 | 退租點交與押金結算：設備附件比對、結算單雙簽、退還證明簽章 | 案件 orchestrator、帳務 |
| P1-13 | 房東報表與資產總覽 v1 | 報表與資產總覽 |
| P1-14 | 移交包：經理人更換時逐案確認 | 物件與單位 |
| P1-15 | 租客端：合約、押金狀態、點交紀錄、出租權源標示 | 身分與組織、報表 |
| P1-16 | 稽核紀錄與電子簽章告知同意紀錄 | 稽核 |

**Phase 2（M9 至 M21）：物件銷售與信託帳戶。關卡 G2 在第 21 月。**

| 編號 | 功能 | 前提 |
|---|---|---|
| P2-01 | 買賣案件七段流程：簽約前、簽約後、用印、完稅、過戶、點交、結案，每段文件待辦 | G1 放行 |
| P2-02 | 信託狀態轉接層：接收建經或銀行的入帳狀態 | 建經特約 |
| P2-03 | 查帳連結：導向銀行或建經頁面，由買賣方本人驗證 | 建經特約 |
| P2-04 | 撥款指示：買賣方電子簽署，交建經執行 | 建經特約 |
| P2-05 | 經紀業合作：經紀人簽章（經紀條例 §22），銷售委託 | 經紀業合作契約 |
| P2-06 | 自有房源上架與物件驗證標章 | 灰區一函詢結果 |

**Phase 3（M21 至 M36）：全資產管理。關卡 G3 在第 36 月。**

| 編號 | 功能 | 前提 |
|---|---|---|
| P3-01 | 全資產清冊：使用者上傳對帳單、存摺截圖、謄本，平台解析後人工確認 | G2 放行 |
| P3-02 | 期限提醒：遺產稅申報與繼承登記分開計算，另含保單續期與租約 | G2 放行 |
| P3-03 | 文件保管：遺囑影本、信託契約、權狀、醫療與監護文件 | 特種個資分區完成 |
| P3-04 | 繼承流程協調與持照者轉介 | 信託銀行、會計師、地政士合作簽訂 |

Phase 3 的畫面只呈現中性事實：到期日、持有比例、文件缺漏。系統不產生投資、保險或信託建議（第二輪報告 8.7）。

### 1.3 非功能需求

**隔離。** 一個組織的使用者不得讀寫另一個組織的資料。隔離由資料庫強制執行，應用程式碼的錯誤繞不過去。BRD 風險 R14 要求 RLS 加 FORCE 與跨組織滲透測試。CI 必須每次執行滲透測試。

**跨組織唯一。** 產權錨點與執業人員證書必須跨組織唯一。專任衝突要跨組織偵測。偵測結果不得透露另一個組織的名稱或資料。

**稽核。** 下列動作必須留下稽核紀錄：金流、權限變更、撥款指示、敏感文件讀取。經理人驗證決定與簽章分流決定也要記。紀錄只增不改，並能證明事後沒被竄改。簽署本身的舉證由點點簽 Audit Trail File 承擔（ADR-0007）。

**特種個資分區。** 醫療與監護文件屬特種個資，須書面同意（第二輪報告 8.3）。這類文件必須放在獨立分區：獨立金鑰、獨立存取角色、每次讀取都記稽核。證件影像與證書影本也放在同一分區，驗證完成後刪除或遮罩。

**資料保護。** 個資安全維護義務現行依個資法 112 年版 §27①【高】。違反安全維護義務處 2 萬至 200 萬元【高】。情節重大處 15 萬至 1,500 萬元【高】（第二輪報告 6.5）。114-11-11 修正的 §20-1 施行日未定，設計上預留【高】。電子簽章法 §5 要求取得相對人同意，平台必須保存同意紀錄【高】。身分證字號與完整謄本用欄位層加密，對外顯示做隱匿。

**可用性。** 報告沒有可用性目標。本文件先假設月可用率 99.5%，RPO 5 分鐘，RTO 4 小時。這三個數字是假設，必須與 pilot 客戶確認。

**量級估算。** 量級依 BRD 第 11 節的關卡目標推估。

| 量 | G1（M9） | G3（M36） | 推導 |
|---|---|---|---|
| 租賃單位 | 300 | 8,000 | BRD 第 11 節 |
| 活躍租賃案件 | 約 270 | 約 7,200 | 假設出租率 90% |
| 鏡像帳分錄 | 每月約 600 筆 | 每月約 16,000 筆 | 每案件每月 2 筆，押金與結算另計 |
| 買賣案件 | 0 | 累計 200 件 | BRD 第 11 節 |
| 執業人員 | 約 15 位 | 約 150 位 | 假設每家經理人 5 位，30 家 |
| 稽核事件 | 每日約 500 筆 | 每日約 10,000 筆 | 假設每案件每日 1 筆加讀取紀錄 |
| 文件版本 | 約 3,000 份 | 約 60,000 份 | 謄本、授權書、合約、點交照片、清冊上傳 |

每日分錄在萬級以下，PostgreSQL 加約束通常足夠【中】（第一輪報告第 9 章）。

### 1.4 限制

| 限制 | 內容 | 影響 |
|---|---|---|
| 團隊規模未知 | BRD 沒有寫開發團隊人數 | 不拆微服務。維持單一 repo、單一部署單元，加一個背景 worker |
| 不持有款項 | 信託業法 §33、電支條例、洗錢防制法 §6【高】 | 程式碼沒有轉帳或撥款的路徑，只有記錄與指示 |
| 對外不使用「信託」名稱 | 信託業法 §9②【高】 | 產品名、方案名、UI 標題不得含「信託」。只能描述銀行的信託專戶 |
| 不爬謄本 | 電子謄本系統協議禁止自動化擷取【中】 | 謄本一律由使用者上傳，平台只驗證與歸檔 |
| 不繞過 resim 驗證碼 | resim 查詢頁附圖形驗證碼，自動化須向內政部地政司申請（第二輪報告 6.2） | 證書核對由平台審核員人工執行，見 ADR-0015 |
| 商工 API 有管制 | 須填使用告知書、登記來源 IP 白名單，並有連線與次數管制【高】 | worker 走固定出口 IP，查詢排隊並快取結果 |
| 代操作屬代管 | 代房東收租、保管押金、派工、協調糾紛屬代管業務 | 「代房東操作」類動作只對已驗證的代管業執業主體開放 |
| 銀行規格未知 | 企業信託專戶入帳通知 API 未查到（第二輪報告 7.4） | 入帳確認與信託狀態必須做成可替換的轉接層 |
| 第三人查帳沒有法源 | 查詢者只有買賣方本人，沒有經理人或平台的角色【高】 | 查帳連結導向銀行或建經頁面，平台不代查 |
| Phase 3 不產生建議 | 投顧與保險推介須持照【高】 | 清冊與提醒只顯示中性事實 |

### 1.5 假設

1. 第一個付費客群是經理人與多屋房東，兩者同時測試（BRD D2）。
2. 雲端選在台灣有機房的供應商。金融合作方的境內存放要求在 Phase 2 前再查。
3. 點點簽繼續當電子簽署服務商。
4. 每個租賃單位同一時間只有一個管理它的組織。
5. 平台審核員是平台營運方的員工，屬平台組織，不屬任何客戶組織。

## 2. 模組地圖

### 2.1 模組總圖

方括號是模組出現的階段。`[P1-P3]` 表示 Phase 1 建立，後兩階段加範圍。

```
                              房東、經理人、租客、買賣方 [P2]、高端客戶 [P3]、平台審核員
                                                      │ HTTPS
┌─ 呈現層：Next.js 頁面、route handlers、webhook 接收端 ───────────────────────────────────────────────────┐
│ 房東後台、經理人後台、租客端、買賣方端 [P2]、高端客戶端 [P3]、平台審核台                                 │
│ route handler 只呼叫模組的對外介面。webhook 只驗簽、寫 inbox、回 200                                     │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                      ▼
┌─ 領域模組 ───────────────────────────────────────────────────────────────────────────────────────────────┐
│ ┌─ M01 身分與組織 [P1] ──────────┐ ┌─ M02 經理人驗證 [P1] ──────────┐ ┌─ M03 物件與單位 [P1] ──────────┐ │
│ │ 擁有 orgs、users、parties      │ │ 擁有 practice_entities         │ │ 擁有 property_anchors          │ │
│ │      org_memberships           │ │      practitioners             │ │      rental_units、properties  │ │
│ │ 介面 withTx、authorize         │ │      practitioner_employments  │ │      leasing_authorities       │ │
│ │      requireIdentityLevel      │ │      credential_checks         │ │      handover_packages         │ │
│ │ 邊界 誰是誰、能做什麼          │ │ 介面 credentialStatusAt        │ │ 介面 registerUnit              │ │
│ │                                │ │      eligibleSigners           │ │      primaryAuthorityAt        │ │
│ │                                │ │ 邊界 證照真假、效期、專任      │ │ 邊界 哪一間、誰有權出租        │ │
│ └────────────────────────────────┘ └────────────────────────────────┘ └────────────────────────────────┘ │
│ ┌─ M04 合約與簽章 [P1] ──────────┐ ┌─ M05 案件 orchestrator [P1-P3] ┐ ┌─ M06 帳務 [P1] ────────────────┐ │
│ │ 擁有 contracts                 │ │ 擁有 cases、case_events        │ │ 擁有 ledger_*、deposit_ledgers │ │
│ │      contract_events           │ │      case_members、work_orders │ │      deposit_confirmations     │ │
│ │      management_contracts      │ │ 介面 decideCaseTransition      │ │      disbursement_instructions │ │
│ │      signature_records         │ │      dispatch                  │ │      trust_case_refs [P2]      │ │
│ │      signature_rules           │ │ 範圍 P1 租賃、P2 買賣          │ │ 介面 ingest、postJournal       │ │
│ │ 介面 routeSignatures           │ │      P3 繼承協調               │ │      balance、fundStatus       │ │
│ │      sendForSigning            │ │ 邊界 流程到哪、在等誰          │ │ 邊界 記錢的狀態，不碰錢        │ │
│ │ 邊界 文件內容、誰簽章          │ │                                │ │                                │ │
│ └────────────────────────────────┘ └────────────────────────────────┘ └────────────────────────────────┘ │
│ ┌─ M07 文件庫 [P1，P3 擴分區] ───┐ ┌─ M08 通知與待辦 [P1] ──────────┐ ┌─ M09 報表與資產總覽 [P1、P3] ──┐ │
│ │ 擁有 documents                 │ │ 擁有 notifications、todos      │ │ 擁有 asset_inventories [P3]    │ │
│ │      document_versions         │ │      reminders                 │ │      asset_items [P3]          │ │
│ │      vault.*                   │ │ 介面 notify、listTodos         │ │      asset_deadlines [P3]      │ │
│ │ 介面 addVersion、isFresh       │ │      scheduleReminder          │ │ 介面 ownerReport [P1]          │ │
│ │      readOriginal              │ │ 邊界 提醒誰、何時提醒          │ │      inventoryView [P3]        │ │
│ │ 邊界 檔案、版本、新鮮度        │ │                                │ │ 邊界 只讀彙整，不給建議        │ │
│ └────────────────────────────────┘ └────────────────────────────────┘ └────────────────────────────────┘ │
│ ┌─ M10 外部整合 [P1-P3] ─────────┐ ┌─ M11 稽核 [P1] ────────────────┐                                    │
│ │ 點點簽 [P1]                    │ │ 擁有 audit.events              │                                    │
│ │ 商工 API [P1]                  │ │      audit.anchors             │                                    │
│ │ resim 人工流程 [P1]            │ │ 介面 appendAudit               │                                    │
│ │ 行動自然人憑證 [P1 申請]       │ │      verifyChain               │                                    │
│ │ 建經與銀行狀態 [P2]            │ │ 邊界 只增不改，可驗證          │                                    │
│ │ 上傳解析 [P3]                  │ │                                │                                    │
│ │ 邊界 只有 adapter              │ │                                │                                    │
│ └────────────────────────────────┘ └────────────────────────────────┘                                    │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                      ▼
┌─ 共用基礎 ───────────────────────────────────────────────────────────────────────────────────────────────┐
│ 資料存取層：withTx()、交易範圍的 app.org_id、repository 介面                                             │
│ inbox 與 outbox：外部訊息先進 inbox，對外呼叫一律走 outbox                                               │
│ 背景 worker：派送、對帳、效期掃描、錨定、解析                                                            │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                      ▼
┌─ 儲存 ───────────────────────────────────────────────────────────────────────────────────────────────────┐
│ PostgreSQL：tenant schema（RLS）、registry、audit、vault（P3 加特種個資）                                │
│ 物件儲存：謄本、PDF、照片，伺服器端加密、版本化。vault 檔案用獨立金鑰                                    │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 模組邊界

每個模組只寫自己擁有的表。讀別的模組的資料，一律呼叫對方的對外介面。

| 模組 | 階段 | 負責 | 不負責 | 現有檔案 |
|---|---|---|---|---|
| M01 身分與組織 | P1 | 組織、帳號、參與方、組織內角色、驗證等級、`authorize()` | 證照真假。那屬 M02 | 無 |
| M02 經理人驗證 | P1 | 執業主體、執業人員、任職、證照狀態機、專任衝突分流、標章 | 簽章流程。M02 只回答「此人此刻能不能簽」 | 無 |
| M03 物件與單位 | P1 | 產權錨點、租賃單位、物件、出租權源鏈條、重複偵測、移交包 | 合約內容 | `equipment.ts`、`db.ts` 的 `properties` 與 `equipment_vocabulary` |
| M04 合約與簽章 | P1 | 租賃與委託管理合約、三層文件、範本、簽章分流、簽章紀錄、電子簽署 adapter | 案件流程。合約狀態機不知道案件存在 | `contract-*.ts`、`clause-library.ts`、`pdf*.ts`、`signature-layout.ts`、`transitions.ts`、`signing.ts` |
| M05 案件 orchestrator | P1 起 | 案件狀態、事件表、案件成員、待辦來源、修繕工單、P2 買賣七段、P3 繼承協調 | 金額計算、檔案保存 | 延伸 `transitions.ts` 的純函式模式 |
| M06 帳務 | P1 | 鏡像帳、押金台帳、入帳確認轉接層、撥款指示、對帳差異、款項狀態。P2 加信託案件識別碼 | 轉帳。平台沒有轉帳路徑 | 無 |
| M07 文件庫 | P1 | 文件與版本、取得時間、新鮮度、到期、隱匿、刪除排程、`vault` 分區 | 文件內容的業務判斷 | `contract-files.ts` 併入 |
| M08 通知與待辦 | P1 | 通知派送、待辦清單、提醒排程 | 決定要提醒什麼。由擁有規則的模組呼叫 | `workbench.ts` 的待辦邏輯併入 |
| M09 報表與資產總覽 | P1 起 | 房東報表、資產總覽 v1、P3 全資產清冊與期限計算 | 寫入別的模組的資料、產生建議 | `workbench.ts` 的統計 |
| M10 外部整合 | P1 起 | 外部系統 adapter，清單見 2.6 | 業務規則 | `dottedsign.ts` |
| M11 稽核 | P1 | 稽核事件、hash chain、外部錨定、鏈驗證 | 合約活動歷程。那仍是 `contract_events` | 無 |

### 2.3 相依規則

```
呈現層 ──► M05 案件 orchestrator ──► M04 合約與簽章 ──► M02 經理人驗證
                │                        │
                ├──► M06 帳務            └──► M03 物件與單位
                ├──► M07 文件庫
                └──► M08 通知與待辦

全部模組 ──► M01 身分與組織（context、authorize）
全部模組 ──► M11 稽核（appendAudit）
M09 ──► M03、M04、M05、M06、M07 的查詢介面（只讀）
M10 ◄── 只被擁有該整合的模組，經 worker 呼叫
```

1. 箭頭是呼叫方向。反方向的呼叫不得出現。
2. M04 的合約狀態機不呼叫 M05。M05 讀合約事件後推進案件。
3. M02 不呼叫 M04。M04 送簽前查 M02。
4. M09 不寫任何表，只有 P3 的清冊表屬於它。
5. route handler 只呼叫應用服務，不直接寫 SQL。route handler 的寫法動工前先讀 `node_modules/next/dist/docs/`。
6. 交易內不得呼叫外部 API。對外呼叫一律寫 outbox，由 worker 執行。

CI 用 import 規則檢查第 1 至 3 條。違反時 CI 失敗。

### 2.4 對外介面

所有寫入介面的第一個參數都是 `t`，內含組織、使用者與交易。

```ts
// 共用基礎與 M01 身分與組織
interface RequestContext {
  orgId: string;
  userId: string | null;
  partyId: string | null;
  identityLevel: 1 | 2 | 3 | 4;
  actingPractitionerId: string | null; // 操作者是執業人員時才有值
  requestId: string;
}
interface TxContext extends RequestContext { tx: Tx }
function withTx<T>(ctx: RequestContext, fn: (t: TxContext) => Promise<T>): Promise<T>;
// withTx 開交易後第一件事：SELECT set_config('app.org_id', $1, true)
function authorize(t: TxContext, action: Action, object: ObjectRef): Promise<void>; // 拒絕時丟 Forbidden
function requireIdentityLevel(t: TxContext, level: 1 | 2 | 3 | 4): Promise<void>; // 不足時丟 StepUpRequired

// M02 經理人驗證
function registerPracticeEntity(t: TxContext, input: PracticeEntityInput): Promise<{ entityId: string; state: CredentialState }>;
function submitPractitioner(t: TxContext, input: PractitionerInput): Promise<{ employmentId: string; state: CredentialState }>;
function recordCredentialCheck(t: TxContext, input: CredentialCheckInput): Promise<CredentialState>; // 審核員登錄人工核對結果
function decideCredentialTransition(s: CredentialState, e: CredentialEvent, f: CredentialFacts): CredentialDecision | null; // 純函式
function credentialStatusAt(t: TxContext, employmentId: string, at: Date): Promise<CredentialStatus>;
function eligibleSigners(t: TxContext, entityId: string, doc: SignableDocType, at: Date): Promise<PractitionerRef[]>;

// M03 物件與單位
function registerUnit(t: TxContext, input: AnchorInput & UnitInput): Promise<
  { kind: 'created' | 'attached'; anchorId: string; unitId: string } | { kind: 'needs_review'; reviewId: string }
>;
function mergeAnchors(t: TxContext, fromId: string, intoId: string): Promise<void>;
function submitAuthority(t: TxContext, input: AuthorityInput): Promise<string>;
function verifyAuthority(t: TxContext, authorityId: string, decision: 'verified' | 'rejected'): Promise<void>;
function primaryAuthorityAt(t: TxContext, unitId: string, at: Date): Promise<LeasingAuthority | null>;
function authorityChain(t: TxContext, authorityId: string): Promise<LeasingAuthority[]>; // 由根到葉
function sealHandover(t: TxContext, packageId: string): Promise<string>; // 回傳封包雜湊
function acceptHandover(t: TxContext, packageId: string, decision: 'accepted' | 'rejected'): Promise<void>;

// M04 合約與簽章
function routeSignatures(input: RoutingInput): SignatureRoute; // 純函式，查簽章分流規則表
function sendForSigning(t: TxContext, contractId: string): Promise<void>; // 送簽前重查證照，寫簽章紀錄草稿
function decideTransition(state: ContractStatus, event: DsEvent, signer: SignerStageRef): TransitionDecision | null; // 純函式
interface ESignProvider {
  createTask(doc: Uint8Array, signers: SignerStage[]): Promise<{ taskId: string }>;
  getSignLink(taskId: string, email: string, redirectUrl?: string): Promise<string>;
  voidTask(taskId: string): Promise<void>;
  resendTask(taskId: string): Promise<void>;
  verifyWebhook(rawBody: string, headers: Headers): boolean;
  toInboxMessage(rawBody: string): InboxMessageInput; // 決定去重鍵
  downloadFiles(taskId: string, kinds: ContractFileKind[]): Promise<DownloadedFile[]>;
}

// M05 案件 orchestrator
function decideCaseTransition(state: CaseState, event: CaseInput): CaseDecision | null; // 純函式
function dispatch(t: TxContext, caseId: string, event: CaseInput): Promise<CaseState>; // 狀態、事件、outbox 同交易
function addMember(t: TxContext, caseId: string, member: CaseMemberInput): Promise<void>;

// M06 帳務
interface DepositSource {
  readonly source: 'manual_upload' | 'recon_file' | 'bank_push' | 'escrow_push';
  parse(message: InboxMessage): Promise<ParsedConfirmation[]>;
}
function ingest(source: DepositSource['source'], externalId: string, payload: unknown): Promise<'accepted' | 'duplicate'>;
function reviewManual(t: TxContext, confirmationId: string, decision: 'confirmed' | 'rejected'): Promise<void>;
function postJournal(t: TxContext, j: JournalInput): Promise<string>; // 借貸不平衡時丟錯
function reverseJournal(t: TxContext, journalId: string, reason: string): Promise<string>;
function balance(t: TxContext, accountCode: string, asOf?: Date): Promise<bigint>;
function fundStatus(t: TxContext, caseId: string): Promise<FundStatus[]>; // P1 起回傳，P2 加信託來源
function proposeSettlement(t: TxContext, caseId: string, lines: SettlementLine[]): Promise<string>;
function sendForSignatures(t: TxContext, instructionId: string): Promise<void>;
function lookupLink(t: TxContext, trustCaseRefId: string): Promise<ExternalLink>; // P2，導向銀行或建經頁面

// M07 文件庫
function addVersion(t: TxContext, input: DocumentVersionInput): Promise<string>;
function isFresh(t: TxContext, versionId: string, use: DocumentUse): Promise<boolean>;
function readOriginal(t: TxContext, versionId: string): Promise<SignedUrl>; // 一定寫稽核事件
function scheduleDeletion(t: TxContext, versionId: string, reason: DeletionReason): Promise<void>;

// M08 通知與待辦
function notify(t: TxContext, n: NotificationInput): Promise<void>; // 寫 outbox
function listTodos(t: TxContext, filter: TodoFilter): Promise<Todo[]>;
function scheduleReminder(t: TxContext, r: ReminderInput): Promise<string>;

// M09 報表與資產總覽
function ownerReport(t: TxContext, ownerPartyId: string, period: Period): Promise<OwnerReport>;
function inventoryView(t: TxContext, inventoryId: string): Promise<InventoryView>; // P3
function computeDeadlines(death: { deathDate: string }): InheritanceDeadline[]; // P3，純函式

// M10 外部整合（各 adapter 介面）
interface CompanyRegistrySource { lookup(ubn: string): Promise<CompanyRecord | null> } // 商工 API
interface CredentialCheckSource { readonly mode: 'manual_resim' | 'resim_batch' } // P1 只有 manual_resim
interface IdentityProofProvider { start(level: 3): Promise<ProofSession>; finish(id: string): Promise<ProofResult> } // 行動自然人憑證
interface TrustStatusSource extends DepositSource { lookupUrl(ref: TrustCaseRef): string } // P2
interface StatementParser { parse(versionId: string): Promise<ParsedAssetLine[]> } // P3，結果一律待人工確認

// M11 稽核
function appendAudit(t: TxContext, e: AuditEventInput): Promise<void>; // 只呼叫資料庫函式 audit.append()
function verifyChain(orgId: string, fromSeq?: bigint): Promise<ChainReport>;
```

### 2.5 執行元件

```
                     使用者：房東、經理人、租客、買賣方、高端客戶、平台審核員
                                         │ HTTPS
┌────────────────────────────────────────┼─────────────────────────────────────┐
│ Next.js 應用（動工前先讀 node_modules/next/dist/docs/）                      │
│  頁面（antd）  ·  route handlers /api/*  ·  webhook 接收端（只寫 inbox）     │
│  應用服務層：M01 至 M11                                                      │
│  資料存取層：withTx()、repository 介面                                       │
└────────────────────────────────────────┬─────────────────────────────────────┘
                                         │
       ┌─────────────────────────────────┼──────────────────────────┐
       ▼                                 ▼                          ▼
┌──────────────┐          ┌──────────────────────┐        ┌────────────────┐
│ PostgreSQL   │◄────────►│ 背景 worker          │───────►│ 物件儲存       │
│ tenant、     │ outbox   │ outbox 派送、對帳、  │        │ 一般區、vault  │
│ registry、   │ inbox    │ 效期掃描、錨定、解析 │        │ 加密、版本化   │
│ audit、vault │          │ 固定出口 IP          │        │                │
└──────────────┘          └──────────┬───────────┘        └────────────────┘
                                     │
   ┌──────────┬──────────┬───────────┼───────────┬────────────┬────────────┐
   ▼          ▼          ▼           ▼           ▼            ▼            ▼
 點點簽    商工 API   行動自然人   建經、銀行   時間戳記     Email、SMS   上傳解析
 [P1]      [P1]       憑證 [P1]    [P2]         [P1]         [P1]         [P3]
```

resim 不在圖上。它沒有系統介接，由平台審核員在瀏覽器人工查詢，見 4.9。

背景 worker 是獨立程序，和 Next.js 共用 `src/lib/` 的領域程式碼。route handler 的生命週期不適合長時間任務。worker 的部署方式動工前先讀 `node_modules/next/dist/docs/`，確認此版本有無內建背景任務機制。

### 2.6 外部系統

| 外部系統 | 平台怎麼用 | 介接方式 | 階段 | 已知限制 |
|---|---|---|---|---|
| 點點簽 | 合約、委託管理合約、結算單、撥款指示的電子簽署與 Audit Trail File | REST API 與 webhook，Client Credentials（ADR-0003） | P1 | webhook 查不到事件 ID 欄位，去重鍵見 4.1 |
| 商工登記 API | 查執業主體的公司狀態與營業項目代碼 | REST API，IP 白名單 | P1 | 只證明公司存在、狀態與營業項目，不能證明許可或證書【高】 |
| resim | 查業者、租賃住宅管理人員、經紀人員的證書與任職 | 平台審核員人工查詢 | P1 | 圖形驗證碼。批次核對須向內政部地政司申請 |
| 行動自然人憑證 | 驗證等級 3 的身分確認 | 系統介接，啟用前一個月書面申請 | P1 申請，核准後上線 | 內政部審核，不得再授權第三方【高】。審核標準、費用與規格待確認 |
| 圖資服務（例如 TGOS） | 門牌正規化與座標，供軟性重複偵測 | API | P1 | 地籍圖只能展示，不可當界址依據【中】 |
| 時間戳記服務 | 稽核 hash chain 的外部錨定 | RFC 3161 時戳 | P1 | 服務商未選定 |
| Email、SMS | 通知、OTP | API | P1 | 驗證等級 1 依賴它 |
| 建經 | 買賣案件的入帳狀態、撥款執行、查詢頁 | 特約通路帳號查詢、對帳檔或推送，商務洽談 | P2 | 合作契約型態未公開。平台比照特約地政士加入通路 |
| 銀行信託部 | 信託專戶查詢頁連結、對帳檔 | 商務洽談 | P2 | 企業信託專戶入帳通知 API 未查到。平台與銀行沒有委託關係，直接介接須三方約定（推論） |
| 上傳解析 | 解析對帳單、存摺截圖、謄本 | 平台內解析或外部服務，待選 | P3 | 集保與開放銀行的第三方管道很少【低】。外部服務屬個資委外處理，選用前必須由法務確認 |

### 2.7 儲存選擇

| 資料 | 儲存 | 理由 |
|---|---|---|
| 交易資料：組織、案件、合約、帳本、權限 | PostgreSQL `tenant` schema，pool 模式加 RLS | 需要 RLS、交易、約束、時點復原（第一輪報告第 9 章） |
| 全域登錄：產權錨點、租賃單位、執業主體、執業人員、任職 | PostgreSQL `registry` schema，不掛組織 RLS | 唯一鍵與專任衝突必須跨組織成立，見 ADR-0014 與 ADR-0015 |
| 稽核事件 | PostgreSQL `audit` schema，獨立寫入角色 | 觸發器禁止 UPDATE 與 DELETE，hash chain 在資料庫內計算 |
| 特種個資與證件影像的中繼資料 | PostgreSQL `vault` schema，獨立讀取角色 | 存取路徑與一般資料分開，見 4.11 |
| inbox、outbox、背景任務 | 同一個 PostgreSQL | 狀態更新與 outbox 必須同交易，不引入訊息佇列 |
| 檔案 | S3 相容物件儲存，伺服器端加密、版本控制。`vault` 檔案放獨立 bucket 與金鑰 | 檔案不進資料庫，資料庫只存 key 與 SHA-256 |
| 快取 | 不設，商工 API 查詢結果除外 | 量級不需要。快取有跨組織外洩風險 |

`data/contract-files/` 的本機檔案搬到物件儲存。`contract_files.rel_path` 改存物件 key。

### 2.8 資料流：Phase 1 租賃案件

```
 ⓪ 經理人開通        ① 物件登錄      ② 出租權源驗證   ③ 委託管理合約     ④ 租賃合約簽署
 PracticeEntity     PropertyAnchor  LeasingAuthority ManagementContract Contract
 Practitioner       RentalUnit      DocumentVersion  SignatureRecord    SignatureRecord
      │                  │                │                │                  │
      ▼                  ▼                ▼                ▼                  ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ Case 狀態：draft → authority_verified → signing → awaiting_deposit → active          │
 └──────────────────────────────────────────────────────────────────────────────────────┘
                                   │ 房東或租客發起退租
                                   ▼
 ⑤ 押金與租金入帳      ⑥ 退租點交              ⑦ 押金結算                    ⑧ 結案
 DepositConfirmation   HandoverPackage 屋況段  DisbursementInstruction       押金負債餘額為 0
 MirrorLedger          點交證明簽章            退還證明簽章 → 回報執行結果
      │                      │                        │                        │
      ▼                      ▼                        ▼                        ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ Case 狀態：active → move_out → settling → closed                                     │
 └──────────────────────────────────────────────────────────────────────────────────────┘
```

| 步驟 | 觸發 | 平台寫入（同一交易） | 對外動作（outbox） | 錢在哪 |
|---|---|---|---|---|
| ⓪ 經理人開通 | 經理人上傳公司資料與證書 | `registry.practice_entities`、`registry.practitioners`、`registry.practitioner_employments`、`vault` 中繼資料 | 商工 API 查詢；通知審核員做 resim 核對 | 無 |
| ① 物件登錄 | 房東或經理人送出表單 | `registry.property_anchors`、`registry.rental_units`、`properties` | 疑似重複時通知審核員 | 無 |
| ② 權源驗證 | 上傳第二類謄本或授權書 | `documents`、`document_versions`、`leasing_authorities` | 到期提醒排程 | 無 |
| ③ 委託管理合約 | 代管時，房東與代管業送簽 | `management_contracts`、`contracts`、`signature_records` | 呼叫點點簽 | 無 |
| ④ 租賃合約 | 送簽、點點簽 webhook | `contracts`、`contract_events`、`signature_records`、`cases`、`case_events` | 呼叫點點簽，保存已簽 PDF | 無 |
| ⑤ 入帳 | 人工上傳匯款證明 | `inbox_messages`、`deposit_confirmations`、`ledger_journals`、`cases` | 通知房東與租客 | 房東帳戶 |
| ⑥ 退租點交 | 雙方會同點交 | `handover_packages` 屋況段、`document_versions`、`signature_records` | 通知雙方確認 | 無 |
| ⑦ 押金結算 | 雙方簽署結算單 | `disbursement_instructions`、`case_events`、`signature_records` | 通知房東撥付 | 房東撥付 |
| ⑧ 結案 | 房東回報撥付，人工審核 | `ledger_journals`、`cases` | 結案通知 | 無 |

Phase 1 沒有銀行合作。押金進房東帳戶，平台仍記鏡像帳。這能讓房東與經理人說明押金的去向。

### 2.9 資料流：Phase 2 買賣案件

買賣案件以僑馥七段流程為骨架（BRD 8.2）。平台做三件事：每段的文件待辦與通知、接收入帳狀態、把撥款指示交建經執行。

```
 簽約前 → 簽約後 → 用印 → 完稅 → 過戶 → 點交 → 結案
   │        │                     │      │      │
   │        └ 建經入帳狀態 ───────┼──────┼──────┼──► TrustStatusSource → DepositConfirmed
   │                              │      │      │
   │                              │      │      └ 收到 DisbursementExecuted
   │                              │      └ 撥款指示雙簽 → outbox → 建經執行
   │                              └ 地政登記完成（不可回頭）
   └ 銷售委託合約，經紀人簽章（§22）
```

| 段 | 平台寫入 | 誰執行 | 錢在哪 |
|---|---|---|---|
| 簽約前 | 銷售委託合約、物件與出租權源資料、文件待辦 | 經紀業，經紀人簽章 | 無 |
| 簽約後 | 買賣合約、`trust_case_refs`、案件成員加建經與地政士 | 買賣方、經紀業、建經 | 建經信託專戶 |
| 用印、完稅 | 文件待辦、地政士上傳完稅文件 | 地政士 | 建經信託專戶 |
| 過戶 | 登記完成事件，不可回頭 | 地政士 | 建經信託專戶 |
| 點交 | 點交紀錄、撥款指示雙簽 | 買賣方 | 建經依指示撥款 |
| 結案 | `DisbursementExecuted`、結案通知 | 建經 | 賣方帳戶 |

查帳連結只導向銀行或建經的查詢頁。平台不保存買賣方在銀行或建經的查詢憑證。

## 3. 領域模型

### 3.1 關係總覽

```
┌─ registry schema：全域，不掛組織 RLS，只經 SECURITY DEFINER 函式存取 ────────────┐
│ PropertyAnchor 1 ── * RentalUnit                                                 │
│ PracticeEntity 1 ── * PracticeLicense                                            │
│ PracticeEntity 1 ── * PractitionerEmployment * ── 1 Practitioner                 │
│ CredentialCheck * ── 1 PracticeEntity、Practitioner 或 PractitionerEmployment    │
└──────────────────────────────────────────────────────────────────────────────────┘
                    │ 以 ID 引用，不建跨 schema 外鍵
                    ▼
┌─ tenant schema：掛組織 RLS ──────────────────────────────────────────────────────┐
│ Organization 1 ── 0..1 PracticeEntity（kind = practice 時）                      │
│ Organization 1 ── * Property * ── 1 RentalUnit                                   │
│ RentalUnit 1 ── * LeasingAuthority ── parent ──► LeasingAuthority（鏈條）        │
│ Organization 1 ── * Case                                                         │
│   Case(management) 1 ── 1 ManagementContract 1 ── * RentalUnit                   │
│   Case(lease)      1 ── * Contract 1 ── * SignatureRecord ──► Practitioner       │
│   Case 1 ── * CaseMember * ── 1 Party                                            │
│   Case 1 ── 0..1 DepositLedger ── * MirrorLedger 分錄                            │
│   Case 1 ── * DepositConfirmation、DisbursementInstruction、FundStatus           │
│   Case 1 ── 0..1 TrustCaseRef [P2]                                               │
│ HandoverPackage：一個 RentalUnit，從原組織到新組織                               │
│ Organization 1 ── * AssetInventory 1 ── * AssetItem、AssetDeadline [P3]          │
└──────────────────────────────────────────────────────────────────────────────────┘
┌─ audit schema ───────────────────────────────────────────────────────────────────┐
│ AuditEvent：每組織一條 hash chain，外部錨定                                      │
└──────────────────────────────────────────────────────────────────────────────────┘
┌─ vault schema ───────────────────────────────────────────────────────────────────┐
│ VaultObject：證件影像、證書影本、P3 特種個資的中繼資料                           │
└──────────────────────────────────────────────────────────────────────────────────┘
```

v1 的 14 個實體全部保留。LeasingAuthority 改寫成鏈條。本版新增 7 個實體：

- P1：PracticeEntity、Practitioner、SignatureRecord、ManagementContract、FundStatus
- P2：TrustCaseRef
- P3：AssetInventory，含 AssetItem 與 AssetDeadline

### 3.2 共通規則

- 主鍵一律用 ULID，對外不暴露流水號。現有 `INTEGER AUTOINCREMENT` 的 `id` 在遷移時保留為 `legacy_id`。
- 金額一律用整數「元」，型別 `bigint`，幣別固定 `TWD`。
- 時間一律用 `timestamptz`。法定期限與效期用 `date`。
- 身分證字號、證書證號、完整建號用欄位層加密。
- `registry` 的資料以 ID 引用，不建跨 schema 外鍵。一致性由 `registry` 函式檢查。

### 3.3 Organization（組織）

平台上的資料隔離單位。經理人、多屋房東、建經、銀行、地政士事務所各是一個組織。個人房東自己也是一個組織。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `kind` | enum | `landlord`、`practice`、`escrow`、`bank`、`land_agent`、`platform` |
| `name` | text | 顯示名稱 |
| `practice_entity_id` | ULID | `kind = practice` 時指向執業主體，其他為空 |
| `plan` | enum | `pool`、`dedicated` |
| `db_locator` | text | `dedicated` 時指向獨立資料庫，`pool` 時為空 |
| `status` | enum | `active`、`suspended`、`offboarding` |

鍵：主鍵 `id`。`UNIQUE (practice_entity_id)`，一個執業主體只屬於一個組織。這張表在控制平面，不掛 RLS。

v1 的 `licenses` jsonb 移除。業別與許可改由執業主體與 `practice_licenses` 表達，見 3.5。

關係：`properties`、`contracts`、`equipment_vocabulary` 都加 `org_id`。遷移時全部掛到一個預設組織。

### 3.4 Party、User、OrgMembership（支援實體）

| 實體 | 欄位 | 鍵 | 說明 |
|---|---|---|---|
| `parties` | `id`、`kind`（`person`、`legal_entity`）、`display_name`、`national_id_enc`、`ubn`、`contact` | 主鍵 `id` | 法律上的參與方。身分證字號加密 |
| `users` | `id`、`email`、`party_id`、`identity_level`、`level_verified_at` | 主鍵 `id`，`UNIQUE (email)` | 登入帳號，一個 user 對應一個 party |
| `org_memberships` | `org_id`、`user_id`、`role`、`valid_period` | `PRIMARY KEY (org_id, user_id)` | 組織內角色，供 RBAC 使用 |

執業人員一定是 `kind = person` 的 party。執業人員要登入簽章時，另有一個 user。

### 3.5 PracticeEntity（執業主體）

持有許可或登記的公司或商號，是委託管理合約與包租租約的當事人（第二輪報告 6.5）。放在 `registry`，因為統一編號必須跨組織唯一。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id` | ULID | 認領此主體的組織 |
| `ubn` | char(8) | 統一編號 |
| `legal_form` | enum | `company`、`sole_proprietorship` |
| `name` | text | 登記名稱 |
| `gcis_status` | text | 商工登記狀態，例如核准設立 |
| `gcis_business_items` | text[] | 營業項目代碼 |
| `gcis_checked_at` | timestamptz | 最近一次商工 API 查詢時間 |
| `state` | enum | 見 4.9 的狀態機 |
| `last_check_id` | ULID | 最近一筆 `credential_checks` |

鍵：主鍵 `id`。`UNIQUE (ubn)`。第二個組織認領同一統編時，不建新列，送人工審核。

支援表 `practice_licenses`，一個業別一列：

| 欄位 | 說明 |
|---|---|
| `id`、`entity_id` | |
| `business_type` | `rental_management`（代管）、`sublease`（包租）、`brokerage`（經紀） |
| `permit_no`、`registration_cert_no` | 許可字號、登記證字號 |
| `guarantee_ok`、`association_member` | 營業保證金與入會的核對結果 |
| `evidence_version_ids` | 許可函、登記證的文件版本 |
| `state` | 同 4.9 |

鍵：`UNIQUE (entity_id, business_type)`。

業別檢查規則：

| 業別 | 必要條件 | 依據 |
|---|---|---|
| `rental_management` | `legal_form = company`，營業項目含 H706011 | 第二輪報告 6.2 |
| `sublease` | `legal_form = company`，營業項目含 H706021 | 同上 |
| `brokerage` | 營業項目含 H704031，公司或商號皆可 | 同上 |
| 任何業別 | 只有 H703100 時不成立 | H703100 不構成代管業資格【高】 |

租賃線僅限公司，個體商號不可能是合法代管業。商工 API 只證明公司存在、狀態與營業項目。許可與登記證要人工核對文件。

代管與包租的執業主體，至少要有一位已驗證的專任管理人員（租賃條例 §25）。少於一位時，該業別的簽章與代操作動作全部停用。

### 3.6 Practitioner（執業人員）

持有證書的自然人，是簽章人（第二輪報告 6.5）。放在 `registry`，因為證號必須跨組織唯一，專任衝突要跨組織偵測。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `person_party_id` | ULID | 對應的自然人 party |
| `cert_kind` | enum | `rental_manager`（租賃住宅管理人員）、`broker`（不動產經紀人）、`sales_agent`（經紀營業員） |
| `cert_year`、`cert_word`、`cert_number` | text | 證號的年、字、號 |
| `issued_on` | date | 發證日 |
| `valid_until` | date | 效期迄日，效期 4 年 |
| `renewal_window_from` | date | 換證提醒起日，`valid_until` 前 6 個月 |
| `state` | enum | 見 4.9 |
| `last_check_id` | ULID | 最近一筆 `credential_checks` |

鍵：主鍵 `id`。`UNIQUE (cert_kind, cert_year, cert_word, cert_number)`。

租賃住宅管理人員期滿前 6 個月內換證（租賃條例 §26，第二輪報告 6.2）。經紀人員的 6 個月提醒窗口是平台設定。報告只寫經紀人員效期 4 年。

支援表 `practitioner_employments`（任職）：

| 欄位 | 說明 |
|---|---|
| `id` | 主鍵 |
| `practitioner_id`、`entity_id` | 執業人員與所屬執業主體 |
| `cert_kind` | 從執業人員複製，供排除約束使用 |
| `is_exclusive` | 專任旗標 |
| `consent_version_id` | 經紀人員為他家執行業務時，所屬業者的同意書 |
| `valid_period` | 任職期間 |
| `state` | 同 4.9 |

鍵：

- 主鍵 `id`。
- 管理人員專任不得重疊：`EXCLUDE USING gist (practitioner_id WITH =, valid_period WITH &&) WHERE (cert_kind = 'rental_manager' AND is_exclusive AND state IN ('verified', 'renewal_due'))`。
- 經紀人員不設排除約束。重疊時進 `conflict_review`，要求上傳同意書。

支援表 `credential_checks`（核對紀錄）：

| 欄位 | 說明 |
|---|---|
| `id` | 主鍵 |
| `subject_type`、`subject_id` | `entity`、`license`、`practitioner`、`employment` |
| `channel` | `gcis_api`、`resim_manual`、`resim_batch`、`document_review` |
| `observed` | 查到的欄位：證號、效期、任職公司、狀態 |
| `result` | `match`、`mismatch`、`not_found`、`revoked` |
| `checked_by`、`checked_at` | 審核員與時間。`gcis_api` 時為系統 |

核對紀錄只存結構化結果，不存查詢頁截圖。證書影本放 `vault`，驗證完成後刪除或遮罩（第二輪報告 6.5）。

### 3.7 PropertyAnchor（產權錨點）

一個產權單位。唯一鍵是「縣市＋鄉鎮市區＋段小段＋建號（含分號）」【高】。建號只在地段內唯一，單存數字會撞號（第一輪報告第 8 章）。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵，對內引用一律用它 |
| `county_code` | text | 縣市編碼，用地政編碼表，不存名稱 |
| `district_code` | text | 鄉鎮市區編碼 |
| `section_code` | text | 段小段編碼 |
| `building_no` | char(5) | 建號，一般建物五位數【高】 |
| `building_sub_no` | char(3) | 分號，特別建物數棟併編時使用【高】。沒有分號存 `000` |
| `status` | enum | `pending_verification`、`verified`、`merged`、`retired` |
| `merged_into_id` | ULID | 合併後指向存續錨點 |
| `address_text` | text | 使用者輸入的門牌 |
| `normalized_address` | text | 正規化後的門牌，供軟性重複偵測 |
| `geo_point` | point | 座標 |
| `registration_snapshot` | jsonb | 最近一份謄本的登記名義人（隱匿後）、信託登記狀態 |

鍵：

- 主鍵 `id`。
- 業務唯一鍵：`UNIQUE (county_code, district_code, section_code, building_no, building_sub_no)`。五欄都有值時才成立。
- 使用者暫時無法提供建號時，以 `pending_verification` 登錄，附門牌與座標。

編碼表用地政單位的編碼。縣市與鄉鎮市區的名稱會因行政區調整而改變，編碼較穩定。

錨點放在 `registry`，不屬於任何組織。第二個組織登錄同一建號時，不建新錨點。第二個組織只新增自己的出租權源，送人工審核。錨點本身不記所有權，所以搶先登錄的人佔不到它。

附屬表：

- `anchor_key_history`：重測或整編造成建號變動時，保存舊複合鍵與變動日期。
- `address_history`：門牌歷史，避免整編後同一物件被視為新物件。
- `supporting_ids`：稅籍編號、基地地號、共有部分建號。共有部分建號依土地登記規則 §81 另編【高】，只當關聯資料。

### 3.8 RentalUnit（租賃單位）

掛在產權錨點下的可出租單位。分租套房沒有官方房間級識別碼，由平台自發 ID。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵，無語意，地址改變也不變，永不重用 |
| `anchor_id` | ULID | 所屬產權錨點 |
| `suffix` | char(4) | 單位後綴。`0000` 代表整戶，分租用房號或標籤 |
| `label` | text | 房號或顯示名稱 |
| `floor` | text | 樓層 |
| `unit_type` | enum | `PROPERTY_TYPES`：整層住家、套房、雅房 |
| `status` | enum | `active`、`retired` |

鍵：主鍵 `id`。業務唯一鍵 `UNIQUE (anchor_id, suffix)`。顯示編碼由錨點編碼加後綴組成。

主鍵不含錨點 ID。待驗證錨點會在驗證後合併，主鍵含錨點 ID 時所有外鍵都要改。

關係：同一個租賃單位同一時間只屬於一個管理它的組織。管理關係由出租權源與委託管理合約表達，不寫在租賃單位上。

### 3.9 Property（物件）

`GLOSSARY.md` 定義的物件，是組織視角的租賃單位。物件存營運資料：名稱、預設租金、設備清單、備註。租賃單位存身分資料：錨點、後綴、樓層。

| 新增欄位 | 型別 | 說明 |
|---|---|---|
| `org_id` | ULID | 所屬組織，RLS 依據 |
| `rental_unit_id` | ULID | 對應的租賃單位。遷移期允許空值，UI 顯示「待綁定錨點」 |
| `status` | enum | `active`、`handed_over` |
| `legacy_id` | integer | 原 SQLite 的 `id` |

鍵：主鍵 `id`。`UNIQUE (org_id, rental_unit_id)`，同一組織對同一租賃單位只有一筆物件。

關係：經理人更換時，新組織建立自己的物件，指向同一個租賃單位。設備清單由移交包帶入。舊組織的物件保留，狀態改為 `handed_over`。`address`、`type`、`size` 在綁定錨點後由租賃單位帶入，物件只留覆寫值。

### 3.10 LeasingAuthority（出租權源鏈條）

出租人出租該單位的依據。出租人不一定是所有權人。包租與轉租時，要保存所有權人到出租人的整條鏈條。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id` | ULID | 登錄這筆權源的組織 |
| `rental_unit_id` | ULID | 對應的租賃單位 |
| `kind` | enum | `ownership`、`authorization`、`sublease_consent`、`trust_lessor` |
| `grantor_party_id` | ULID | 授權方，例如所有權人 |
| `grantee_party_id` | ULID | 被授權方，例如包租業或受託出租人 |
| `grantee_entity_id` | ULID | 被授權方是執業主體時才有值，例如包租業 |
| `parent_authority_id` | ULID | 鏈條上一層。根為空 |
| `root_authority_id` | ULID | 鏈條的根，根自己指向自己 |
| `depth` | smallint | 根為 0 |
| `master_contract_id` | ULID | 包租時，所有權人與包租業的主租約 |
| `is_primary` | boolean | 是否為本次出租的出租人依據 |
| `valid_period` | tstzrange | 有效期間 |
| `status` | enum | `pending`、`verified`、`suspended`、`expired`、`revoked`、`disputed` |
| `evidence_version_ids` | ULID[] | 謄本、授權書、轉租同意書、信託契約的文件版本 |
| `verified_by`、`verified_at` | | 驗證人與時間 |

鍵：

- 主鍵 `id`。
- 同一租賃單位同一時間只能有一筆有效的主要出租權源【高，第一輪報告第 8 章】：`EXCLUDE USING gist (rental_unit_id WITH =, valid_period WITH &&) WHERE (is_primary AND status = 'verified')`。

鏈條規則：

| 規則 | 內容 | 實作 |
|---|---|---|
| 根 | 根必須是 `ownership` 或 `trust_lessor`。根的授權方必須等於謄本的登記名義人 | `verifyAuthority()` 比對 `registration_snapshot` |
| 期間 | 子節點的 `valid_period` 必須落在父節點之內 | 觸發器檢查 |
| 驗證順序 | 父節點已驗證，子節點才能驗證 | `verifyAuthority()` 檢查 |
| 失效傳遞 | 父節點轉 `expired` 或 `revoked` 時，子節點同交易轉 `suspended` | 觸發器 |
| 深度 | `depth` 超過 2 時送人工審核 | `submitAuthority()` 回傳 `needs_review` |
| 包租 | `sublease_consent` 的被授權方是包租業時，`grantee_entity_id` 必須有 `sublease` 業別 | 查 M02 |

深度上限 2 是本文件提議。它涵蓋所有權人、包租業、經同意的再轉租。

`trust_lessor` 用在信託財產。法務部 2026-09-21 書函允許約定委託人為出租人【高】。約定不可架空受託人的管理處分權限【高】。這類權源必須附信託契約的出租權限條款。

**租客端的權源標示。** 租客看得到權源種類與驗證日。租客看不到所有權人全名與完整建號。

| `kind` | 租客端顯示 |
|---|---|
| `ownership` | 所有權人出租，權源已核對 |
| `authorization` | 經所有權人授權出租，權源已核對 |
| `sublease_consent` | 包租或轉租，已取得出租人同意，權源已核對 |
| `trust_lessor` | 信託財產出租，權源已核對 |

關係：一個物件可有多筆出租權源。案件進入簽署前，必須存在一筆有效的主要出租權源。權源跨組織可見度受限，第二個組織只看到「此單位需人工審核」。

### 3.11 ManagementContract（委託管理合約）

房東委託代管業管理租賃單位的合約。法定文件名是委託管理契約書，由專任管理人員簽章（租賃條例 §32 第 1 款）。只用在代管，包租不適用【高】。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id` | ULID | 代管業的組織 |
| `case_id` | ULID | `kind = management` 的案件，借案件成員給房東讀取權 |
| `contract_id` | ULID | 文件與簽署走合約實體，範本為委託管理範本 |
| `landlord_party_id` | ULID | 委託人 |
| `entity_id` | ULID | 受託的執業主體，必須有 `rental_management` 業別 |
| `scope` | jsonb | 授權範圍，例如收租提醒、押金台帳代記、派工 |
| `valid_period` | tstzrange | 委託期間 |
| `status` | enum | `draft`、`signing`、`active`、`terminated`、`expired` |

支援表 `management_contract_units`：`(management_contract_id, rental_unit_id, valid_period)`。

鍵：

- 主鍵 `id`。
- 同一租賃單位同一時間只有一份有效的委託管理合約：`EXCLUDE USING gist (rental_unit_id WITH =, valid_period WITH &&)`，建在 `management_contract_units` 上，條件為對應合約 `status = 'active'`。

關係：代管時，租賃案件的出租人仍是房東，權源是房東的 `ownership`。代管業的操作權來自委託管理合約的 `scope`。`authorize()` 對 `on_behalf` 動作檢查 `scope`，見 4.5。

Phase 2 的銷售委託合約沿用同一結構，加 `kind = 'sale_mandate'`。簽章人改為經紀人。

### 3.12 Case（案件）

一個跨方流程的實例。Phase 1 有租賃與委託管理案件，Phase 2 加買賣，Phase 3 加繼承協調。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id` | ULID | 主辦組織 |
| `kind` | enum | `lease`、`management`、`sale` [P2]、`inheritance` [P3] |
| `business_type` | enum | `self_managed`、`rental_management`、`sublease`、`brokerage` [P2] |
| `rental_unit_id` | ULID | 租賃案件必填 |
| `anchor_id` | ULID | 買賣案件必填 |
| `inventory_id` | ULID | 繼承案件必填 |
| `property_id` | ULID | 主辦組織的物件 |
| `leasing_authority_id` | ULID | 簽署時依據的出租權源 |
| `management_contract_id` | ULID | `business_type = rental_management` 時必填 |
| `current_contract_id` | ULID | 目前有效的合約 |
| `trust_case_ref_id` | ULID | Phase 1 預留，一律為空。Phase 2 指向信託案件識別碼 |
| `state` | enum | 見 4.3 |
| `state_version` | integer | 樂觀鎖，每次轉移加 1 |
| `waiting_on` | jsonb | 目前等誰、做什麼、期限 |
| `opened_at`、`closed_at` | timestamptz | |

鍵：主鍵 `id`。`CHECK` 約束依 `kind` 檢查必填欄位。`case_events` 是 append-only 事件表。

關係：一個案件可有多份合約，因為撤回後會衍生新合約（ADR-0006）。`current_contract_id` 指向最新一份。拒簽後若重新擬約，仍在同一案件內，但新合約不記衍生關聯。

支援表 `work_orders`（修繕工單）：`id`、`case_id`、`description`、`ordered_by`、`dispatched_by`、`status`、`evidence_version_ids`。房東下單付款，經理人派工（BRD 8.1）。派工屬 `on_behalf` 動作。

### 3.13 Contract（合約）

合約的三層文件、範本快照、衍生關聯規則不變（ADR-0004 至 0008）。本版加三件事：組織與案件欄位、文件種類、簽署階段。

| 新增欄位 | 型別 | 說明 |
|---|---|---|
| `org_id` | ULID | 所屬組織 |
| `case_id` | ULID | 所屬案件 |
| `rental_unit_id` | ULID | 對應的租賃單位 |
| `doc_kind` | enum | `lease`、`management`、`condition_report`、`handover_certificate`、`settlement`、`refund_certificate`。`receipt` 預留。P2 加 `sale_mandate`、`sale` |
| `signer_plan` | jsonb | 簽章分流算出的簽署階段，送簽時凍結 |
| `signed_pdf_sha256` | char(64) | 已簽 PDF 的雜湊，供稽核引用 |
| `legacy_id` | integer | 原 SQLite 的 `id` |

`fields` 從 TEXT 改為 `jsonb`，形狀不變。`ContractFields` 的快照規則不變。合約引用物件後自成快照，物件後續修改不回溯。

狀態機加一態 `awaiting_practitioner`，順序是執業人員、乙方、甲方。理由與選項見 ADR-0016。`SignerRole` 由 `landlord`、`tenant` 改為 `party_a`、`party_b`、`practitioner`。租賃合約的畫面標籤仍是房東與租客。

| 狀態 | 意義 |
|---|---|
| `draft` | 草稿 |
| `awaiting_practitioner` | 待執業人員簽章，`signer_plan` 有執業人員時才進入 |
| `awaiting_tenant` | 待乙方簽 |
| `awaiting_landlord` | 待甲方簽 |
| `completed` | 已完成 |
| `declined` | 已拒簽 |
| `voided` | 已撤回 |

狀態識別字 `awaiting_tenant` 與 `awaiting_landlord` 保留，避免改寫既有資料。委託管理合約的乙方是代管業，畫面標籤依 `doc_kind` 顯示。

關係：合約狀態轉移後，案件 orchestrator 依合約事件推進案件。`decideTransition()` 保持純函式，不知道案件存在。

### 3.14 SignatureRecord（簽章紀錄）

每一個簽章人在每一份文件上的簽章一列。用途是稽核與舉證（第二輪報告 6.5）。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id`、`case_id`、`contract_id` | ULID | |
| `doc_type` | enum | 同 `contracts.doc_kind` |
| `statute_ref` | text | 對應款次，例如 `rental_act_32_1`、`brokerage_act_22`。平台自有文件為空 |
| `rule_id`、`rule_version` | | 套用的簽章分流規則 |
| `signer_kind` | enum | `party_a`、`party_b`、`practitioner` |
| `party_id` | ULID | 簽章人的 party |
| `practitioner_id`、`employment_id`、`entity_id` | ULID | `signer_kind = practitioner` 時必填 |
| `credential_snapshot` | jsonb | 送簽當下的證號（遮罩）、效期、狀態、核對紀錄 ID |
| `stage_order` | smallint | 在簽署任務中的順序 |
| `esign_task_id` | text | 點點簽簽署任務 |
| `status` | enum | `planned`、`signed`、`declined`、`voided` |
| `signed_at` | timestamptz | 由 webhook 事件時間寫入 |
| `consent_audit_ref` | jsonb | 相對人同意紀錄的稽核事件 `(org_id, seq)` |

鍵：主鍵 `id`。`UNIQUE (contract_id, stage_order)`。

關係：`signer_kind = practitioner` 的列，送簽時與執行簽章時各查一次 M02。兩次都必須是 `verified` 或 `renewal_due`。第二次不符時，合約撤回，見 4.10。

### 3.15 DepositLedger（押金台帳）

每個租賃案件一本押金台帳。台帳是鏡像帳上的業務視圖，不自己存餘額。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id` | ULID | |
| `case_id` | ULID | 一個案件一本 |
| `expected_amount` | bigint | 合約約定的押金，來自 `ContractFields.deposit` |
| `custody` | enum | `landlord_account`、`trust_account`。Phase 1 只用前者 |
| `bank_account_ref` | text | 收款帳戶的遮罩識別，例如末四碼與銀行編碼 |
| `virtual_account_no` | text | 預留。押金專戶修法或銀行推出產品時才用 |
| `status` | enum | `awaiting`、`held`、`settling`、`settled` |

鍵：主鍵 `id`，`UNIQUE (case_id)`。已收、已扣抵、已返還的金額由鏡像帳分錄加總，不另存。

押金上限 2 個月租金【高，第一輪報告第 7 章範本】。台帳建立時檢查 `expected_amount`，超過上限時阻擋送簽。

租賃端信託目前沒有銀行產品（第二輪報告 7.5）。`trust_account` 只在提前觸發條件成立後啟用。條件有兩項：內政部公布押金專戶修法草案，或銀行公開租賃押金信託產品。

### 3.16 MirrorLedger（鏡像帳）

平台記錄的銀行帳戶分錄副本，真相在銀行。雙式分錄，只增不改，更正用沖銷分錄。

`ledger_accounts`：

| 欄位 | 說明 |
|---|---|
| `id` | 主鍵 |
| `org_id` | 所屬組織 |
| `code` | 科目編碼，例如 `asset.bank.{account_ref}`、`liability.deposit.{case_id}` |
| `type` | `asset`、`liability`、`income`、`receivable` |
| `case_id` | 案件科目才有值 |

`ledger_journals`：

| 欄位 | 說明 |
|---|---|
| `id` | 主鍵 |
| `org_id` | |
| `business_event_type` | `deposit_confirmed`、`rent_due`、`rent_confirmed`、`deduction_agreed`、`disbursement_executed`、`reversal` |
| `business_event_id` | 對應的業務事件 ID，例如入帳確認 ID |
| `reverses_journal_id` | 沖銷分錄才有值，指向被沖銷的分錄 |
| `effective_date` | 銀行記帳日 |
| `posted_at` | 平台記錄時間 |
| `memo` | 說明 |

`ledger_entries`：

| 欄位 | 說明 |
|---|---|
| `id` | 主鍵 |
| `journal_id` | 所屬分錄 |
| `account_id` | 科目 |
| `debit`、`credit` | 整數元，一欄為 0 |

鍵：`UNIQUE (business_event_type, business_event_id)`，同一業務事件只入帳一次。`UNIQUE (reverses_journal_id)`，一筆分錄只能被沖銷一次。

關係：每筆分錄關聯一個業務事件 ID。押金台帳、房東報表、移交包的錢段都從分錄加總產生。

### 3.17 DepositConfirmation（入帳確認）

平台收到的「款項已入帳」事件。來源為人工上傳、對帳檔、銀行或建經推送。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id`、`case_id` | ULID | |
| `inbox_message_id` | ULID | 來源的 inbox 紀錄 |
| `source` | enum | `manual_upload`、`recon_file`、`bank_push`、`escrow_push`。Phase 1 只用 `manual_upload` |
| `source_ref` | text | 來源端交易序號。人工上傳時為證明檔雜湊 |
| `purpose` | enum | `deposit`、`rent`，P2 加 `sale_price` |
| `amount` | bigint | |
| `value_date` | date | 銀行入帳日 |
| `account_ref` | text | 入帳帳戶遮罩識別 |
| `trust_case_ref_id` | ULID | Phase 1 為空 |
| `evidence_version_id` | ULID | 匯款證明或對帳檔的文件版本 |
| `status` | enum | `pending_review`、`confirmed`、`rejected`、`reversed` |
| `reviewed_by`、`reviewed_at` | | 人工審核時才有值 |

鍵：主鍵 `id`，`UNIQUE (source, source_ref)`。

關係：狀態變成 `confirmed` 時，同一交易內發出 `DepositConfirmed`、寫鏡像帳分錄、更新款項狀態、推進案件。

### 3.18 DisbursementInstruction（撥款指示）

雙方電子簽署、交建經或銀行執行的付款指令。Phase 1 沒有建經與銀行，由房東自行撥付後回報。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id`、`case_id` | ULID | |
| `kind` | enum | `deposit_settlement`，P2 加 `sale_release` |
| `lines` | jsonb | 每列：收款方 party、金額、事由（返還、扣抵修繕、扣抵欠租） |
| `total_amount` | bigint | 必須等於押金台帳餘額 |
| `executor` | enum | `landlord_self`，P2 加 `escrow`、`bank` |
| `esign_task_id` | text | 點點簽簽署任務 |
| `required_identity_level` | smallint | 簽署人最低驗證等級，見 4.6 |
| `status` | enum | `draft`、`awaiting_signatures`、`signed`、`submitted`、`executed`、`rejected`、`failed` |
| `submitted_at`、`executed_at` | timestamptz | |
| `execution_ref` | text | 建經、銀行或房東回報的交易序號 |

鍵：主鍵 `id`。同一案件同一時間只能有一筆非終態的指示，用部分唯一索引實作。

關係：撥款執行是不可回頭的步驟。`executed` 由轉接層收到 `DisbursementExecuted` 才設定。Phase 1 的房東回報也走轉接層，來源為 `manual_upload`。

### 3.19 HandoverPackage（移交包）

經理人更換時，每個租賃單位的六類資料集合。退租點交也用同一結構的屋況段。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `rental_unit_id` | ULID | |
| `from_org_id`、`to_org_id` | ULID | 原組織與新組織。退租點交時兩者相同 |
| `purpose` | enum | `manager_change`、`move_out`、`move_in` |
| `sections` | jsonb | 權屬、人、屋況、錢、實物、行政六段，每段列出文件版本 ID 與快照 |
| `ledger_snapshot` | jsonb | 押金台帳、預收租金、欠費、代收代付清單在封包時的餘額 |
| `landlord_confirmed_at` | timestamptz | 房東逐案確認時間 |
| `status` | enum | `draft`、`sealed`、`accepted`、`rejected` |
| `sealed_sha256` | char(64) | 封包後整包內容的雜湊 |

鍵：主鍵 `id`。封包後內容不可改，雜湊寫進稽核事件。

關係：移交包是跨組織資料。封包後，新組織只能讀，不能改。新組織接受後，舊委託管理合約轉 `terminated`，新委託管理合約才能生效。業者更換時既有押金的處理規定沒有找到（第一輪報告第 7 章）。錢段的處理方式待法務確認。

### 3.20 CaseMember（案件成員）

案件與參與方的關係。權限由「關係加動作」決定。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `case_id` | ULID | |
| `party_id` | ULID | 參與方 |
| `relation` | enum | 見 4.5 |
| `granted_by` | ULID | 授予的使用者 |
| `valid_period` | tstzrange | 有效期間，結案後保留唯讀 |

鍵：`PRIMARY KEY (case_id, party_id, relation)`。索引 `(party_id, case_id)` 供 RLS 查詢。

### 3.21 AuditEvent（稽核事件）

平台側的稽核級紀錄。範圍見 4.7。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `org_id` | ULID | 每組織一條鏈 |
| `seq` | bigint | 組織內遞增序號 |
| `occurred_at` | timestamptz | |
| `actor_user_id`、`actor_party_id` | ULID | |
| `actor_identity_level` | smallint | 行為當下的驗證等級 |
| `actor_practitioner_id` | ULID | 執業人員操作時才有值 |
| `action` | text | 例如 `deposit.confirm`、`credential.verify`、`signature.route`、`vault.read` |
| `object_type`、`object_id` | | 被操作的物件 |
| `case_id` | ULID | 有案件時才有值 |
| `payload` | jsonb | 變更前後的關鍵欄位，不放完整個資 |
| `request_meta` | jsonb | IP、user agent、request ID |
| `prev_hash`、`hash` | char(64) | hash chain |

鍵：`PRIMARY KEY (org_id, seq)`。`registry` 的動作記在操作者所屬組織的鏈上。平台審核員的動作記在 `platform` 組織的鏈上。

### 3.22 TrustCaseRef 與 FundStatus

信託案件識別碼與款項狀態。Phase 2 用「外部信託，平台只存狀態」（第二輪報告 7.6）。Phase 1 預留欄位與款項狀態表。

`trust_case_refs`（Phase 2 建表）：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id`、`case_id` | ULID | |
| `provider_org_id` | ULID | 建經或銀行的組織 |
| `provider_kind` | enum | `escrow`、`bank` |
| `trust_type` | enum | `escrow_self_benefit`（建經自益信託）、`party_trust`（買賣方為委託人的價金信託） |
| `external_ref_enc` | bytea | 保證編號或案件編號，加密，畫面遮罩 |
| `lookup_url_template` | text | 查帳連結範本，不含個資 |
| `status` | enum | `registered`、`active`、`closed` |

鍵：主鍵 `id`。`UNIQUE (provider_org_id, external_ref_hash)`，另存雜湊欄供唯一約束。

兩種信託的查詢者不同（第二輪報告 7.1）。價金信託的查詢者是契約當事人。建經自益信託的查詢靠建經系統或銀行連結。兩者都不含經理人與平台。`lookup_url_template` 只帶出查詢頁，身分由買賣方自己在對方頁面驗證。

`fund_statuses`（Phase 1 建表）：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id`、`case_id` | ULID | |
| `purpose` | enum | `deposit`、`rent`，P2 加 `sale_price`、`tax` |
| `custody` | enum | `landlord_account`，P2 加 `escrow_account`、`trust_account` |
| `status` | enum | `expected`、`confirmed`、`partially_released`、`released`、`refunded` |
| `amount_expected`、`amount_confirmed` | bigint | |
| `source` | enum | `mirror_ledger`，P2 加 `escrow_push`、`recon_file` |
| `trust_case_ref_id` | ULID | Phase 1 為空 |
| `as_of` | timestamptz | 來源的資料時間 |

鍵：`UNIQUE (case_id, purpose)`。

款項狀態是讀取模型。Phase 1 由鏡像帳在同交易更新。Phase 2 由信託狀態轉接層更新。畫面只讀這張表，換來源時畫面不用改。

### 3.23 AssetInventory（資產清冊，Phase 3）

高端客戶的全資產列表。每一列標示來源與取得日期，避免被當成核實資產證明（第二輪報告 8.1）。

`asset_inventories`：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id` | ULID | 客戶的組織 |
| `holder_party_id` | ULID | 資產持有人 |
| `status` | enum | `active`、`archived` |

`asset_items`：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `inventory_id`、`org_id` | ULID | |
| `asset_class` | enum | `real_estate`、`deposit_account`、`security`、`insurance_policy`、`trust`、`other` |
| `anchor_id` | ULID | 不動產才有值，經 `registry.lookup_unit()` 取得 |
| `holding_numerator`、`holding_denominator` | integer | 持有比例或持分 |
| `institution_name`、`masked_account` | text | 金融機構與遮罩帳號 |
| `declared_value` | bigint | 使用者申報值，畫面標示「使用者申報」 |
| `source` | enum | `platform_record`、`user_entry`、`user_upload`、`parsed_upload` |
| `source_version_id` | ULID | 來源文件版本 |
| `obtained_at` | date | 資料取得日期 |
| `as_of_date` | date | 資料所反映的日期 |
| `status` | enum | `pending_confirmation`、`confirmed`、`stale` |

鍵：主鍵 `id`。`parsed_upload` 的列預設 `pending_confirmation`，使用者確認後才進清冊總覽。

`asset_deadlines`：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `inventory_id`、`case_id` | ULID | 繼承期限掛在繼承案件 |
| `kind` | enum | `estate_tax_filing`、`inheritance_registration`、`policy_renewal`、`lease_expiry`、`custom` |
| `base_date` | date | 起算基準，例如死亡日 |
| `due_date` | date | 由 `computeDeadlines()` 算出 |
| `extended_due_date` | date | 遺產稅申請延長核准後才有值 |
| `legal_ref` | text | 例如遺贈稅法 §23、土地法 §73 |
| `status` | enum | `open`、`done`、`overdue`、`waived` |

鍵：主鍵 `id`。`UNIQUE (case_id, kind)`，繼承案件的兩個法定期限各一列。

## 4. 關鍵機制

### 4.1 入帳確認轉接層

平台內部只認一個標準事件 `DepositConfirmed`。來源依階段增加，第一版不押注單一銀行或建經。

| 來源 | 階段 | 去重鍵 `source_ref` | 是否需人工審核 | 舞弊風險 |
|---|---|---|---|---|
| `manual_upload`：租客或房東上傳匯款證明，房東回報撥付 | P1 | 證明檔 SHA-256 加金額加入帳日 | 必須 | 最高（第一輪報告第 9 章） |
| `recon_file`：建經或銀行的每日對帳檔 | P2 | 對方交易序號 | 不需要，差異才送審 | 低 |
| `escrow_push`：建經推送入帳與撥款狀態 | P2 | 對方事件 ID | 不需要 | 低 |
| `bank_push`：銀行推送 | P2，待銀行書面回覆 | 對方事件 ID | 不需要 | 低 |

`DepositConfirmed` 的內容：

```ts
interface DepositConfirmed {
  confirmationId: string;
  caseId: string;
  purpose: 'deposit' | 'rent' | 'sale_price';
  amount: bigint;
  valueDate: string;           // 銀行入帳日
  custody: 'landlord_account' | 'escrow_account' | 'trust_account';
  source: 'manual_upload' | 'recon_file' | 'escrow_push' | 'bank_push';
  trustCaseRefId: string | null; // Phase 1 一律為 null
  evidenceVersionId: string;
}
```

Phase 2 的信託狀態來源實作 `TrustStatusSource`。它多一個 `lookupUrl()`，產生查帳連結。查帳連結只導向銀行或建經頁面。平台不代查，也不保存買賣方的查詢憑證。

**inbox 去重。** 所有外部訊息先寫 `inbox_messages`，再由 worker 處理。

| 欄位 | 說明 |
|---|---|
| `id` | 主鍵 |
| `source` | `dottedsign`、`gcis`、`manual_upload`、`recon_file`、`escrow_push`、`bank_push` |
| `external_id` | 去重鍵 |
| `received_at` | |
| `payload` | 原始內容，敏感欄位加密 |
| `signature_ok` | 簽章驗證結果 |
| `processed_at`、`result`、`attempts`、`last_error` | 處理狀態 |

約束是 `UNIQUE (source, external_id)`。重複訊息在 INSERT 時被 `ON CONFLICT DO NOTHING` 擋下，回傳 `duplicate`。

點點簽 webhook 的 payload 有 `resource_id`、`action_name`、`event_datetime`、`event_email`。點點簽 API 文件查不到事件 ID 欄位。去重鍵定為這四欄串接後的 SHA-256。執業人員、乙方、甲方各有一次 `signed`，`event_email` 能區分三者。

同一人兼任包租業甲方代表與管理人員時，兩次 `signed` 的 `event_email` 相同。`POST /v1/sign_tasks` 的文件沒有寫同一 email 能否出現在兩個 stage。動工前必須用 `dottedsign-api` MCP 與 sandbox 確認。確認前，`routeSignatures()` 拒絕兩個階段共用同一 email 的計畫。

**與狀態機同交易。** worker 處理一筆 inbox 訊息時，下列寫入在同一個資料庫交易內完成：

1. 以 `SELECT ... FOR UPDATE SKIP LOCKED` 鎖定 inbox 訊息。
2. 寫入或更新 `deposit_confirmations`。
3. 狀態為 `confirmed` 時，呼叫 `postJournal()` 寫鏡像帳分錄。
4. 更新 `fund_statuses`。
5. 呼叫 `dispatch()` 推進案件，寫 `case_events`。
6. 寫 outbox：通知房東與租客。
7. 寫稽核事件。
8. 設定 inbox 的 `processed_at`。

任一步失敗，整筆回滾。inbox 訊息保留，`attempts` 加 1 後重試。重試 5 次仍失敗，轉人工處理佇列。

現有 webhook route 把狀態與合約歷程同交易寫入。它沒有 inbox 表，重複事件只靠狀態機守門。已簽 PDF 保存在交易外執行，失敗要手動補抓。新架構把保存改成 outbox 任務，自動重試。

### 4.2 鏡像帳

鏡像帳記銀行帳戶的分錄副本。平台不持有款項，所以鏡像帳不是平台的會計帳。

**規則：**

1. 雙式分錄。每筆 `ledger_journals` 的借方合計等於貸方合計。
2. 只增不改。`ledger_journals` 與 `ledger_entries` 沒有 UPDATE 與 DELETE。
3. 沖銷更正。錯誤分錄由一筆借貸相反的沖銷分錄抵銷，再寫一筆正確分錄。
4. 每筆關聯業務事件。`business_event_type` 加 `business_event_id` 唯一。

**資料庫約束：**

- 借貸平衡用 `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` 在交易提交時檢查。
- 觸發器對 UPDATE 與 DELETE 一律丟錯。應用角色另外撤銷這兩個權限。
- `debit >= 0`、`credit >= 0`、兩欄恰好一欄大於 0，用 CHECK 約束。

**押金案件的分錄範例（押金 20,000 元，進房東帳戶）：**

| 業務事件 | 借方 | 貸方 | 金額 |
|---|---|---|---|
| `deposit_confirmed` | `asset.bank.{房東帳戶}` | `liability.deposit.{case}` | 20,000 |
| `deduction_agreed`：扣抵修繕費 | `liability.deposit.{case}` | `income.deduction.{case}` | 3,000 |
| `disbursement_executed`：返還餘額 | `liability.deposit.{case}` | `asset.bank.{房東帳戶}` | 17,000 |
| `reversal`：更正誤記的入帳確認 | `liability.deposit.{case}` | `asset.bank.{房東帳戶}` | 20,000 |

結案條件是 `liability.deposit.{case}` 餘額為 0。押金台帳的狀態由這個餘額決定。

**對帳。** 真相在銀行。Phase 1 沒有對帳檔，對帳只比對人工上傳的證明。Phase 2 起，worker 每日比對鏡像帳與對帳檔，差異寫入 `recon_exceptions`。差異由人工處理，結果是一筆新分錄或沖銷分錄。對帳流程不改既有分錄。

Phase 2 的買賣價金不記鏡像帳。價金在建經信託專戶，平台只記 `fund_statuses`。理由是平台沒有買賣雙方的帳戶分錄可對，只有建經回報的狀態。

### 4.3 案件 orchestrator

案件用「狀態表加 append-only 事件表」，不全面採事件溯源。`cases.state` 是目前狀態，`case_events` 是發生過的事。

延伸 `transitions.ts` 的模式。`decideCaseTransition()` 是純函式。它輸入目前狀態與事件，輸出下一狀態、要記的事件與要發的 outbox 任務。`dispatch()` 把三者在同一交易寫入，並用 `state_version` 做樂觀鎖。

**租賃案件（P1）：**

| 狀態 | 意義 | 進入條件 | 下一狀態 |
|---|---|---|---|
| `draft` | 擬約中 | 建立案件 | `authority_verified`、`aborted` |
| `authority_verified` | 權源與委託已確認 | 見下方條件 | `signing`、`aborted` |
| `signing` | 合約簽署中 | 合約送簽，簽章分流檢查通過 | `awaiting_deposit`、`authority_verified`（撤回或拒簽） |
| `awaiting_deposit` | 待押金入帳 | 合約 `completed` | `active`、`settling`（押金未入帳即解約） |
| `active` | 租期中 | 收到押金的 `DepositConfirmed` | `move_out` |
| `move_out` | 退租點交 | 房東或租客發起退租 | `settling` |
| `settling` | 押金結算中 | 點交證明完成簽章 | `closed` |
| `closed` | 結案 | 收到 `DisbursementExecuted`，押金負債餘額為 0，退還證明完成簽章 | 無 |
| `aborted` | 中止 | 簽署完成前放棄 | 無 |

`authority_verified` 的進入條件依 `business_type` 而不同：

| `business_type` | 條件 |
|---|---|
| `self_managed` | 有效的主要出租權源，謄本仍新鮮 |
| `rental_management` | 上一列條件，加上有效的委託管理合約涵蓋此單位 |
| `sublease` | 權源鏈條含已驗證的 `sublease_consent`，被授權方是本組織的包租業執業主體 |

合約撤回或拒簽時，案件回到 `authority_verified`。房東或經理人能在同一案件內擬新合約。

**委託管理案件（P1）：** `draft` → `signing` → `active` → `terminated` 或 `expired`。`active` 時，`management_contracts.status` 同步為 `active`。移交包被新組織接受時，舊案件轉 `terminated`。

**買賣案件（P2）：**

| 狀態 | 對應七段 | 進入條件 | 可回頭 |
|---|---|---|---|
| `pre_contract` | 簽約前 | 銷售委託合約完成簽章 | 是 |
| `contracted` | 簽約後 | 買賣合約完成，`trust_case_refs` 已登錄 | 是，解約走 `aborted` |
| `sealing` | 用印 | 建經回報價金入帳 | 是 |
| `tax_paid` | 完稅 | 地政士上傳完稅文件 | 是 |
| `transferred` | 過戶 | 地政士回報登記完成 | 否 |
| `handed_over` | 點交 | 點交紀錄雙方確認，撥款指示雙簽 | 否 |
| `closed` | 結案 | 收到建經的 `DisbursementExecuted` | 否 |

每段的文件待辦由 `stage_checklists` 設定表決定。七段的進入條件是本文件提議。實際順序必須與合作建經的流程對齊。

**繼承協調案件（P3）：** `opened` → `inventorying` → `coordinating` → `closed`。`opened` 時登錄死亡日，`computeDeadlines()` 產生兩個法定期限。平台只做協調，不代理送件。登記交地政士，申報交會計師。

**步驟分類：**

| 步驟 | 類別 | 失敗或反悔時的處理 |
|---|---|---|
| 送簽通知、到期提醒、換證提醒 | 可重試 | outbox 指數退避重試，冪等鍵為 outbox ID |
| 合約送簽 | 可補償 | 呼叫 `voidTask()` 撤回 |
| 文件收集：謄本、授權書、點交照片 | 可補償 | 標記版本作廢，要求重新上傳 |
| 入帳確認 | 可補償 | 用沖銷分錄更正，案件寫 `deposit_confirmation_reversed` 事件 |
| 已簽 PDF 與 Audit Trail File 保存 | 可重試 | outbox 重試，取代現行手動補抓 |
| 商工 API 查詢 | 可重試 | 受次數管制，排隊重試 |
| 對帳回寫 | 可重試 | 下一輪對帳再跑 |
| 撥款執行 | 不可回頭 | 執行前檢查所有前提，執行後只能用新的撥款指示處理 |
| 地政登記完成（P2） | 不可回頭 | 同上 |
| 結案通知 | 可重試 | outbox 重試 |

不可回頭步驟前，`decideCaseTransition()` 檢查全部前提。前提包含雙方簽署完成、謄本仍新鮮、鏡像帳餘額足夠。任一不符，轉移回傳 `null`，不寫 outbox。

**不全面事件溯源的理由。** 重播會重觸發對外訊息。讀端有最終一致性延遲。事後加入事件溯源很困難【中】（第一輪報告第 9 章）。案件的讀取需求多為目前狀態，狀態表直接滿足。

### 4.4 多租戶

第一版用 pool 模式加 PostgreSQL RLS。每張組織表都有 `org_id`，開 RLS，政策比對 session 變數。

```sql
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON contracts
  USING (org_id = current_setting('app.org_id', true)::text)
  WITH CHECK (org_id = current_setting('app.org_id', true)::text);
```

`current_setting(..., true)` 在變數未設定時回傳 NULL。比對 NULL 的結果是沒有任何列，所以忘記設定時預設拒絕。

**案件成員的跨組織存取。** 租客、房東、建經屬於別的組織，或沒有組織。案件範圍的表另加一條政策，允許案件成員讀取：

```sql
CREATE POLICY case_member_read ON contracts FOR SELECT
  USING (case_id IN (SELECT case_id FROM case_members
                     WHERE party_id = current_setting('app.party_id', true)::text
                       AND now() <@ valid_period));
```

這條政策只給 SELECT。案件成員的寫入一律走應用服務，由 `authorize()` 決定。委託管理合約掛在 `kind = management` 的案件，房東因此能讀代管業組織的委託資料。

**四個陷阱與對策：**

| 陷阱 | 後果 | 對策 |
|---|---|---|
| 超級使用者與 `BYPASSRLS` 角色不受 RLS 限制 | 應用用錯角色時，所有組織資料可見 | 應用連線用 `app_rw`，沒有 `BYPASSRLS`、不是 superuser。migration 用 `app_owner`。維運用 break-glass 角色，每次使用寫稽核事件 |
| 表擁有者預設不受 RLS 限制 | 擁有者角色執行的查詢繞過政策 | 每張表 `FORCE ROW LEVEL SECURITY`。應用角色不是擁有者。CI 查 `relrowsecurity` 與 `relforcerowsecurity`，任一組織表缺少就失敗 |
| 連線池讓 session 狀態外洩 | 上一個請求的 `app.org_id` 留在連線上 | 只用 `set_config('app.org_id', $1, true)`，作用範圍是交易。禁止 session 層級的 `SET`。PgBouncer 用 transaction 模式 |
| view 預設以擁有者權限執行 | view 繞過 RLS | 所有 view 設 `security_invoker = true`，CI 一併檢查 |

**跨組織滲透測試。** CI 建兩個組織的種子資料。測試以組織 A 的 context 呼叫每個 repository 方法，讀寫組織 B 的 ID。預期全部回傳空值或丟錯。新增表時沒有加測試，CI 失敗。

**全域登錄表。** `registry` schema 不掛組織 RLS。應用角色對它沒有直接讀寫權限，只能呼叫 `SECURITY DEFINER` 函式：

| 函式 | 用途 | 回傳範圍 |
|---|---|---|
| `registry.claim_unit()` | 登錄錨點與租賃單位 | 新建、附掛或需人工審核 |
| `registry.lookup_unit()` | 查錨點與單位 | 只回傳呼叫組織有權源或清冊的資料 |
| `registry.claim_entity()` | 認領執業主體 | 新建或需人工審核 |
| `registry.submit_practitioner()` | 登錄執業人員與任職 | 狀態與是否衝突 |
| `registry.check_exclusive()` | 專任衝突檢查 | 只回傳「有衝突」與衝突類型，不回傳另一家的名稱 |
| `registry.credential_status_at()` | 查某任職在某時點的狀態 | 只回傳呼叫組織的任職，平台審核員除外 |

衝突回應不得透露另一個組織。CI 的滲透測試要涵蓋這一點：組織 A 從任何 `registry` 函式都拿不到組織 B 的名稱、統編或人員。

**`vault` schema。** 見 4.11。

**企業版 database-per-tenant 的升級路徑：**

1. 第一天起每張表都有 `org_id`，獨立資料庫的 schema 與 pool 完全相同。
2. 控制平面的 `orgs.db_locator` 決定連線目標。`withTx()` 依此選連線池。
3. 搬遷時用 logical replication 或依 `org_id` 篩選匯出，搬完切換 `db_locator`。
4. 獨立資料庫使用組織專屬的加密金鑰。
5. migration 工具改成對所有資料庫依序執行，記錄每個資料庫的版本。
6. `registry` 留在控制平面。企業版資料庫只存錨點與執業人員 ID，查詢經 `registry` 函式。
7. 稽核 hash chain 本來就以組織為單位，可整條搬走，不需重算。

銀行或大型建經要求獨立資料與金鑰時，再提供企業版。金融業客戶的委外與雲端境內存放要求本次未查，提供企業版前必須查明。

### 4.5 權限

第一版用 RBAC 加 `case_members`。RBAC 管組織內的角色。`case_members` 管案件範圍的跨方關係。權限由「關係加動作」決定。

**組織內角色（RBAC）：**

| 角色 | 能做的事 |
|---|---|
| `org_owner` | 全部，含成員管理與方案設定 |
| `org_admin` | 物件、案件、文件、成員邀請、指派簽章的執業人員 |
| `staff` | 被指派案件的擬約、文件收集、點交 |
| `signing_practitioner` | 執業人員本人的簽章。只給已綁定執業人員的 user |
| `accountant` | 鏡像帳、入帳確認審核、報表 |
| `viewer` | 唯讀 |
| `platform_reviewer` | 平台組織專用：resim 核對、權源審核、錨點合併、入帳證明審核 |

**案件關係清單（`case_members.relation`）：**

| relation | 中文 | 階段 | 主要權限 |
|---|---|---|---|
| `landlord` | 房東 | P1 | 讀案件全部、簽合約、簽撥款指示、確認移交包 |
| `tenant` | 租客 | P1 | 讀合約、押金狀態、點交紀錄、權源標示，簽合約與結算單 |
| `co_tenant` | 共同承租人 | P1 | 同租客，但不能單獨簽撥款指示 |
| `practice` | 經理人的執業主體 | P1 | 依委託管理合約 `scope` 操作 |
| `practitioner` | 指派的執業人員 | P1 | 讀文件、簽章 |
| `sublessor` | 包租業或二房東 | P1 | 對轉租段有出租人權限 |
| `reviewer` | 平台審核員 | P1 | 讀權源證據與入帳證明，做審核決定 |
| `buyer`、`seller` | 買方、賣方 | P2 | 買賣案件的簽署、確認、查帳連結 |
| `broker` | 經紀業 | P2 | 銷售委託、文件清單，經紀人簽章 |
| `land_agent` | 地政士 | P2 | 上傳登記文件、更新完稅與過戶段 |
| `escrow` | 建經 | P2 | 推送入帳狀態、執行撥款 |
| `trust_officer` | 銀行信託經辦 | P2，待銀行書面回覆 | 讀撥款指示、入帳確認 |
| `heir` | 繼承人 | P3 | 讀清冊與期限、上傳文件 |
| `advisor` | 會計師、律師 | P3 | 讀被授權的文件 |
| `trust_bank` | 信託銀行 | P3 | 讀轉介資料 |

**代房東操作的閘門。** 代房東收租、保管押金、派工、協調糾紛屬代管業務（第二輪報告 6.6）。這類動作在 `Action` 定義上標 `operation_mode: 'on_behalf'`。`authorize()` 全部條件成立才放行：

1. 組織是 `practice`，執業主體的 `rental_management` 業別為 `verified` 或 `renewal_due`。
2. 執業主體至少有一位有效的專任管理人員。
3. 有效的委託管理合約涵蓋該單位。
4. 動作在委託管理合約的 `scope` 內。

v1 用 `orgs.licenses` 判斷。本版改查 M02 與委託管理合約。函詢結果出來後，只改動作的標記，不改程式結構。

**何時遷移 ReBAC（OpenFGA 或 SpiceDB）：**

1. 出現多層組織，例如集團、分店、團隊三層繼承。
2. 需要文件級共享，例如只把一份遺囑影本給某位律師看。
3. 需要反向查詢「誰能看這份文件」，例如回應個資查詢請求。
4. `relation` 超過 15 種，或客戶要求自訂角色。

上表在 Phase 3 是 16 種，已超過第 4 項的門檻。Phase 3 的文件級共享也會觸發第 2 項。因此 G2 前必須評估遷移。遷移前把 `authorize()` 保持為唯一入口，遷移只換它的實作。

### 4.6 身分驗證分級

四級與金融業數位身分驗證指引的四級風險同構【低】（第一輪報告第 9 章）。指引不指定方法對應哪一級。

| 等級 | 方法 | 建議適用動作（需法務確認） |
|---|---|---|
| 1 | Email 加 OTP、手機簡訊 | 瀏覽、看自己的合約、看押金狀態 |
| 2 | 手機 OTP 加證件影像與人工審核 | 一般住宅租約簽署、押金結算單簽署、執業人員開通與簽章。外籍租客用居留證加人臉比對 |
| 3 | 行動自然人憑證（LoA3）、自然人憑證、工商憑證 | 買賣合約簽署、送建經的撥款指示、修改收款帳戶、清冊的特種個資讀取 |
| 4 | 臨櫃或公證人面對面 | 不動產物權移轉、抵押權設定，本來就由地政士與地政機關處理 |

**「適用動作」欄沒有來源，是調研員與本文件擬定，必須由法務確認【低】。**

實作方式：

- session 記錄 `identity_level` 與驗證時間。
- 每個 `Action` 定義 `minIdentityLevel`。`requireIdentityLevel()` 不足時回傳「需要升級驗證」，前端導向對應流程。
- 撥款指示的 `required_identity_level` 傳給點點簽的簽署人驗證設定。`verify_methods` 支援 `email`、`sms`、`twca_mid`，可用種類依方案而定。
- 驗證等級寫進每筆稽核事件的 `actor_identity_level`。

行動自然人憑證的介接，民間平台可於啟用前一個月書面申請【高】。內政部審核，且不得再授權第三方【高】（第二輪報告 6.2）。BRD 排在 M1 送件。核准前，等級 3 只能用點點簽的 `twca_mid` 或延後上線。自然人憑證用戶身分確認服務限政府機關、金融業與行動寬頻業者【高】，平台不規劃使用。

### 4.7 稽核

**做法：**

1. append-only：`audit.events` 表的觸發器禁止 UPDATE 與 DELETE。
2. 獨立寫入角色：應用角色只能呼叫 `SECURITY DEFINER` 函式 `audit.append()`，不能直接 INSERT。
3. hash chain：`audit.append()` 在函式內鎖定該組織的鏈頭，計算 `hash = SHA-256(prev_hash || canonical_json(event))`。
4. 外部錨定：worker 每小時把所有組織的鏈頭組成 Merkle tree。樹根送 RFC 3161 時間戳記服務。時戳憑證存 `audit.anchors`。

只有 hash chain 擋不住有寫入權限的人重算整條鏈【低】。外部錨定把竄改的偵測時間縮到一個錨定週期內。錨定週期 1 小時是假設，依稽核要求調整。

`verifyChain()` 每日重算每條鏈並比對最近一次錨定。結果不一致時發出最高等級告警。

**稽核範圍：**

| 類別 | 動作範例 | 是否含讀取 | 階段 |
|---|---|---|---|
| 金流 | 入帳確認審核、分錄沖銷、撥款指示送出與執行 | 否 | P1 |
| 權限 | 成員授予與撤銷、角色變更、break-glass 使用 | 否 | P1 |
| 經理人驗證 | 商工查詢結果、resim 核對登錄、狀態轉移、衝突分流決定、標章顯示與撤下 | 否 | P1 |
| 簽章分流 | 套用的規則、送簽前檢查結果、指派的執業人員 | 否 | P1 |
| 敏感文件 | 謄本與證件原檔讀取、下載、`vault` 讀取 | 是 | P1 |
| 電子簽章同意 | 電子簽章法 §5 的告知與同意紀錄【高】 | 否 | P1 |
| 物件身分 | 錨點合併、出租權源驗證與撤銷、移交包封包與接受 | 否 | P1 |
| 合約 | 已簽 PDF 雜湊、Audit Trail File 保存結果 | 否 | P1 |
| 信託狀態 | 信託案件識別碼登錄、狀態更新、查帳連結產生 | 否 | P2 |
| 清冊 | 解析結果確認、贈與與繼承紀錄的讀取 | 是 | P3 |

清冊的贈與紀錄會被稅務與糾紛拿來當證據（第二輪報告 8.6）。P3 的保存與存取日誌必須按證據等級設計。

**與 ADR-0007 的關係。** ADR-0007 有三點不變：

- 合約歷程（`contract_events`）維持活動時間軸，不升級為稽核級紀錄。
- 簽署的法律舉證由點點簽 Audit Trail File 承擔。
- 平台不重做簽署過程的稽核。

ADR-0007 末段寫明，平台側稽核級紀錄屬新 effort，需重評。本文件的 AuditEvent 就是那個 effort。本文件建議新增 ADR 補充 ADR-0007 的範圍，不取代它。理由是 ADR-0007 對合約歷程的決定仍成立。範圍外的金流、驗證與權限，才需要新紀錄。這份補充 ADR 不在第 8 章清單內，列為後續題目。

### 4.8 文件庫

文件庫管謄本、授權書、證書、合約、匯款證明、點交照片與已簽 PDF。每份文件是一個邏輯文件，底下有多個版本。

**`documents`：**

| 欄位 | 說明 |
|---|---|
| `id`、`org_id` | |
| `kind` | 見下表 |
| `sensitivity` | `normal`、`restricted`、`special`。後兩者的檔案放 `vault` |
| `subject_type`、`subject_id` | 對應的錨點、租賃單位、出租權源、執業人員、案件或清冊 |
| `current_version_id` | 最新版本 |

**文件種類：**

| 階段 | `kind` | `sensitivity` |
|---|---|---|
| P1 | `transcript_class2`、`transcript_class1`、`authorization_letter`、`sublease_consent`、`trust_contract` | `normal` |
| P1 | `practice_permit`、`registration_cert`、`employer_consent` | `normal` |
| P1 | `practitioner_certificate`、`id_document` | `restricted` |
| P1 | `remittance_proof`、`handover_photo`、`signed_pdf`、`audit_trail` | `normal` |
| P2 | `sale_contract`、`tax_receipt`、`registration_result`、`escrow_statement` | `normal` |
| P3 | `bank_statement`、`passbook_image`、`title_deed`、`insurance_policy` | `restricted` |
| P3 | `will_copy`、`family_record` | `restricted` |
| P3 | `medical_record`、`guardianship_document` | `special` |

**`document_versions`：**

| 欄位 | 說明 |
|---|---|
| `id` | 主鍵 |
| `document_id` | |
| `storage_key` | 物件儲存的 key |
| `sha256` | 檔案雜湊，同文件下唯一 |
| `obtained_at` | 謄本的列印時間或授權書的簽署日，由使用者輸入並經審核 |
| `uploaded_at`、`uploaded_by` | |
| `source_channel` | `user_upload`、`agent_on_behalf`、`dottedsign` |
| `valid_until` | 依新鮮度規則計算 |
| `extracted` | 審核後的結構化欄位：建號、登記名義人（隱匿後）、限制登記 |
| `redaction_profile` | 對外顯示時套用的隱匿規則 |
| `delete_after` | 排定刪除日。證書影本與證件影像在驗證完成時設定 |
| `status` | `pending_review`、`accepted`、`rejected`、`superseded`、`deleted` |

**版本規則。** 新上傳的檔案一律是新版本，舊版本保留，狀態改 `superseded`。版本不可改。版本只在 `delete_after` 到期或保存期限屆滿時刪除，刪除寫稽核事件。

**證書影本與證件影像。** 證書影本屬個資，蒐集須有特定目的與必要性（第二輪報告 6.5）。平台只存證書種類、證號、發證日、效期、驗證日、驗證者與結果。影本於驗證完成後刪除，或遮罩身分證字號與地址。保存期限由平台依特定目的自訂，寫入隱私權政策，並由法務確認。

**取得時間與新鮮度。** 謄本反映的是列印當下的登記狀態。新鮮度規則依用途設定，存在 `document_freshness_rules` 表：

| 用途 | 規則 | 來源 |
|---|---|---|
| 出租權源驗證 | 謄本 `obtained_at` 距今不超過 N 天 | N 待產品與法務決定 |
| 撥款前檢查 | 撥款前要求重新取得謄本 | 第一輪報告第 8 章 |
| 授權書 | `valid_until` 為授權期間迄日 | 授權書內容 |
| 清冊項目 | `obtained_at` 超過 N 天時標 `stale` | N 待產品決定 |

**到期提醒。** worker 每日掃描 `valid_until` 在 30 天內的版本，經 M08 通知。授權書到期時，對應的出租權源轉為 `expired`，案件不能再送簽。30 天是假設。

**隱匿規則：**

| 規則 | 內容 | 信心 |
|---|---|---|
| 第二類謄本本身 | 已隱匿出生日期、部分姓名、部分統一編號 | 【高】 |
| 第二類但書 | 限制登記與非自然人的姓名及統一編號不在隱匿範圍 | 【高】 |
| 對外顯示物件 | 不顯示完整建號與登記名義人姓名 | BRD R13 的配套，需法務確認 |
| 原檔存取 | 只有權源相關方與審核員能讀，每次讀取寫稽核事件 | 本文件設計 |

第一類與第三類謄本限登記名義人或利害關係人申請【高】。平台預設只收第二類。收第一類時，`extracted` 不存出生日期。

**取得管道。** 謄本由使用者自行申請第二類並上傳【中】。平台不爬電子謄本系統【中】。平台以公司身分常態取得謄本的合法管道，是第一輪報告列的高影響缺口。

### 4.9 經理人驗證狀態機

驗證是開通經理人功能的前置條件（第二輪報告 6.5）。平台不讓未驗證者以經理人身分簽章或代操作。標章寫「證書資料已核對」，不得寫成平台保證其合法。

狀態機套在三個層級。三層用同一組狀態，各自轉移。

| 層級 | 實體 | 核對管道 |
|---|---|---|
| 執業主體與業別 | `practice_entities`、`practice_licenses` | 商工 API，加上許可與登記證的人工文件核對 |
| 證書 | `practitioners` | resim 證書查詢，平台審核員人工核對 |
| 任職 | `practitioner_employments` | resim 任職查詢，平台審核員人工核對 |

**狀態：**

| 狀態 | 中文 | 能否簽章與代操作 | 標章 |
|---|---|---|---|
| `pending` | 待驗證 | 否 | 不顯示 |
| `verified` | 已驗證 | 能 | 「證書資料已核對」加核對日 |
| `renewal_due` | 換證提醒 | 能，畫面加警示 | 同上，加換證期限 |
| `conflict_review` | 專任衝突分流中 | 否 | 不顯示 |
| `lapsed` | 已失效 | 否，停權 | 撤下 |
| `rejected` | 核對不符或衝突阻擋 | 否 | 不顯示 |

**轉移圖：**

```
  送出資料
     │
     ▼
  pending ──── 核對相符 ────► verified ──── 進入換證窗口 ────► renewal_due
   │   ▲                        │                                │
   │   │ 補件重送               │ 逾期、廢止、任職結束           ├─ 換證後重驗相符 ─► verified
   ▼   │                        ▼                                │
  rejected                    lapsed ◄── 逾期、廢止、任職結束 ───┘
   ▲                            │
   │ 管理人員衝突，阻擋         └──── 換證或新任職重送 ────► pending
   │
  conflict_review ◄──── pending、verified、renewal_due 偵測到另一家的有效任職
   │
   └──── 經紀人員加同意書，核對相符 ────► verified
```

**轉移表：**

| 目前狀態 | 事件 | 條件 | 下一狀態 | 平台動作 |
|---|---|---|---|---|
| 無 | `submitted` | 必填欄位齊全 | `pending` | 執業主體排商工 API 查詢；證書與任職排入審核佇列 |
| `pending` | `check_matched` | 審核員登錄 resim 結果相符，上層也已驗證 | `verified` | 顯示標章，排換證提醒 |
| `pending` | `check_mismatched` | 證號、姓名、效期或任職不符 | `rejected` | 通知經理人補件 |
| `rejected` | `resubmitted` | 補件 | `pending` | 重新排入佇列 |
| `pending`、`verified` | `conflict_detected` | `registry.check_exclusive()` 發現另一家的有效任職 | `conflict_review` | 停用簽章，通知雙方組織但不透露對方 |
| `conflict_review` | `conflict_resolved` | `cert_kind = rental_manager` | `rejected` | 管理人員專任無但書，阻擋（租賃條例 §25） |
| `conflict_review` | `consent_accepted` | 經紀人員，所屬業者同意書經核對 | `verified` | 記同意書版本（經紀條例 §16） |
| `verified` | `renewal_window_reached` | 今日不早於 `renewal_window_from` | `renewal_due` | 通知執業人員與所屬組織 |
| `renewal_due` | `renewed` | 新效期經 resim 核對相符 | `verified` | 更新 `valid_until` |
| `verified`、`renewal_due` | `expired` | 今日晚於 `valid_until` | `lapsed` | 停權，撤下標章 |
| `verified`、`renewal_due` | `revoked` | 重驗發現證書遭廢止 | `lapsed` | 同上 |
| `verified`、`renewal_due` | `employment_ended` | 任職異動或離職 | `lapsed`（任職層） | 同上，只影響該任職 |
| `lapsed` | `resubmitted` | 換證或新任職 | `pending` | 重新排入佇列 |

**上層與下層。** 簽章與代操作看的是組合狀態。`credentialStatusAt()` 回傳三層的組合：

1. 執業主體的對應業別為 `verified` 或 `renewal_due`。
2. 證書為 `verified` 或 `renewal_due`。
3. 任職為 `verified` 或 `renewal_due`，且 `valid_period` 涵蓋查詢時點。

三項都成立才是「可簽章」。任一層 `lapsed`，組合狀態就是不可簽章。

**重驗頻率。** 至少依證書效期重驗，並在換證窗口前提醒（第二輪報告 6.5）。管理人員異動後，業者須於 30 日內造冊報主管機關備查（租賃條例 §21）。平台據此要求經理人在任職異動後 30 日內更新任職資料。任職的定期重驗間隔設為 6 個月，是本文件提議。

**失效的連鎖影響。**

- 待執業人員簽章的合約：通知經理人改派。改派要撤回後重新送簽。
- 執業主體失去最後一位有效專任管理人員：該業別的代操作動作全部停用。
- 標章撤下時寫稽核事件，記錄原因與時間。

**實作。** `decideCredentialTransition()` 是純函式，比照 `decideTransition()` 的寫法。worker 每日掃描效期，產生 `renewal_window_reached` 與 `expired` 事件。審核員的 resim 核對經 `recordCredentialCheck()` 進入狀態機。

### 4.10 簽章分流規則表

簽章人依業別與文件類型決定。規則表是資料，存在 `signature_rules`，含版本。`routeSignatures()` 是純函式，只讀規則與輸入。

**租賃線（租賃條例 §32）：**

| 文件 `doc_kind` | 法定文件 | `self_managed` | `rental_management`（代管） | `sublease`（包租） | 依據 |
|---|---|---|---|---|---|
| `management` | 委託管理契約書 | 不適用 | 甲方房東、乙方代管業、專任管理人員 | 不適用 | §32 第 1 款【高】 |
| `lease` | 租賃契約書 | 甲方房東、乙方租客 | 甲方房東、乙方租客，不需管理人員 | 甲方包租業、乙方租客、專任管理人員 | §32 第 2 款【高】 |
| `condition_report` | 現況確認書 | 雙方 | 雙方，不需管理人員 | 雙方加專任管理人員 | §32 第 3 款【高】 |
| `handover_certificate` | 點交證明 | 雙方 | 雙方加專任管理人員 | 雙方加專任管理人員 | §32 第 4 至 6 款，依文義推得，以原條文為準 |
| `receipt` | 收據 | 出租人 | 出租人加專任管理人員 | 包租業加專任管理人員 | 同上。Phase 1 平台不產出收據 |
| `refund_certificate` | 退還證明 | 雙方 | 雙方加專任管理人員 | 雙方加專任管理人員 | 同上 |
| `settlement` | 押金結算單（平台文件） | 雙方 | 雙方 | 雙方 | 平台設計，不屬 §32 |

「雙方」指出租人與租客。包租時出租人是包租業。

**仲介線（經紀條例 §22，P2）：**

| 文件 | 簽章人 | 依據 |
|---|---|---|
| §22 所列文件，含委託契約書 | 當事人加經紀人 | §22。第 1、2 款不適用代銷 |

§22 的完整文件清單本輪未逐款核對。P2 動工前必須依原條文補齊此表。經紀營業員不在簽章人範圍，`eligibleSigners()` 只回傳 `cert_kind = broker`。

**送簽順序。** 執業人員、乙方、甲方。法規沒有規定順序，這是本文件提議。理由是執業人員先簽，送簽時的證照檢查與實際簽章時點最接近。證照若在送簽後失效，其他人還沒簽。

**送簽前檢查（`sendForSigning()`）：**

1. 由案件取得 `business_type`。代管看委託管理合約，包租看權源鏈條。
2. 查規則表，得到簽署階段。
3. 階段含執業人員時，檢查指派的人選。組合狀態必須可簽章。任職必須屬本組織的執業主體。`cert_kind` 必須符合業別。代管與包租要 `rental_manager` 且 `is_exclusive`。
4. 檢查各階段 email 不重複，見 4.1。
5. 凍結 `signer_plan`，寫 `signature_records` 的 `planned` 列，寫稽核事件 `signature.route`。
6. 寫 outbox，由 worker 呼叫 `createTask()`。

任一項不符，送簽被擋下，畫面列出原因。`renewal_due` 能簽，畫面顯示換證期限。

**簽章當下的再檢查。** 執業人員的 `signed` webhook 進來時，再查一次組合狀態。不符時，合約撤回並通知經理人改派。這種情況只會發生在送簽與簽章之間證照失效。

**點點簽的對應。** `POST /v1/sign_tasks` 的 `stages` 是陣列，`has_order` 預設依序簽署。三個簽署人對應三個 stage。`metadata` 能帶案件 ID 與規則版本，最多 10 組。

**PDF 版面。** 簽署欄目前只有房東與租客兩列，落點由 `signatureStampBaselines()` 推導。執業人員要加第三列，印姓名與證號。證號是否印在文件上，必須由法務確認。`signature-layout.ts` 的預設落點與 `SignatureField.signer` 同步改成三種角色。

**規則改版。** 規則改版時新增版本，不改舊版。已送簽的合約保留凍結的 `signer_plan`。

### 4.11 特種個資分區

醫療與監護文件屬特種個資，須書面同意（第二輪報告 8.3）。資產清冊、家族關係、病歷與意定監護文件會集中在一處。單一外洩的損害高於一般 SaaS（第二輪報告 8.7）。Phase 3 上線前就必須完成加密、存取日誌與資料分區。

| 面向 | 做法 |
|---|---|
| 位置 | `vault` schema 存中繼資料，檔案放獨立 bucket |
| 金鑰 | `vault` 用獨立金鑰。企業版用組織專屬金鑰 |
| 角色 | `app_rw` 對 `vault` 沒有權限。只能呼叫 `vault.issue_read_url()` |
| 讀取 | `vault.issue_read_url()` 檢查關係、驗證等級與同意紀錄，同交易寫稽核事件，回傳短效簽名網址 |
| 同意 | `special` 文件上傳前，必須有書面同意的文件版本。沒有同意紀錄時拒收 |
| 解析 | P3 的上傳解析在 worker 內執行。原檔留在 `vault`，只把結構化結果寫回清冊，狀態為待確認 |
| 外流 | `vault` 內容不進搜尋索引、通知內文、錯誤日誌與分析事件 |
| 刪除 | 依 `delete_after` 與保存期限刪除，刪除寫稽核事件 |

Phase 1 先建 `vault`，只放 `restricted` 的證件影像與證書影本。Phase 3 加 `special` 類別與同意檢查。先建分區的理由是 Phase 3 不用再搬既有敏感檔案。

## 5. 三階段的系統範圍

### 5.1 系統範圍時程

月份與 BRD 第 9 節的甘特圖對齊。一格是一個月，`^` 是關卡。

```
月份                              1    6     12    18    24    30    36
Phase 1
  遷移 PostgreSQL 與 RLS          ##
  M03 錨點、單位、重複偵測        ###
  M01 組織、身分、權限             ####
  M02 經理人驗證                   ####
  M11 稽核                         ####
  M10 商工 API                     ##
  M10 行動自然人憑證申請          ####
  M04 簽章分流、委託管理合約        ###
  M06 鏡像帳、押金台帳               ####
  M08 逾期與換證提醒                  ###
  M09 房東報表、總覽 v1                ####
  M03 移交包                           ####
  關卡 G1                                 ^
Phase 2
  M05 買賣七段、文件待辦                   ######
  M06 信託狀態、查帳連結                      ######
  M06 撥款指示交建經                          ######
  M03 自有房源、驗證標章                        #######
  關卡 G2                                             ^
Phase 3
  M07 特種個資類別與同意                               ######
  M09 全資產清冊、期限計算                             #########
  M10 上傳解析                                           #######
  M05 繼承協調、轉介                                         #########
  關卡 G3                                                            ^
```

遷移排在 M1 至 M2。組織與 RLS 是後面所有模組的前提。

### 5.2 每階段新增什麼

| 面向 | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| 新模組 | M01、M02、M06、M07、M08、M09、M11 | 無 | 無 |
| 既有模組加範圍 | M03 加錨點與權源鏈條。M04 加委託管理合約與簽章分流。M05 加租賃與委託管理案件 | M05 加買賣七段。M06 加信託狀態與撥款指示交建經。M04 加經紀人簽章 | M05 加繼承協調。M07 加 `special` 類別。M09 加清冊與期限 |
| 新實體 | 5 個新實體加 v1 的 14 個，見 3.1 | TrustCaseRef | AssetInventory、AssetItem、AssetDeadline |
| 新整合 | 點點簽多階段簽署、商工 API、resim 人工流程、憑證申請、圖資、時戳、通知 | 建經特約通路、對帳檔或推送、查帳連結 | 上傳解析 |
| 新使用者端 | 經理人後台、租客端、平台審核台 | 買賣方端、地政士與建經入口 | 高端客戶端、繼承人入口 |
| 關卡依賴 | G1：pilot 300 單位、付費證據、三個函詢回覆 | G2：建經或銀行書面同意查帳授權方式、經紀業合作 | G3：協作層不構成信託業與投顧的意見 |

### 5.3 Phase 1 預留的介面

這些介面在 Phase 1 就建好，值固定為 Phase 1 的預設。Phase 2 或 3 只加實作，不改 schema 與呼叫端。

| 預留項目 | 位置 | Phase 1 的值 | 啟用階段 | 現在預留的理由 |
|---|---|---|---|---|
| 信託案件識別碼 | `cases.trust_case_ref_id`、`deposit_confirmations.trust_case_ref_id`、`fund_statuses.trust_case_ref_id` | 一律為空 | P2 | 第二輪報告 7.6 要求 Phase 1 預留 |
| 款項狀態 | `fund_statuses` 表與 `fundStatus()` | 來源只有 `mirror_ledger` | P2 | 畫面只讀這張表，換來源時畫面不用改 |
| 入帳來源 | `DepositSource.source` 列舉 | 只實作 `manual_upload` | P2 | 轉接層的介面 Phase 1 就固定 |
| 押金保管 | `deposit_ledgers.custody` | `landlord_account` | 押金專戶修法或銀行產品出現時 | 提前觸發條件見 3.15 |
| 撥款執行者 | `disbursement_instructions.executor` | `landlord_self` | P2 | 結算單與 P2 撥款共用一個流程 |
| 案件種類 | `cases.kind`、`cases.anchor_id`、`cases.inventory_id` | `lease`、`management` | P2、P3 | 狀態機與成員表共用 |
| 案件關係 | `case_members.relation` 列舉 | 只開放 P1 的 7 種 | P2、P3 | RLS 政策不用改 |
| 簽章人角色 | `SignerRole` 加 `practitioner`，`signature_rules` 表 | 只有租賃線規則 | P2 加仲介線 | 合約狀態機只改一次 |
| 委託合約種類 | `management_contracts.kind` | `rental_management` | P2 加 `sale_mandate` | 經紀人簽章共用簽章分流 |
| 敏感分區 | `vault` schema 與 `documents.sensitivity` | 只有 `restricted` | P3 加 `special` | 不用再搬既有敏感檔案 |
| 證書核對管道 | `CredentialCheckSource.mode` | `manual_resim` | 批次核對核准後 | 換管道不改狀態機 |

### 5.4 每階段刻意不做的事

| 階段 | 不做 | 理由 |
|---|---|---|
| P1 | 代收租金、保管押金、平台名下帳戶 | 不持有資金。代收轉付屬電支條例文義範圍（第二輪報告 6.6） |
| P1 | 租賃押金信託 | 沒有銀行產品，需求不明確（第二輪報告 7.6） |
| P1 | resim 自動化查詢 | 驗證碼不能繞過，見 ADR-0015 |
| P2 | 平台代查信託帳戶 | 第三人查帳沒有法源【高】 |
| P2 | 引流分潤 | 是否構成居間未查到見解，函詢前不收（第二輪報告 7.4） |
| P3 | 投資、保險、信託建議 | 須持照【高】。畫面只呈現中性事實 |
| P3 | 代理登記與申報 | 交地政士與會計師（第二輪報告 8.3） |

## 6. 遷移計畫

### 6.1 現況

`db.ts` 用 `better-sqlite3`，所有函式同步執行。交易用 `db.transaction(() => {...})()`。函式以選用參數 `db?: Database.Database` 讓測試注入 in-memory DB。schema 用 `ensureSchema()` 的 `CREATE TABLE IF NOT EXISTS` 加補欄位，沒有 migration 工具。

PostgreSQL 的驅動都是非同步。改成非同步後，`applyDsEvent()`、`commitTransition()` 與它們的呼叫端全部要改。這是遷移工作量的主體。

### 6.2 步驟

| 步驟 | 內容 | 完成條件 | 月份 |
|---|---|---|---|
| 1 | 定義 repository 介面與 `withTx()`，仍以 SQLite 實作，介面一律回傳 Promise | 現有 vitest 全數通過 | M1 |
| 2 | 呼叫端改為 async。`decideTransition()` 等純函式不動 | route handler 不再直接 import `getDb()` | M1 |
| 3 | 選定 migration 工具，寫第一版 PostgreSQL schema | schema 涵蓋現有 5 張表加 `org_id`、`legacy_id` | M1 |
| 4 | 寫 PostgreSQL 版 repository。同一組 repository 測試對兩個實作各跑一次 | 兩個實作的測試結果相同 | M2 |
| 5 | 開 RLS 與 FORCE，建立 `app_rw`、`app_owner` 角色，加跨組織滲透測試 | CI 的 RLS 檢查與滲透測試通過 | M2 |
| 6 | 建 `registry`、`audit`、`vault` schema 與 `SECURITY DEFINER` 函式骨架 | 應用角色直接查詢這三個 schema 時被拒 | M2 |
| 7 | 寫一次性搬資料腳本：SQLite 匯出，掛預設組織，匯入 PostgreSQL | 每張表筆數相同，`fields` JSON 的雜湊相同 | M2 |
| 8 | `data/contract-files/` 的檔案搬到物件儲存，`rel_path` 改存 key | 每個檔案的 SHA-256 相同 | M2 |
| 9 | 切換正式環境到 PostgreSQL，SQLite 檔保留為唯讀備份 | 冒煙測試通過 | M2 |
| 10 | `SignerRole` 改為 `party_a`、`party_b`、`practitioner`，既有 `signature_fields.signer` 依對照表轉換 | 既有合約的 PDF 與簽名框位置不變 | M3 |
| 11 | 移除 SQLite 實作與 `better-sqlite3` 相依 | 切換後穩定 2 週 | M3 |

步驟 1 與 2 在 SQLite 上完成，不改資料庫就能驗證介面。

### 6.3 型別與語法對照

| SQLite 現況 | PostgreSQL | 注意 |
|---|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | ULID 主鍵加 `legacy_id integer` | 網址與外部引用改用 ULID |
| `TEXT` 存 JSON | `jsonb` | `fields`、`signature_fields`、`equipment` |
| `datetime('now', 'localtime')` | `timestamptz DEFAULT now()` | 舊資料是無時區字串，搬移時以 `Asia/Taipei` 解讀 |
| `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` | `seedEquipmentVocabulary()` |
| `PRAGMA table_info` 補欄位 | migration 工具 | `addColumnIfMissing()` 退場 |
| 同步交易 | `withTx()` 非同步交易 | 交易內不能呼叫外部 API |
| `signer: 'landlord' \| 'tenant'` | `signer: 'party_a' \| 'party_b' \| 'practitioner'` | 租賃合約 `landlord` 對 `party_a`，`tenant` 對 `party_b` |

### 6.4 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| 同步改非同步的連鎖修改超出估算 | 時程延後，M2 起的模組全部受影響 | 步驟 1 先量測呼叫點數量，再估工時 |
| 測試從 in-memory SQLite 改成 PostgreSQL 後變慢 | 開發回饋變慢 | 測試用 PGlite 或 testcontainers，每個測試用交易回滾隔離 |
| 時區：舊資料是 `localtime` 字串 | 時間位移 8 小時 | 搬移腳本明確以 `Asia/Taipei` 解讀，抽樣比對 |
| 交易內呼叫外部 API | 長交易與鎖等待 | 對外呼叫一律走 outbox，code review 檢查 |
| 忘記設定 `app.org_id` | 查不到資料，或在 `BYPASSRLS` 角色下外洩 | `withTx()` 是唯一取得交易的入口，政策預設拒絕 |
| `SignerRole` 改名波及 UI、PDF、點點簽轉換 | 既有合約顯示錯誤 | 步驟 10 獨立一個 PR，對既有合約做快照比對測試 |
| Next.js 16 的 server 與 route handler 行為和預期不同 | 連線池在 dev 熱重載時重複建立 | 動工前先讀 `node_modules/next/dist/docs/`，連線池掛在 `globalThis`，比照現有 `getDb()` |

現有資料量小，搬資料本身風險低。風險集中在程式碼的同步改非同步。

## 7. 取捨分析

### 7.1 與調研報告不一致之處

| 項目 | 報告 | 本文件 | 理由 |
|---|---|---|---|
| 入帳事件名稱 | 第一輪第 9 章：`TrustDepositConfirmed` | `DepositConfirmed` 加 `custody` 欄位 | Phase 1 押金進房東帳戶，沒有信託專戶 |
| 現有 webhook 是否已符合 inbox 思路 | 第一輪第 9 章：已符合 | 只符合同交易的一半 | 現有 route 沒有 inbox 表與去重鍵，檔案保存在交易外 |
| RLS 範圍 | 第一輪第 9 章只談組織隔離 | 加案件成員的 SELECT 政策 | 租客、房東、建經屬於別的組織，需要讀案件資料 |
| 產權錨點歸屬 | 未說明 | 放在全域 `registry` schema | 唯一鍵必須跨組織成立 |
| 租賃單位鍵值 | 錨點 ID 加單位後綴 | 主鍵用 ULID，錨點 ID 加後綴為唯一約束 | 待驗證錨點會合併，主鍵含錨點 ID 時外鍵全要改 |
| RLS 陷阱 | 三個 | 三個加 view 的 `security_invoker` | view 預設以擁有者權限執行 |
| ADR-0007 的處理 | 新增 ADR 取代它 | 新增 ADR 補充它的範圍 | ADR-0007 對合約歷程的決定仍成立 |
| 執業主體與人員的位置 | 第二輪 6.5 只列欄位 | 放在 `registry`，任職另開表 | 統編與證號跨組織唯一，專任衝突要跨組織偵測 |
| 驗證等級 | 第二輪 6.5：已驗證、待驗證、已失效三層 | 六個狀態：加換證提醒、專任衝突分流、核對不符 | 換證窗口與衝突分流的平台動作不同，要能分開查詢 |
| 簽章紀錄 | 第二輪 6.5：文件類型、簽章人、主體、時間、同意紀錄 | 加規則版本、證照快照、簽署順序 | 事後要能證明「當下為何由此人簽」 |
| 款項狀態 | 第二輪 7.6：預留欄位 | 預留欄位，另建 `fund_statuses` 讀取模型 | 畫面不用隨來源改寫 |

### 7.2 重大決策的選項與取捨

**決策 1：資料庫與組織隔離**

| 選項 | 優點 | 缺點 |
|---|---|---|
| A. PostgreSQL pool 加 RLS（採用） | 單一 schema、成本低、資料庫層強制隔離 | 四個陷阱需要紀律與 CI 檢查 |
| B. PostgreSQL schema-per-tenant | 隔離較直觀 | migration 要對每個 schema 執行，組織數上千時難管理 |
| C. database-per-tenant | 隔離最強、可用專屬金鑰 | 成本與維運最高，第一版不划算，留給企業版 |
| D. 繼續用 SQLite，在應用層過濾 `org_id` | 不用遷移 | 沒有 RLS，單檔寫入並行受限，備援弱 |

**決策 2：入帳確認的來源**

| 選項 | 優點 | 缺點 |
|---|---|---|
| A. 轉接層，多種來源統一成一個事件（採用） | 不押注單一銀行或建經，Phase 1 可上線 | 人工上傳的舞弊風險最高，需要審核人力 |
| B. 只接單一銀行的 API | 自動化程度高 | 企業信託專戶入帳通知 API 未查到 |
| C. 開放銀行 | 標準化 | 第三方服務提供者僅剩集保【低】 |

**決策 3：帳本**

| 選項 | 優點 | 缺點 |
|---|---|---|
| A. PostgreSQL 內的雙式分錄加約束（採用） | 與業務資料同交易，每日萬級以下足夠【中】 | 量級成長後要搬出 |
| B. 外部帳本服務 | 帳本能力完整 | 跨系統一致性要另外處理，多一個供應商 |
| C. 單式流水帳 | 實作最快 | 無法證明借貸平衡，沖銷不好表達 |

**決策 4：流程狀態**

| 選項 | 優點 | 缺點 |
|---|---|---|
| A. 狀態表加 append-only 事件表（採用） | 延續現有 `contract_events` 模式，讀取簡單 | 事件表與狀態表的一致性靠同交易 |
| B. 全面事件溯源 | 歷史完整、可重建任意時點 | 重播重觸發對外訊息、讀端延遲、事後難加入【中】 |
| C. 外部工作流程引擎（例如 Temporal） | 重試與補償機制完整 | 多一套基礎設施，團隊規模未知時負擔重 |

**決策 5：產權錨點的鍵**

| 選項 | 優點 | 缺點 |
|---|---|---|
| A. 地政複合鍵為唯一約束，主鍵用 ULID，全域登錄表（採用） | 跨組織唯一，合併時外鍵不動 | 全域表不掛 RLS，存取要經 `SECURITY DEFINER` 函式 |
| B. 複合鍵直接當主鍵 | 簡單 | 待驗證錨點沒有建號，重測後建號會變 |
| C. 門牌當主鍵 | 使用者容易提供 | 同址多戶、整編會變，地政與戶政版本不同【高】 |
| D. 每個組織各自的錨點表 | RLS 一致 | 同一建號在不同組織各一筆，移交與重複偵測失效 |

**決策 6：權限模型**

| 選項 | 優點 | 缺點 |
|---|---|---|
| A. RBAC 加 `case_members`（採用） | 實作快、好理解 | Phase 3 的文件級共享會膨脹 |
| B. 一開始就用 ReBAC（OpenFGA 或 SpiceDB） | 彈性最大、可反向查詢 | 多一個服務，與 RLS 的關係要另外設計 |
| C. 純 RBAC | 最簡單 | 每個案件一組角色，角色數爆炸【低】 |

**決策 7：稽核防竄改**

| 選項 | 優點 | 缺點 |
|---|---|---|
| A. append-only 加 hash chain 加外部錨定（採用） | 成本低，能偵測錨定點之後的竄改 | 錨定週期內的竄改要到下次錨定才偵測得到 |
| B. 只有 append-only | 最簡單 | 擋不住有寫入權限的人 |
| C. 寫入 WORM 儲存或外部稽核服務 | 防竄改最強 | 成本高，查詢不便 |

**決策 8：背景任務**

| 選項 | 優點 | 缺點 |
|---|---|---|
| A. PostgreSQL 的 inbox 與 outbox 加獨立 worker（採用） | 與狀態更新同交易，不多一套基礎設施 | 吞吐量上限受資料庫限制 |
| B. 訊息佇列（例如 SQS、RabbitMQ） | 吞吐量高 | 狀態更新與發訊息無法同交易，仍需 outbox |
| C. 在 Next.js route handler 內直接執行 | 最簡單 | 請求結束後任務可能中斷，重試要自己做 |

**決策 9：經理人驗證的方式**

| 選項 | 優點 | 缺點 |
|---|---|---|
| A. 商工 API 加 resim 人工核對加狀態機（採用） | 合法可行，Phase 1 能上線 | 需要審核人力，有核對延遲 |
| B. 程式化爬取 resim | 自動 | 要繞過圖形驗證碼，平台不可用程式繞過 |
| C. 只收證書影本，不核對 | 最省人力 | 無法發現偽造或失效，連帶責任風險高 |
| D. 等內政部核准批次核對再開通 | 自動且合法 | 核准時間未知，阻塞 G1 |

**決策 10：簽章人綁定**

| 選項 | 優點 | 缺點 |
|---|---|---|
| A. 綁定執業人員，送簽前查證照（採用） | 符合 §32 與 §22 的簽章人規定 | 合約狀態機與 `SignerRole` 要改 |
| B. 綁定組織負責人 | 不用改簽署人模型 | 負責人不一定有證書，不符簽章義務 |
| C. 由經理人自行在補充合約填寫人員資料 | 不用改程式 | 無法檢查證照，平台失去舉證能力 |

**決策 11：執業人員資料的位置**

| 選項 | 優點 | 缺點 |
|---|---|---|
| A. 放 `registry`，經 `SECURITY DEFINER` 函式存取（採用） | 證號跨組織唯一，專任衝突能偵測 | RLS 例外路徑變多，要逐一審查 |
| B. 每個組織各自一份 | RLS 一致 | 同一人掛兩家時偵測不到，專任規則失效 |
| C. 外部身分服務 | 隔離最清楚 | 多一個服務，台灣證照資料沒有現成服務 |

**決策 12：特種個資的存放**

| 選項 | 優點 | 缺點 |
|---|---|---|
| A. 同一資料庫的 `vault` schema 加獨立 bucket 與金鑰（採用） | 存取路徑獨立，仍能與稽核同交易 | 資料庫被整體入侵時仍在同一實例 |
| B. 獨立資料庫或獨立服務 | 隔離最強 | 跨資料庫交易，稽核一致性難做 |
| C. 與一般文件同區，只靠欄位加密 | 最簡單 | 存取控制與一般文件混在一起 |

## 8. 候選 ADR 草稿

下列 7 份狀態都是 Proposed。它們只存在本文件，不寫進 `docs/adr/`。使用者審閱通過後，再依 `docs/adr/` 的格式轉成正式 ADR。ADR-0010 至 ADR-0014 是 v1 的草稿，本版更新依據與後果。

### ADR-0010：PostgreSQL 與 RLS 多租戶

**Status:** Proposed
**Date:** 2026-10-29，2026-10-30 更新
**Deciders:** 待定（產品負責人、技術負責人）

#### Context

現有資料庫是 SQLite 單檔，沒有帳號與資料隔離（ADR-0002）。平台要服務多家經理人、多屋房東、建經與高端客戶。BRD 風險 R14 指出多租戶隔離失效的影響為高。SQLite 沒有 RLS，單檔寫入並行受限，備援與時點復原弱（第一輪報告第 9 章）。團隊規模未知，不適合一開始就管理多個資料庫。

#### Decision

資料庫換成 PostgreSQL，採 pool 模式。每張組織表有 `org_id`，啟用並強制 RLS。應用以交易範圍的 `set_config('app.org_id', ..., true)` 傳遞組織。案件範圍的表另加案件成員的 SELECT 政策。跨組織唯一的資料放 `registry` schema，只經 `SECURITY DEFINER` 函式存取。企業版保留 database-per-tenant 的升級路徑。

#### Options Considered

| 面向 | A. PG pool 加 RLS | B. schema-per-tenant | C. database-per-tenant | D. SQLite 加應用層過濾 |
|---|---|---|---|---|
| 複雜度 | 中 | 中高 | 高 | 低 |
| 成本 | 低 | 低 | 高 | 最低 |
| 擴展性 | 組織數上萬可行 | 組織數上千後 migration 難管 | 每組織獨立擴展 | 單檔寫入瓶頸 |
| 團隊熟悉度 | 需學 RLS 陷阱 | 一般 | 需要多資料庫維運 | 已熟悉 |
| 隔離強度 | 資料庫層強制 | 資料庫層，靠 `search_path` | 實體隔離 | 只靠應用程式碼 |

**選項 A 優點：** 一份 schema，一次 migration。隔離由資料庫強制。
**選項 A 缺點：** 超級使用者、表擁有者、連線池、view 四個陷阱需要 CI 守住。
**選項 C 優點：** 能給銀行專屬金鑰與獨立備份。
**選項 C 缺點：** 第一版客戶數少，成本不划算。

#### Trade-off

選 A 等於用紀律換成本。RLS 陷阱都有已知對策，能寫成 CI 檢查。C 的隔離最強，但只有銀行與大型建經需要。A 的 schema 從第一天就含 `org_id`，日後搬到 C 不需改 schema。

#### Consequences

- 變容易：新增組織只要一列資料。跨組織滲透測試能自動化。
- 變困難：每張新表都要記得 RLS 與 FORCE。view 要設 `security_invoker`。`registry` 要另走 `SECURITY DEFINER` 函式。同步改非同步波及所有呼叫端。
- 要重看：組織數或單一組織的資料量造成鄰居干擾時，評估把大組織搬到 C。

#### Action Items

1. [ ] 定義 `app_rw`、`app_owner`、break-glass 三個角色。
2. [ ] CI 加 RLS 與 FORCE 檢查、view 的 `security_invoker` 檢查。
3. [ ] CI 加跨組織滲透測試，涵蓋 `registry` 函式。
4. [ ] 在 `GLOSSARY.md` 加「組織」，識別字用 `org`。

### ADR-0011：不持有款項與入帳確認轉接層

**Status:** Proposed
**Date:** 2026-10-29，2026-10-30 更新
**Deciders:** 待定（產品負責人、技術負責人、法務）

#### Context

資金一經手，就落入信託業法、電支條例、洗錢防制法或租賃條例的管制【高】。平台不持有任何一方的款項。Phase 1 押金進房東帳戶。Phase 2 價金進建經的信託專戶。企業信託專戶入帳通知 API 未查到，合作契約型態也未公開（第二輪報告 7.4）。第三人查帳沒有法源（第二輪報告 7.3）。

#### Decision

程式碼沒有任何轉帳或撥款的路徑。入帳狀態由轉接層統一成 `DepositConfirmed` 事件。來源為人工上傳、對帳檔、建經推送、銀行推送，各自實作 `DepositSource`。所有外部訊息先寫 inbox，以 `(source, external_id)` 去重。事件處理與案件狀態、鏡像帳、款項狀態、outbox 在同一交易內完成。撥款由雙方電子簽署指示，交建經或房東執行，結果經同一轉接層回到平台。查帳只提供連結，導向銀行或建經頁面。

#### Options Considered

| 面向 | A. 轉接層加多種來源 | B. 只接單一銀行 API | C. 開放銀行 | D. 平台自己收款再撥付 |
|---|---|---|---|---|
| 複雜度 | 中 | 中 | 高 | 高 |
| 成本 | 低，人工審核需人力 | 依銀行報價 | 需第三方服務提供者資格 | 需牌照 |
| 擴展性 | 新來源只加一個 adapter | 換銀行要重寫 | 受授權範圍限制 | 受牌照限制 |
| 團隊熟悉度 | 一般 | 依銀行規格 | 低 | 低 |
| 法規風險 | 低，待函詢 | 低 | 中 | 高，信託業法、電支條例【高】 |
| Phase 1 可上線 | 可 | 不可 | 不可 | 不可 |

**選項 A 優點：** 不押注單一銀行或建經。Phase 1 用人工上傳就能上線。
**選項 A 缺點：** 人工上傳的舞弊風險最高，必須人工審核。
**選項 D 缺點：** 直接落入牌照管制，與定位衝突。

#### Trade-off

A 用人工審核成本換上線時程與來源中立。建經特約成立後，`recon_file` 與 `escrow_push` 只有差異列需要人工審核。D 體驗最好，但與平台定位與法規結論衝突，不考慮。

#### Consequences

- 變容易：換建經或加銀行只加一個 adapter。重複的外部訊息不會重複入帳。
- 變困難：人工審核需要介面、人力與 SLA。函詢若認定撥款指示屬代理收付，撥款指示流程要改。
- 要重看：取得建經或銀行規格後，重估對帳頻率與差異處理流程。

#### Action Items

1. [ ] 建 `inbox_messages` 表，點點簽 webhook 先改走 inbox。
2. [ ] 實作 `manual_upload` adapter 與審核介面。
3. [ ] 建 `fund_statuses` 與 `trust_case_ref_id` 預留欄位。
4. [ ] 向僑馥、第一建經索取特約申請文件，詢問狀態推送或對帳檔規格。

### ADR-0012：鏡像帳與沖銷

**Status:** Proposed
**Date:** 2026-10-29，2026-10-30 更新
**Deciders:** 待定（技術負責人、會計顧問）

#### Context

房東與經理人需要說明押金與租金的去向（BRD 第 4 節）。平台不持有款項，真相在銀行。平台要記一份能和銀行對帳、且事後不能被改的副本。押金結算要能算清楚扣抵與返還。G3 時每月分錄估計約 16,000 筆，每日在萬級以下。

#### Decision

鏡像帳用 PostgreSQL 內的雙式分錄。分錄只增不改，更正用沖銷分錄。每筆分錄以 `(business_event_type, business_event_id)` 唯一關聯一個業務事件。借貸平衡用延遲約束觸發器在提交時檢查。UPDATE 與 DELETE 由觸發器禁止，應用角色也撤銷權限。押金台帳是鏡像帳上的視圖，不存餘額。買賣價金不記鏡像帳，只記款項狀態。

#### Options Considered

| 面向 | A. PG 雙式分錄加約束 | B. 外部帳本服務 | C. 單式流水帳 | D. 可更新的餘額表 |
|---|---|---|---|---|
| 複雜度 | 中 | 中 | 低 | 低 |
| 成本 | 低 | 依廠商計價 | 低 | 低 |
| 擴展性 | 每日萬級以下足夠【中】 | 高 | 中 | 中 |
| 團隊熟悉度 | 需懂複式簿記 | 需學廠商 API | 高 | 高 |
| 可稽核性 | 高 | 高 | 低 | 最低，歷史被覆寫 |
| 與業務同交易 | 可 | 不可 | 可 | 可 |

**選項 A 優點：** 與案件狀態同交易，不會出現狀態已推進但帳沒記的情況。
**選項 A 缺點：** 量級成長後要搬出資料庫或拆分。
**選項 B 缺點：** 跨系統一致性需要另一套 outbox 與對帳。

#### Trade-off

A 用日後可能的搬遷成本，換現在的一致性與低成本。B 的能力較完整，但現在的量級用不到。C 與 D 寫得快，但無法證明借貸平衡，也無法表達沖銷。

#### Consequences

- 變容易：押金台帳、房東報表、移交包的錢段都從同一份分錄產生。
- 變困難：任何金額更正都要兩筆分錄。介面要讓使用者看懂沖銷。
- 要重看：每日分錄超過 1 萬筆，或需要多幣別時，評估選項 B。

#### Action Items

1. [ ] 定義科目編碼規則與押金案件的分錄範本。
2. [ ] 實作延遲約束觸發器與禁止更新觸發器，加測試。
3. [ ] Phase 2 前實作每日對帳與 `recon_exceptions` 流程。

### ADR-0013：案件 orchestrator 不採全面事件溯源

**Status:** Proposed
**Date:** 2026-10-29，2026-10-30 更新
**Deciders:** 待定（技術負責人）

#### Context

一筆租賃從擬約到押金結算，跨越房東、租客、經理人。一筆買賣跨越買賣方、經紀業、地政士、建經。現有 `transitions.ts` 只管單一合約的狀態機。現有模式是純函式 `decideTransition()` 加同交易的 `commitTransition()`，狀態與 `contract_events` 一起寫入（ADR-0007）。流程裡有撥款與過戶這類不可回頭的步驟。

#### Decision

案件用「狀態表加 append-only 事件表」。純函式 `decideCaseTransition()` 決定下一狀態、事件與 outbox 任務，`dispatch()` 在同一交易寫入。用 `state_version` 做樂觀鎖。步驟分為可補償、不可回頭、可重試三類，不可回頭步驟前檢查全部前提。租賃、委託管理、買賣、繼承四種案件共用同一張表與同一個 `dispatch()`，狀態表各自定義。

#### Options Considered

| 面向 | A. 狀態表加事件表 | B. 全面事件溯源 | C. 外部工作流程引擎 |
|---|---|---|---|
| 複雜度 | 低 | 高 | 中高 |
| 成本 | 低 | 中 | 多一套基礎設施 |
| 擴展性 | 單一資料庫內足夠 | 高 | 高 |
| 團隊熟悉度 | 高，延續現有模式 | 低 | 低 |
| 重播風險 | 無重播 | 重播會重觸發對外訊息【中】 | 引擎處理 |
| 讀取 | 直接讀狀態 | 讀端最終一致性延遲【中】 | 需查引擎 |

**選項 A 優點：** 延續 `transitions.ts` 與 `contract_events` 的寫法，純函式好測。
**選項 A 缺點：** 狀態表與事件表一致性完全依賴同交易。
**選項 C 優點：** 重試、計時器、補償都由引擎提供。

#### Trade-off

A 放棄「從事件重建任意時點」的能力。案件的讀取需求多為目前狀態，這個能力的價值低。事件表仍保存完整歷史，稽核與除錯足夠。C 的機制完整，但團隊規模未知，多一套基礎設施的負擔不划算。

#### Consequences

- 變容易：新增案件種類只加狀態表與純函式測試。
- 變困難：計時器類需求要由 worker 排程掃描。例如押金逾期未入帳、換證窗口、繼承期限。
- 要重看：買賣七段上線後，若計時器與補償規則超過 20 條，評估選項 C。

#### Action Items

1. [ ] 定義租賃與委託管理案件的狀態表與事件型別，寫純函式測試。
2. [ ] 實作 `dispatch()` 與 outbox，把已簽 PDF 保存改成 outbox 任務。
3. [ ] 定義每個不可回頭步驟的前提檢查清單。

### ADR-0014：產權錨點複合鍵與租賃單位 ID

**Status:** Proposed
**Date:** 2026-10-29，2026-10-30 更新
**Deciders:** 待定（產品負責人、技術負責人）

#### Context

現有 `properties` 只有名稱與地址，無法判斷兩筆物件是否為同一產權。門牌同址多戶、整編會變，地政與戶政版本可能不同【高】。建號只在地段內唯一【高】。分租套房沒有官方房間級識別碼。經理人更換時，同一單位要能跨組織延續。BRD 風險 R08 的配套是用資料錨點與移交包做差異化。BRD 風險 R13 要求不爬謄本、對外不顯示完整建號。

#### Decision

產權錨點的業務唯一鍵是「縣市＋鄉鎮市區＋段小段＋建號（含分號）」，用地政編碼存放。主鍵用 ULID。錨點放在全域 `registry` schema，不掛組織 RLS，只經 `SECURITY DEFINER` 函式存取。沒有建號時以 `pending_verification` 登錄，附門牌與座標。租賃單位主鍵用平台自發 ULID，`(anchor_id, suffix)` 為唯一約束，`0000` 代表整戶。重複偵測分硬性層與軟性層。所有權與管理關係由出租權源鏈條與委託管理合約表達，不寫在錨點上。

#### Options Considered

| 面向 | A. 複合鍵唯一約束加 ULID，全域表 | B. 複合鍵當主鍵 | C. 門牌當主鍵 | D. 每組織各自的錨點表 |
|---|---|---|---|---|
| 複雜度 | 中 | 低 | 低 | 低 |
| 成本 | 低 | 低 | 低 | 低 |
| 擴展性 | 高，合併不動外鍵 | 重測時外鍵全改 | 整編時失效 | 跨組織無法比對 |
| 團隊熟悉度 | 需理解地政編碼 | 同左 | 高 | 高 |
| 唯一性 | 跨組織硬性唯一 | 跨組織硬性唯一 | 同址多戶無法區分 | 只在組織內唯一 |
| 移交支援 | 可 | 可 | 弱 | 不可 |

**選項 A 優點：** 一個建號只有一筆錨點，移交與重複偵測都成立。
**選項 A 缺點：** 全域表打破「每張表都掛 RLS」的一致性，存取規則要另外審查。
**選項 D 優點：** 與其他表一樣掛 RLS。
**選項 D 缺點：** 同一建號在不同組織各一筆，R08 的差異化失效。

#### Trade-off

A 用一個例外的存取路徑，換跨組織唯一性。例外集中在 `registry` 的少數函式，能逐行審查。B 在待驗證與重測時會碰到改主鍵的問題。

#### Consequences

- 變容易：同一單位換經理人時，資料延續到新組織。疑似重複能在登錄當下發現。Phase 3 清冊的不動產能引用同一個錨點。
- 變困難：第二個組織登錄同一建號時，介面只顯示「需人工審核」。介面不能透露另一個組織。錨點合併需要審核流程，每次合併寫稽核事件。
- 要重看：分租套房的輔助鍵。電號、水號是否可用，報告建議另查。

#### Action Items

1. [ ] 取得縣市、鄉鎮市區、段小段的地政編碼表，定義更新方式。
2. [ ] 實作 `registry.claim_unit()` 與 `registry.lookup_unit()`，加安全審查。
3. [ ] 定義軟性重複偵測的地址正規化規則與審核介面。
4. [ ] 在 `GLOSSARY.md` 加「產權錨點」與「租賃單位」。

### ADR-0015：經理人驗證採人工核對加狀態機，不做自動化爬取

**Status:** Proposed
**Date:** 2026-10-30
**Deciders:** 待定（產品負責人、技術負責人、法務）

#### Context

BRD 風險 R06 指出，無照者以經理人身分接案時，平台可能被追連帶責任。法條直接寫明連帶責任的只有租賃條例 §13 的廣告媒體。平台為無照者撮合的裁罰或函釋未查到【低】（第二輪報告 6.5）。報告的結論是驗證必須作為開通經理人功能的前置條件。

可用的查驗管道有三個（第二輪報告 6.2）：

- 商工登記 API：只證明公司存在、狀態與營業項目，不能證明許可或證書【高】。須填使用告知書、IP 白名單，有次數管制【高】。
- resim：能以姓名或證號查管理人員與經紀人員的證書與任職。查詢頁附圖形驗證碼，自動化須向內政部地政司申請。
- 證書影本：經理人自行上傳。

證書有效期 4 年。管理人員期滿前 6 個月內換證。專任規定分兩條線（第二輪報告 6.3）。管理人員不得同時受僱於兩家。經紀人員經所屬業者同意，能為他家執行業務。

#### Decision

經理人驗證由三部分組成：

1. 執業主體：商工 API 自動查公司狀態與營業項目。許可與登記證由平台審核員人工核對文件。
2. 執業人員與任職：平台審核員在 resim 人工查詢，把結果登錄成 `credential_checks`。系統不爬取 resim，不繞過驗證碼。
3. 狀態機：六個狀態涵蓋待驗證、已驗證、換證提醒、專任衝突分流、已失效、核對不符。worker 每日依效期產生轉移事件。簽章與代操作只認組合狀態。

核對管道做成 `CredentialCheckSource`。內政部核准批次核對後，加 `resim_batch` 實作，狀態機不改。標章文字固定為「證書資料已核對」加核對日。

#### Options Considered

| 面向 | A. 人工核對加狀態機 | B. 程式化爬取 resim | C. 只收影本不核對 | D. 等批次核對核准 |
|---|---|---|---|---|
| 複雜度 | 中 | 中，驗證碼會變 | 低 | 低 |
| 成本 | 審核人力 | 低 | 最低 | 低 |
| 擴展性 | 執業人員數百位可行 | 高 | 高 | 高 |
| 團隊熟悉度 | 高 | 中 | 高 | 高 |
| 合法性 | 可行 | 不可，平台不可用程式繞過驗證碼 | 可行 | 可行 |
| 偵測偽造與失效 | 可 | 可 | 不可 | 可 |
| Phase 1 可上線 | 可 | 不採用 | 可 | 時間未知 |

**選項 A 優點：** 合法、Phase 1 能上線、能發現失效與專任衝突。
**選項 A 缺點：** 每位執業人員要人工核對，換證與重驗也要人工。
**選項 B 缺點：** 繞過驗證碼，與報告結論衝突。
**選項 C 缺點：** 無法支撐「證書資料已核對」標章，連帶責任風險高。

#### Trade-off

A 用審核人力換合法性與時程。G3 時估計約 150 位執業人員，加上每 6 個月的任職重驗，人工量在能負擔的範圍。量級超過時，以批次核對申請結果決定下一步。狀態機與核對管道分開，所以換管道只換 adapter。

#### Consequences

- 變容易：證照失效、換證、專任衝突都有明確的系統行為。標章文字與狀態綁定，不會誤寫成保證。
- 變困難：需要審核台介面與審核員 SLA。開通有延遲，pilot 期要先排好審核人力。專任衝突的通知不得透露另一家。
- 要重看：內政部核准批次核對時；或待審件積壓超過 3 個工作天時。3 個工作天是假設。

#### Action Items

1. [ ] M1 向內政部地政司書面申請 resim 批次核對。
2. [ ] 實作 `decideCredentialTransition()` 純函式與轉移表測試。
3. [ ] 實作平台審核台：resim 核對登錄、衝突分流、同意書核對。
4. [ ] 申請商工 API 使用，設定 worker 固定出口 IP。
5. [ ] 法務確認證書影本保存期限與標章文字。
6. [ ] 在 `GLOSSARY.md` 加「經理人」「執業主體」「執業人員」。

### ADR-0016：簽章人綁定執業人員而非組織負責人

**Status:** Proposed
**Date:** 2026-10-30
**Deciders:** 待定（產品負責人、技術負責人、法務）

#### Context

租賃條例 §32 列六種文件，由業者指派專任管理人員簽章。第 1 款不適用包租，第 2、3 款不適用代管【高】（第二輪報告 6.4）。經紀條例 §22 要求委託契約書等文件由經紀人簽章。電子簽約流程必須依業者類型分流，簽章欄位綁定專任管理人員。

現有系統的簽署人固定兩位。`SignerRole` 只有 `landlord` 與 `tenant`。合約狀態機六態，簽署順序固定租客先、房東後（ADR-0006、`docs/domain-model.md`）。點點簽 `POST /v1/sign_tasks` 的 `stages` 是陣列，能放三位以上簽署人。

#### Decision

1. 簽章人是執業人員本人，以任職關係連到執業主體。組織負責人不自動成為簽章人。
2. 簽章分流用規則表決定，規則表含版本，見 4.10。
3. `SignerRole` 改為 `party_a`、`party_b`、`practitioner`。租賃合約畫面仍顯示房東與租客。
4. 合約狀態機加一態 `awaiting_practitioner`。簽署順序是執業人員、乙方、甲方。規則不需執業人員時，直接從 `draft` 進 `awaiting_tenant`。
5. 送簽前查 M02 的組合狀態，簽章當下再查一次。每位簽章人寫一列 `signature_records`，含證照快照與規則版本。

本決定修訂 ADR-0006 的「狀態機維持六態」。修約仍走撤回後衍生，ADR-0006 其餘內容不變。

#### Options Considered

| 面向 | A. 加一態 `awaiting_practitioner` | B. 狀態一般化為 `signing` 加階段序號 | C. 執業人員另開第二個簽署任務 | D. 綁定組織負責人 |
|---|---|---|---|---|
| 複雜度 | 中 | 高 | 中 | 低 |
| 既有資料 | 舊狀態識別字保留 | 舊狀態要搬移 | 不動 | 不動 |
| 擴展性 | 第四種簽署人時要再加態 | 任意人數 | 每多一人多一個任務 | 不需擴展 |
| 團隊熟悉度 | 高，延續現有寫法 | 中 | 高 | 高 |
| 法規符合 | 符合 | 符合 | 簽章與當事人簽名分在兩份 PDF | 負責人不一定有證書，不符 |
| 測試影響 | 加一組轉移測試 | 重寫轉移測試 | 加任務關聯測試 | 無 |

**選項 A 優點：** 改動集中，舊合約的狀態不用搬。
**選項 A 缺點：** 未來出現第四種簽署人時，要再加一態。
**選項 B 優點：** 一次解決任意人數。
**選項 B 缺點：** 既有 UI、清單篩選、工作台待辦全部依狀態識別字運作，改動面最大。
**選項 C 缺點：** 同一份文件有兩份 PDF，舉證時要對齊兩份。

#### Trade-off

A 用「未來可能再加態」換現在的改動面小。§32 與 §22 的簽章人都是業者指派的執業人員。三位簽署人涵蓋 Phase 1 與 Phase 2。B 的彈性目前用不到。D 最省事，但違反簽章人規定，不考慮。

執業人員先簽是本文件提議，法規沒有規定順序。執業人員先簽，證照檢查與實際簽章最接近。若法務要求其他順序，只改規則表的 `stage_order`，狀態機的態名要跟著調整。

#### Consequences

- 變容易：每份文件都能回答「當下由誰、依哪條規則、憑哪張證書簽章」。經紀人簽章在 Phase 2 只加規則列。
- 變困難：`transitions.ts`、`signing.ts`、`dottedsign.ts`、`signature-layout.ts`、`pdf-layout.ts`、合約清單與工作台都要改。既有 `signature_fields.signer` 要轉換。同一人兼任甲方代表與執業人員時，webhook 去重鍵會撞，見 4.1。
- 要重看：出現第四種簽署人，或法務指定不同簽署順序時，評估選項 B。

#### Action Items

1. [ ] 用 `dottedsign-api` MCP 與 sandbox 確認同一 email 能否出現在兩個 stage。
2. [ ] 用 sandbox 確認三個 stage 的 webhook 事件內容。
3. [ ] 定義 `signature_rules` 的第一版資料與 `routeSignatures()` 測試。
4. [ ] 修改 `decideTransition()`，加 `awaiting_practitioner` 的轉移測試。
5. [ ] 簽署欄版面加執業人員列，法務確認是否印證號。
6. [ ] 更新 `docs/domain-model.md` 的狀態機與 ADR-0006 的修訂註記。

## 9. 隨規模要重看的事

| 項目 | 觸發條件 | 要重看什麼 |
|---|---|---|
| 1. 鏡像帳的位置 | 每日分錄超過 1 萬筆，或需要多幣別 | 拆出獨立帳本資料庫或改用外部帳本服務（ADR-0012） |
| 2. 組織隔離模式 | 第一家銀行或大型建經要求獨立資料與金鑰，或單一組織造成鄰居干擾 | 啟動 database-per-tenant，驗證搬遷腳本與多資料庫 migration（ADR-0010） |
| 3. 權限模型 | Phase 3 的文件級共享上線，或 `relation` 超過 15 種 | 遷移到 OpenFGA 或 SpiceDB，`authorize()` 換實作（4.5）。依 4.5 的清單，G2 前就會到門檻 |
| 4. 背景任務吞吐量 | outbox 積壓超過 5 分鐘，或 inbox 每秒超過 100 筆 | 引入訊息佇列，outbox 改成轉送到佇列 |
| 5. 稽核錨定週期與保存 | 客戶或主管機關要求更短的竄改偵測時間，或稽核表超過 1 億筆 | 縮短錨定週期、分割稽核表、評估 WORM 儲存 |
| 6. 證照核對人力 | 待審件積壓超過 3 個工作天，或執業人員超過 500 位 | 依批次核對申請結果加 `resim_batch`，或增加審核員（ADR-0015） |
| 7. 商工 API 次數 | 每日查詢接近配額 | 拉長快取時間，只在效期與重驗時重查 |
| 8. 簽署人模型 | 出現第四種簽署人，或法務指定不同順序 | 狀態一般化為階段序號（ADR-0016 選項 B） |
| 9. `registry` 的例外路徑 | `SECURITY DEFINER` 函式超過 10 支 | 拆成獨立服務，或改用 ReBAC 管跨組織查詢 |
| 10. 上傳解析量 | P3 每月上傳超過人工確認能負擔的數量 | 解析信心分級，高信心列免逐列確認。需求與門檻待 P3 訪談 |
| 11. 案件流程規則 | 買賣七段的計時器與補償規則超過 20 條 | 評估外部工作流程引擎（ADR-0013） |

另有五件事不隨規模觸發，但有明確時點：

1. 三個灰區的函詢結果出來時，重看 `operation_mode: 'on_behalf'` 的動作清單。
2. 法務確認身分驗證分級的適用動作後，重看每個 `Action` 的 `minIdentityLevel`。
3. 行動自然人憑證介接核准時，啟用等級 3 的 `IdentityProofProvider`。
4. 內政部公布押金專戶修法草案，或銀行公開租賃押金信託產品時，啟用 `custody = trust_account`。
5. 銀行或建經書面回覆查帳授權方式時，重看 `trust_officer` 關係與查帳連結的範圍。
