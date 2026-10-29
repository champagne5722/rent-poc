# 系統架構：台灣不動產資產管理平台

日期：2026-10-29
狀態：提案草稿，待使用者審閱
依據：[BRD](brd.md)、[調研報告](reports/台灣不動產資產管理平台調研.md)、`docs/adr/` 的 ADR-0001 至 ADR-0009、`docs/domain-model.md`、`docs/known-simplifications.md`、`GLOSSARY.md`、`src/lib/` 現有介面
用詞：術語用 `GLOSSARY.md` 定義欄的詞與 BRD 第 9 節的提案詞。法規結論只引用調研報告，數字後的【高】【中】【低】沿用報告的信心標示。

平台只管合約、文件、狀態與對帳，不持有任何一方的款項。本文件把這個定位落到元件、資料模型與交易邊界。架構沿用 rent-poc 的 Next.js 全端與 antd，資料庫換成 PostgreSQL。

> **注意：** rent-poc 使用 Next.js 16.2.11。`AGENTS.md` 警告此版本的 API、慣例與檔案結構和一般認知不同。本文件提到 Next.js 的每一處，動工前先讀 `node_modules/next/dist/docs/`。

## 1. 需求摘要

### 1.1 功能需求

功能依 BRD 第 5 節的 Now、Next、Later 分段。每一段都有法規或合作前提，前提沒過就不進下一段。

**Now（0 至 6 個月）：租賃管理與合規前置**

| 編號 | 功能 | 對應 BRD 項目 | 現況 |
|---|---|---|---|
| N1 | 物件登錄：以產權錨點建立物件，租賃單位掛在錨點下 | 物件錨點 | 新增 |
| N2 | 重複登錄偵測：硬性層用複合鍵，軟性層用正規化地址與座標 | 物件錨點 | 新增 |
| N3 | 出租權源：謄本或授權書上傳、比對登記名義人、授權鏈條 | 出租權源 | 新增 |
| N4 | 多租戶：帳號、組織、案件成員、PostgreSQL RLS | 多租戶 | 新增 |
| N5 | 合約：三層文件、點點簽簽署、設備附件、撤回後衍生 | 沿用 | 已有 |
| N6 | 案件：一筆租賃從擬約到押金結算的流程與待辦 | 租賃帳務 | 擴充 `transitions.ts` |
| N7 | 入帳確認：人工上傳匯款證明，人工審核後產生事件 | 租賃帳務 | 新增 |
| N8 | 鏡像帳與押金台帳：押金、租金應收、逾期提醒、房東報表 | 租賃帳務 | 新增 |
| N9 | 退租點交：設備附件比對、照片與度數存證 | 租賃帳務 | 新增 |
| N10 | 押金結算：雙方電子簽署結算單，房東自行撥付後回報 | 租賃帳務 | 新增 |
| N11 | 租客端：查閱合約、押金狀態、點交紀錄 | 租客端 | 新增 |
| N12 | 稽核：金流、權限、撥款指示、敏感文件讀取的 append-only 紀錄 | 多租戶 | 新增 |

**Next（6 至 18 個月）：信託專戶與自有房源**

| 編號 | 功能 | 前提 |
|---|---|---|
| X1 | 信託專戶整合：虛擬帳號、對帳檔匯入、銀行推送 | 銀行合作契約簽訂 |
| X2 | 撥款指示：雙方電子簽署後交銀行執行，接收執行結果 | 銀行合作契約簽訂 |
| X3 | 移交包與代管業者退場流程 | 代管業者客戶 3 家以上 |
| X4 | 修繕派工媒合，房東自己下單付款 | 灰區二函詢結果 |
| X5 | 自有房源上架與物件驗證標章 | 灰區一函詢結果 |

**Later（18 個月以上）：買賣流程層與信託財產管理**

| 編號 | 功能 | 前提 |
|---|---|---|
| L1 | 買賣七段流程層：每段文件清單、待辦、入帳確認、撥款指示 | 建經或銀行願意推送入帳狀態 |
| L2 | 信託財產出租管理，給受託銀行查閱出租與租金紀錄 | 銀行客戶需求驗證 |
| L3 | 資料 API 給建經與銀行 | 企業版隔離完成 |

### 1.2 非功能需求

**隔離。** 一個組織的使用者不能讀寫另一個組織的資料。隔離在資料庫層強制執行，應用程式碼的錯誤不能繞過。BRD 風險 R11 要求跨組織滲透測試，CI 必須每次執行。

**稽核。** 金流、權限變更、撥款指示、敏感文件讀取都要留下紀錄。紀錄只增不改，並能證明事後沒被竄改。簽署本身的舉證維持由點點簽 Audit Trail File 承擔（ADR-0007）。

**可用性。** 調研沒有可用性目標。本文件先假設 Now 階段月可用率 99.5%。資料庫用時點復原，RPO 5 分鐘，RTO 4 小時。這三個數字是假設，必須與第一批客戶確認。

**資料保護。** 個資安全維護義務現行依個資法 112 年版 §27①【高】。114 年版 §20-1 尚未施行，設計上預留【高】。電子簽章法 §5④ 要求保存相對人同意紀錄【高】。身分證字號與完整謄本用欄位層加密，對外顯示做隱匿。

**量級估算。** BRD 的 18 個月目標是 20,000 個租賃單位與 15 家付費代管業者。每單位每月約 1 至 2 筆租金分錄，押金與結算另計。分錄量約每日 1,000 至 2,000 筆。調研指出每日萬級以下，PostgreSQL 加約束通常足夠【中】。

| 量 | 18 個月估算 | 推導 |
|---|---|---|
| 租賃單位 | 20,000 | BRD 第 8 節 |
| 活躍案件 | 約 18,000 | 假設出租率 90% |
| 鏡像帳分錄 | 每月約 40,000 筆 | 每案件每月 2 筆加押金與結算 |
| 稽核事件 | 每日約 20,000 筆 | 假設每案件每日 1 筆加讀取紀錄 |
| 文件版本 | 約 100,000 份 | 每單位謄本、授權書、合約、點交照片 |

### 1.3 限制

| 限制 | 內容 | 影響 |
|---|---|---|
| 團隊規模未知 | BRD 沒有寫開發團隊人數 | 不拆微服務，維持單一 repo、單一部署單元加一個背景 worker |
| 沿用 Next.js 與 antd | ADR-0001、ADR-0002、ADR-0009 | 頁面與 route handler 在同一專案，動工前先讀 `node_modules/next/dist/docs/` |
| 不持有款項 | 信託業法 §33、電支條例、洗錢防制法 §6【高】 | 平台沒有任何轉帳或撥款的程式路徑，只有記錄與指示 |
| 對外不使用「信託」名稱 | 信託業法 §9②【高】 | 平台產品名、方案名、UI 標題不得含「信託」，只能描述銀行的信託專戶 |
| 不爬謄本 | 電子謄本系統協議禁止自動化擷取【中】 | 謄本一律由使用者上傳，平台只驗證與歸檔 |
| 代操作屬代管 | 租賃條例 §3、§36【高】，灰區二【低】 | 「代房東操作」類功能只對持照代管業者組織開放 |
| 銀行規格未知 | 入帳通知與對帳檔沒有公開規格（報告第 9 章） | 入帳確認必須做成可替換的轉接層 |

### 1.4 假設

1. 第一個客群是代管業者與多戶房東，BRD 第 10 節仍待使用者決定。
2. 雲端在台灣有機房的供應商可選，金融客戶的境內存放要求在 Later 前再查。
3. 點點簽繼續當電子簽署服務商，簽章強度可達等級 3【低】。
4. 每個租賃單位同一時間只有一個管理它的組織。

## 2. 高階設計

### 2.1 元件圖

```
                         使用者：房東、代管業者員工、租客、銀行經辦
                                         │ HTTPS
┌────────────────────────────────────────┼─────────────────────────────────────┐
│ Next.js 應用（沿用，動工前先讀 node_modules/next/dist/docs/）               │
│                                        │                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌─┴────────────┐  ┌──────────────────┐ │
│  │ 後台頁面     │  │ 租客端頁面   │  │ Route handlers│  │ Webhook 接收端   │ │
│  │ antd         │  │ antd         │  │ /api/*        │  │ 點點簽、銀行     │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬────────┘  └────────┬─────────┘ │
│         └─────────────────┴────────┬────────┘                    │ 只寫 inbox │
│                                    ▼                             ▼            │
│  ┌──────────────────────────────────────────────────────────────────────────┐ │
│  │ 應用服務層：RequestContext（org、user、party、驗證等級）、authorize()   │ │
│  ├───────────┬────────────┬────────────┬────────────┬────────────┬─────────┤ │
│  │ 物件登錄  │ 出租權源   │ 合約       │ 案件       │ 入帳確認   │ 鏡像帳  │ │
│  │ 錨點、單位│ 權源鏈條   │ 沿用       │ orchestrator│ 轉接層     │ 押金台帳│ │
│  ├───────────┼────────────┼────────────┼────────────┼────────────┼─────────┤ │
│  │ 文件庫    │ 撥款指示   │ 移交包     │ 稽核       │ 通知       │ 身分驗證│ │
│  └───────────┴────────────┴────────────┴────────────┴────────────┴─────────┘ │
│  ┌──────────────────────────────────────────────────────────────────────────┐ │
│  │ 資料存取層：withTx()、SET LOCAL app.org_id、repository 介面             │ │
│  └──────────────────────────────────┬───────────────────────────────────────┘ │
└─────────────────────────────────────┼─────────────────────────────────────────┘
                                      │
       ┌──────────────────────────────┼────────────────────────────┐
       ▼                              ▼                            ▼
┌──────────────┐          ┌──────────────────────┐        ┌────────────────┐
│ PostgreSQL   │◄────────►│ 背景 worker          │───────►│ 物件儲存       │
│ RLS pool     │ outbox   │ outbox 派送、對帳、  │        │ 謄本、PDF、照片│
│ inbox、outbox│ inbox    │ 錨定、到期提醒       │        │ 加密、版本化   │
└──────────────┘          └──────────┬───────────┘        └────────────────┘
                                     │
        ┌───────────────┬────────────┼─────────────┬──────────────────┐
        ▼               ▼            ▼             ▼                  ▼
   ┌─────────┐    ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌──────────┐
   │ 點點簽  │    │ 銀行     │  │ 建經     │  │ 時間戳記服務 │  │ Email/SMS│
   │ 簽署任務│    │ 虛擬帳號 │  │ Later    │  │ 稽核錨定     │  │ 通知     │
   │         │    │ 對帳檔   │  │          │  │              │  │          │
   └─────────┘    └──────────┘  └──────────┘  └──────────────┘  └──────────┘
```

Webhook 接收端只做三件事：驗簽章、寫 inbox、回 200。業務處理一律由 worker 從 inbox 取出後執行。對外呼叫一律由 worker 從 outbox 取出後執行。

背景 worker 是獨立程序，和 Next.js 共用 `src/lib/` 的領域程式碼。Next.js route handler 的生命週期不適合長時間任務。worker 的部署方式動工前先讀 `node_modules/next/dist/docs/`，確認此版本有無內建背景任務機制。

### 2.2 資料流：租賃案件從登錄到押金結算

```
 ① 物件登錄      ② 出租權源驗證   ③ 合約簽署        ④ 押金入帳          ⑤ 收租對帳
 PropertyAnchor  LeasingAuthority  Contract          DepositConfirmation  MirrorLedger
 RentalUnit      DocumentVersion   點點簽簽署任務    → DepositConfirmed   租金分錄
      │                │                 │                  │                  │
      ▼                ▼                 ▼                  ▼                  ▼
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ Case 狀態：draft → authority_verified → signing → awaiting_deposit → active      │
 └──────────────────────────────────────────────────────────────────────────────────┘
                                   │ 房東或租客發起退租
                                   ▼
 ⑥ 退租點交                 ⑦ 押金結算                          ⑧ 結案
 HandoverPackage 屋況段     DisbursementInstruction              押金負債餘額為 0
 設備附件比對、照片、度數   雙方簽署 → 執行 → DisbursementExecuted
      │                          │                                   │
      ▼                          ▼                                   ▼
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ Case 狀態：move_out → settling → closed                                          │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

| 步驟 | 觸發 | 平台寫入（同一交易） | 對外動作（outbox） | 錢在哪 |
|---|---|---|---|---|
| ① 物件登錄 | 房東或代管業者送出表單 | `property_anchors`、`rental_units`、`properties`、稽核事件 | 疑似重複時通知審核員 | 無 |
| ② 權源驗證 | 上傳第二類謄本或授權書 | `documents`、`document_versions`、`leasing_authorities`、`case_events` | 到期提醒排程 | 無 |
| ③ 合約簽署 | 送簽、點點簽 webhook | `contracts`、`contract_events`、`cases`、`case_events` | 呼叫點點簽、保存已簽 PDF | 無 |
| ④ 押金入帳 | 人工上傳、對帳檔、銀行推送 | `inbox_messages`、`deposit_confirmations`、`ledger_journals`、`cases` | 通知房東與租客 | 房東帳戶或銀行信託專戶 |
| ⑤ 收租對帳 | 每月應收產生、入帳確認 | `ledger_journals`、`ledger_entries` | 逾期提醒給房東 | 房東帳戶 |
| ⑥ 退租點交 | 房東與租客會同點交 | `handover_packages` 的屋況段、`document_versions` | 通知雙方確認 | 無 |
| ⑦ 押金結算 | 雙方簽署結算單 | `disbursement_instructions`、`case_events` | Now 通知房東撥付，Next 送銀行 | 銀行撥付或房東撥付 |
| ⑧ 結案 | 收到 `DisbursementExecuted` | `ledger_journals`、`cases`、稽核事件 | 結案通知 | 無 |

Now 階段沒有銀行合作。押金進房東帳戶，平台仍記鏡像帳。這仍能證明代管業者沒經手押金（BRD 第 4.1 節）。

### 2.3 外部系統

| 外部系統 | 平台怎麼用 | 介接方式 | 階段 | 已知限制 |
|---|---|---|---|---|
| 點點簽 | 合約與撥款指示的電子簽署、Audit Trail File | REST API、webhook，Client Credentials（ADR-0003） | Now | webhook 查不到事件 ID 欄位，去重鍵見 5.1 |
| 銀行信託部 | 虛擬帳號、入帳通知、對帳檔、撥款執行 | 未知，只能商務洽談（報告第 9 章） | Next | 沒有公開規格，開放銀行不適合當入帳通道【低】 |
| 建經 | 買賣七段流程的入帳狀態與撥款 | 未知，商務洽談 | Later | 沒有公開規格【低】 |
| 地政資料 | 謄本由使用者上傳，平台驗證欄位 | 檔案上傳，不呼叫地政系統 | Now | 禁止自動化擷取【中】，法人常態取得管道是高影響缺口 |
| 圖資服務（例如 TGOS） | 門牌正規化與座標，供軟性重複偵測 | API | Now | 地籍圖只能展示，不可當界址依據【中】 |
| 時間戳記服務 | 稽核 hash chain 的外部錨定 | RFC 3161 時戳 | Now | 服務商未選定 |
| Email、SMS | 通知、OTP | API | Now | 等級 1 驗證依賴它 |

### 2.4 儲存選擇

| 資料 | 儲存 | 理由 |
|---|---|---|
| 交易資料：組織、案件、合約、帳本、權限 | PostgreSQL，pool 模式加 RLS | 需要 RLS、交易、約束、時點復原（報告第 9 章） |
| inbox、outbox、背景任務 | 同一個 PostgreSQL | 狀態更新與 outbox 必須同交易，不引入訊息佇列 |
| 稽核事件 | 同一個 PostgreSQL 的獨立 schema，獨立寫入角色 | 觸發器禁止 UPDATE 與 DELETE，hash chain 在資料庫內計算 |
| 謄本、授權書、PDF、照片 | S3 相容物件儲存，伺服器端加密、開版本控制 | 檔案不進資料庫，資料庫只存 key 與 SHA-256 |
| 全域產權錨點登錄表 | 同一個 PostgreSQL 的 `registry` schema，不掛組織 RLS | 唯一鍵必須跨組織成立，見 3.4 與 ADR-0014 |
| 快取 | Now 不設 | 量級不需要，避免快取跨組織外洩 |

現有 `data/contract-files/` 的本機檔案搬到物件儲存。`contract_files.rel_path` 改存物件 key。

## 3. 領域模型

### 3.1 關係總覽

```
                    registry schema（全域，不掛組織 RLS）
              ┌───────────────────────────────────────────┐
              │ PropertyAnchor 1 ──── * RentalUnit         │
              │      │ 1                                   │
              │      └── * AnchorKeyHistory、SupportingId  │
              └──────────┬────────────────┬────────────────┘
                         │                │
 tenant schema（掛 RLS） │ *              │ 1
 ┌───────────────────────┼────────────────┼──────────────────────────────────┐
 │ Organization 1 ── * Property（物件）* ── 1 RentalUnit                            │
 │   │            │                                                           │
 │   │            └── * LeasingAuthority ── * DocumentVersion（謄本、授權書） │
 │   │                                                                        │
 │   └── * Case 1 ── * Contract（沿用）── * ContractEvent（沿用）             │
 │            │ 1 ── * CaseMember ── 1 Party                                  │
 │            │ 1 ── 1 DepositLedger ── * MirrorLedger 分錄                   │
 │            │ 1 ── * DepositConfirmation                                    │
 │            │ 1 ── * DisbursementInstruction                                │
 │            └ 1 ── * CaseEvent                                              │
 │ HandoverPackage：RentalUnit × 原組織 × 新組織                              │
 │ AuditEvent：每組織一條 hash chain                                          │
 └────────────────────────────────────────────────────────────────────────────┘
```

所有主鍵用 ULID，對外不暴露流水號。現有 `INTEGER AUTOINCREMENT` 的 `id` 在遷移時保留為 `legacy_id`。金額一律用整數「元」，欄位型別 `bigint`，幣別固定 `TWD`。時間一律用 `timestamptz`。

### 3.2 術語衝突：Tenant 與租客

`GLOSSARY.md` 把租客的英文定為 Tenant。現有程式碼也用 `tenant` 表示租客，例如 `SignerRole`、`tenantName`。多租戶的 Tenant 若也叫 `tenant`，同一個識別字會有兩個意思。

本文件的處理如下。中文概念叫「組織」，識別字用 `org`，例如 `orgs` 表與 `org_id` 欄位。`tenant` 繼續只表示租客。「組織」要加進 `GLOSSARY.md`，_Avoid_ 欄放「組織、租客、客戶」。「多租戶」只當架構名稱使用。

「案件」目前出現在「簽署任務」的 _Avoid_ 欄。這表示簽署任務不能叫案件。BRD 提案的「案件」是另一個實體，兩者不衝突。加入 `GLOSSARY.md` 時要寫明兩者的差別。

### 3.3 Organization（組織）

訂閱平台的組織。代管業者、多戶房東、銀行、建經各是一個組織。個人房東自己也是一個組織。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `kind` | enum | `property_manager`、`landlord`、`bank`、`escrow` |
| `name` | text | 顯示名稱 |
| `licenses` | jsonb | 代管業、包租業、經紀業的登記字號與效期 |
| `plan` | enum | `pool`、`dedicated` |
| `db_locator` | text | `dedicated` 時指向獨立資料庫，`pool` 時為空 |
| `status` | enum | `active`、`suspended`、`offboarding` |

鍵：`id`。這張表在控制平面，不掛 RLS。`licenses` 決定「代房東操作」類功能是否開放，見 5.5。

關係：現有 `properties`、`contracts`、`equipment_vocabulary` 都加 `org_id`。遷移時全部掛到一個預設組織。

### 3.4 PropertyAnchor（產權錨點）

一個產權單位。唯一鍵是「縣市＋鄉鎮市區＋段小段＋建號（含分號）」【高】。建號只在地段內唯一，單存數字會撞號（報告第 8 章）。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵，對內引用一律用它 |
| `county_code` | text | 縣市編碼，用地政編碼表，不存名稱 |
| `district_code` | text | 鄉鎮市區編碼 |
| `section_code` | text | 段小段編碼 |
| `building_no` | char(5) | 建號，一般建物五位數【高】 |
| `building_sub_no` | char(3) | 分號，特別建物數棟併編時使用【高】，沒有分號存 `000` |
| `status` | enum | `pending_verification`、`verified`、`merged`、`retired` |
| `merged_into_id` | ULID | 合併後指向存續錨點 |
| `address_text` | text | 使用者輸入的門牌 |
| `normalized_address` | text | 正規化後的門牌，供軟性重複偵測 |
| `geo_point` | point | 座標 |
| `registration_snapshot` | jsonb | 最近一份謄本的登記名義人（隱匿後）、信託登記狀態 |

鍵：

- 主鍵：`id`。
- 業務唯一鍵：`UNIQUE (county_code, district_code, section_code, building_no, building_sub_no)`，只在五欄都有值時成立。
- 使用者暫時無法提供建號時，以 `pending_verification` 登錄，附門牌與座標（報告第 8 章）。

編碼表用地政單位的編碼，不用名稱。縣市與鄉鎮市區的名稱會因行政區調整而改變，編碼較穩定。

錨點放在全域的 `registry` schema，不屬於任何組織。同一個建號被第二個組織登錄時，不建立新錨點。第二個組織只新增自己的出租權源，送人工審核。錨點本身不記所有權，所以搶先登錄的人佔不到它。

附屬表：

- `anchor_key_history`：重測或整編造成建號變動時，保存舊複合鍵與變動日期。
- `address_history`：門牌歷史，避免整編後同一物件被視為新物件（報告第 8 章）。
- `supporting_ids`：稅籍編號、基地地號清單、共有部分建號。共有部分建號依土地登記規則 §81 另編【高】，只當關聯資料。

### 3.5 RentalUnit（租賃單位）

掛在產權錨點下的可出租單位。分租套房沒有官方房間級識別碼，所以由平台自發 ID（報告第 8 章）。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵，無語意，地址改變也不變，永不重用 |
| `anchor_id` | ULID | 所屬產權錨點 |
| `suffix` | char(4) | 單位後綴，`0000` 代表整戶，分租用房號或標籤 |
| `label` | text | 房號或顯示名稱 |
| `floor` | text | 樓層 |
| `unit_type` | enum | 沿用 `PROPERTY_TYPES`：整層住家、套房、雅房 |
| `status` | enum | `active`、`retired` |

鍵：主鍵 `id`，業務唯一鍵 `UNIQUE (anchor_id, suffix)`。顯示用編碼由錨點編碼加後綴組成。

報告建議單位鍵值為「錨點 ID 加單位後綴」。本文件把它定為唯一約束，主鍵另用 ULID。理由是待驗證錨點會在驗證後合併。若主鍵含錨點 ID，合併時所有外鍵都要改。

關係：同一個租賃單位同一時間只屬於一個管理它的組織。管理關係由出租權源表達，不寫在租賃單位上。

### 3.6 Property（物件，沿用並擴充）

`GLOSSARY.md` 定義的物件，在新架構中是「組織視角的租賃單位」。物件存營運資料：名稱、預設租金、設備清單、備註。租賃單位存身分資料：錨點、後綴、樓層。

| 新增欄位 | 型別 | 說明 |
|---|---|---|
| `org_id` | ULID | 所屬組織，RLS 依據 |
| `rental_unit_id` | ULID | 對應的租賃單位，遷移期允許空值，UI 顯示「待綁定錨點」 |
| `legacy_id` | integer | 原 SQLite 的 `id` |

鍵：主鍵 `id`。`UNIQUE (org_id, rental_unit_id)`，同一組織對同一租賃單位只有一筆物件。

關係：代管業者更換時，新組織建立自己的物件，指向同一個租賃單位。設備清單由移交包帶入。舊組織的物件保留，狀態改為 `handed_over`。`address`、`type`、`size` 在綁定錨點後由租賃單位帶入，物件只留覆寫值。

### 3.7 LeasingAuthority（出租權源）

出租人出租該單位的依據。出租人不一定是所有權人。轉租時要保存所有權人、包租業、租客的鏈條（報告第 7 章）。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id` | ULID | 登錄這筆權源的組織 |
| `rental_unit_id` | ULID | 對應的租賃單位 |
| `kind` | enum | `ownership`、`authorization`、`sublease_consent`、`trust_lessor` |
| `grantor_party_id` | ULID | 授權方，例如所有權人 |
| `grantee_party_id` | ULID | 被授權方，例如代管業者或包租業 |
| `parent_authority_id` | ULID | 鏈條上一層，所有權為空 |
| `is_primary` | boolean | 是否為主要出租權源 |
| `valid_period` | tstzrange | 有效期間 |
| `status` | enum | `pending`、`verified`、`expired`、`revoked`、`disputed` |
| `evidence_version_ids` | ULID[] | 謄本、授權書、轉租同意書、信託契約的文件版本 |
| `verified_by`、`verified_at` | | 驗證人與時間 |

鍵：主鍵 `id`。同一租賃單位同一時間只能有一筆有效的主要出租權源【高，報告第 8 章結論】。用 PostgreSQL 排除約束實作：`EXCLUDE USING gist (rental_unit_id WITH =, valid_period WITH &&) WHERE (is_primary AND status = 'verified')`。

`trust_lessor` 用在信託財產。法務部 2026-09-21 書函允許約定委託人為出租人，但不可架空受託人的管理處分權限【高】。這類權源必須附信託契約的出租權限條款。

關係：一個物件可有多筆出租權源。案件進入簽署前，必須存在一筆有效的主要出租權源。權源跨組織可見度受限，第二個組織只看到「此單位需人工審核」。

### 3.8 Case（案件）

一個跨方流程的實例。Now 只有租賃案件，Later 加買賣案件。案件從擬約開始，到押金結算完成結束。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id` | ULID | 主辦組織 |
| `kind` | enum | `lease`、`sale` |
| `rental_unit_id` | ULID | 對應的租賃單位 |
| `property_id` | ULID | 主辦組織的物件 |
| `leasing_authority_id` | ULID | 簽署時依據的出租權源 |
| `current_contract_id` | ULID | 目前有效的合約 |
| `state` | enum | 見 5.3 的狀態表 |
| `state_version` | integer | 樂觀鎖，每次轉移加 1 |
| `waiting_on` | jsonb | 目前等誰、做什麼、期限 |
| `opened_at`、`closed_at` | timestamptz | |

鍵：主鍵 `id`。`case_events` 是案件的 append-only 事件表，見 5.3。

關係：一個案件可有多份合約，因為撤回後會衍生新合約（ADR-0006）。`current_contract_id` 指向最新一份。拒簽後若重新擬約，仍在同一案件內，但新合約不記衍生關聯，與 ADR-0006 一致。

### 3.9 Contract（合約，沿用）

沿用 rent-poc 的合約、三層文件、狀態機與快照規則（ADR-0004 至 ADR-0008）。六態狀態機不擴充。

| 新增欄位 | 型別 | 說明 |
|---|---|---|
| `org_id` | ULID | 所屬組織 |
| `case_id` | ULID | 所屬案件 |
| `rental_unit_id` | ULID | 對應的租賃單位 |
| `signed_pdf_sha256` | char(64) | 已簽 PDF 的雜湊，供稽核引用 |
| `legacy_id` | integer | 原 SQLite 的 `id` |

`fields` 從 TEXT 改為 `jsonb`，形狀不變。`ContractFields` 的快照規則不變。合約引用物件後自成快照，物件後續修改不回溯。

關係：合約狀態轉移後，案件 orchestrator 依合約事件推進案件。`decideTransition()` 保持純函式，不知道案件存在。

### 3.10 DepositLedger（押金台帳）

每個租賃案件一本押金台帳。台帳是鏡像帳上的業務視圖，不自己存餘額。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id` | ULID | |
| `case_id` | ULID | 一個案件一本，`UNIQUE (case_id)` |
| `expected_amount` | bigint | 合約約定的押金，來自 `ContractFields.deposit` |
| `custody` | enum | `landlord_account`、`trust_account` |
| `bank_account_ref` | text | 收款帳戶的遮罩識別，例如末四碼與銀行編碼 |
| `virtual_account_no` | text | Next 階段的虛擬帳號 |
| `status` | enum | `awaiting`、`held`、`settling`、`settled` |

鍵：主鍵 `id`，`UNIQUE (case_id)`。已收、已扣抵、已返還的金額由鏡像帳分錄加總，不另存。

押金上限 2 個月租金【高，報告第 7 章範本】。台帳建立時檢查 `expected_amount`，超過上限時阻擋送簽。

### 3.11 MirrorLedger（鏡像帳）

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

關係：每筆分錄關聯一個業務事件 ID（報告第 9 章）。押金台帳與房東報表都從分錄加總產生。

### 3.12 DepositConfirmation（入帳確認）

平台收到的「款項已入帳」事件。來源可為人工上傳、對帳檔或銀行推送。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id`、`case_id` | ULID | |
| `inbox_message_id` | ULID | 來源的 inbox 紀錄 |
| `source` | enum | `manual_upload`、`recon_file`、`bank_push` |
| `source_ref` | text | 來源端交易序號，人工上傳時為證明檔雜湊 |
| `purpose` | enum | `deposit`、`rent` |
| `amount` | bigint | |
| `value_date` | date | 銀行入帳日 |
| `account_ref` | text | 入帳帳戶遮罩識別 |
| `evidence_version_id` | ULID | 匯款證明或對帳檔的文件版本 |
| `status` | enum | `pending_review`、`confirmed`、`rejected`、`reversed` |
| `reviewed_by`、`reviewed_at` | | 人工審核時才有值 |

鍵：主鍵 `id`，`UNIQUE (source, source_ref)`。

關係：狀態變成 `confirmed` 時，同一交易內發出 `DepositConfirmed`、寫鏡像帳分錄、推進案件。

### 3.13 DisbursementInstruction（撥款指示）

雙方電子簽署、交銀行執行的付款指令。Now 階段沒有銀行，由房東自行撥付後回報。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `org_id`、`case_id` | ULID | |
| `kind` | enum | `deposit_settlement`、`sale_release` |
| `lines` | jsonb | 每列：收款方 party、金額、事由（返還、扣抵修繕、扣抵欠租） |
| `total_amount` | bigint | 必須等於押金台帳餘額 |
| `executor` | enum | `landlord_self`、`bank` |
| `esign_task_id` | text | 點點簽簽署任務 |
| `required_identity_level` | smallint | 簽署人最低驗證等級，見 5.6 |
| `status` | enum | `draft`、`awaiting_signatures`、`signed`、`submitted`、`executed`、`rejected`、`failed` |
| `submitted_at`、`executed_at` | timestamptz | |
| `execution_ref` | text | 銀行或房東回報的交易序號 |

鍵：主鍵 `id`。同一案件同一時間只能有一筆非終態的指示，用部分唯一索引實作。

關係：撥款執行是不可回頭的步驟。`executed` 由入帳確認轉接層收到 `DisbursementExecuted` 才設定，平台自己不會設定。

### 3.14 HandoverPackage（移交包）

代管業者更換時，每個租賃單位的六類資料集合（BRD 第 4.2 節）。退租點交也用同一結構的屋況段。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | ULID | 主鍵 |
| `rental_unit_id` | ULID | |
| `from_org_id`、`to_org_id` | ULID | 原組織與新組織，退租點交時兩者相同 |
| `purpose` | enum | `manager_change`、`move_out`、`move_in` |
| `sections` | jsonb | 權屬、人、屋況、錢、實物、行政六段，每段列出文件版本 ID 與快照 |
| `ledger_snapshot` | jsonb | 押金台帳、預收租金、欠費、代收代付清單在封包時的餘額 |
| `landlord_confirmed_at` | timestamptz | 房東逐案確認時間 |
| `status` | enum | `draft`、`sealed`、`accepted`、`rejected` |
| `sealed_sha256` | char(64) | 封包後整包內容的雜湊 |

鍵：主鍵 `id`。封包後內容不可改，雜湊寫進稽核事件。

關係：移交包是跨組織的資料。封包後，新組織只能讀，不能改。新組織接受後，舊組織的出租權源轉為 `revoked`，新組織的權源轉為 `verified`。業者更換時既有租客押金的處理規定沒有找到（報告第 7 章），錢段的處理方式待法務確認。

### 3.15 CaseMember（案件成員）

案件與參與方的關係。權限由「關係加動作」決定（報告第 9 章）。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `case_id` | ULID | |
| `party_id` | ULID | 參與方 |
| `relation` | enum | 見 5.5 的清單 |
| `granted_by` | ULID | 授予的使用者 |
| `valid_period` | tstzrange | 有效期間，結案後保留唯讀 |

鍵：`PRIMARY KEY (case_id, party_id, relation)`。索引 `(party_id, case_id)` 供 RLS 查詢。

支援實體：

- `parties`：法律上的參與方，個人或法人。身分證字號與統一編號用欄位層加密。
- `users`：登入帳號，一個 user 可對應一個 party。
- `org_memberships`：user 在組織內的角色，供 RBAC 使用。

### 3.16 AuditEvent（稽核事件）

平台側的稽核級紀錄。範圍是金流、權限變更、撥款指示、敏感文件讀取與電子簽章同意紀錄。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `org_id` | ULID | 每組織一條鏈 |
| `seq` | bigint | 組織內遞增序號 |
| `occurred_at` | timestamptz | |
| `actor_user_id`、`actor_party_id` | ULID | |
| `actor_identity_level` | smallint | 行為當下的驗證等級 |
| `action` | text | 例如 `deposit.confirm`、`member.grant`、`document.read_original` |
| `object_type`、`object_id` | | 被操作的物件 |
| `case_id` | ULID | 有案件時才有值 |
| `payload` | jsonb | 變更前後的關鍵欄位，不放完整個資 |
| `request_meta` | jsonb | IP、user agent、request ID |
| `prev_hash`、`hash` | char(64) | hash chain |

鍵：`PRIMARY KEY (org_id, seq)`。

關係：與 ADR-0007 的合約歷程並存，見 5.7。

## 4. 模組邊界

| 模組 | 判斷 | 現有檔案 | 責任 |
|---|---|---|---|
| 合約 | 沿用 | `contract-wizard.ts`、`contract-detail.ts`、`contract-list.ts` | 擬約、送簽、撤回、衍生 |
| 條款庫與文件組裝 | 沿用 | `clause-library.ts`、`contract-clauses.ts`、`pdf.ts`、`pdf-layout.ts`、`equipment.ts` | 三層文件與 PDF 產出 |
| 合約狀態機 | 沿用 | `transitions.ts` 的 `decideTransition()` | 純函式，不知道案件 |
| 電子簽署 adapter | 擴充 | `dottedsign.ts`、`signing.ts` | 抽出 `ESignProvider` 介面，點點簽為第一個實作 |
| 案件 orchestrator | 擴充 | 由 `transitions.ts` 的模式延伸 | 案件狀態、事件表、步驟分類 |
| 資料存取層 | 擴充 | `db.ts` | 改為 repository 介面加 `withTx()`，SQLite 與 PostgreSQL 兩個實作 |
| 設計系統 | 沿用 | `design-theme.ts`、`DESIGN.md`（ADR-0009） | antd theme |
| 物件登錄 | 新增 | | 產權錨點、租賃單位、重複偵測 |
| 出租權源 | 新增 | | 權源鏈條、驗證、到期 |
| 文件庫 | 新增 | `contract-files.ts` 併入 | 文件版本、取得時間、到期、隱匿 |
| 入帳確認轉接層 | 新增 | | inbox、來源 adapter、`DepositConfirmed` |
| 鏡像帳 | 新增 | | 雙式分錄、沖銷、餘額查詢、對帳差異 |
| 撥款指示 | 新增 | | 結算單、雙簽、送執行 |
| 移交包 | 新增（Next） | | 六類資料封包與接受 |
| 組織與身分 | 新增 | | 組織、帳號、session、驗證等級 |
| 權限 | 新增 | | RBAC 加 `case_members` |
| 稽核 | 新增 | | append-only、hash chain、錨定 |
| 通知與 worker | 新增 | | outbox 派送、排程、重試 |
| 租客端 | 新增 | | 租客查閱頁面 |

對外介面以 TypeScript 表示。所有寫入介面的第一個參數都是 `ctx`，內含組織、使用者與交易。

```ts
// 資料存取層
interface RequestContext {
  orgId: string;
  userId: string | null;
  partyId: string | null;
  identityLevel: 1 | 2 | 3 | 4;
  requestId: string;
}
interface TxContext extends RequestContext { tx: Tx }
function withTx<T>(ctx: RequestContext, fn: (t: TxContext) => Promise<T>): Promise<T>;
// withTx 開交易後第一件事：SELECT set_config('app.org_id', $1, true)

// 權限
function authorize(t: TxContext, action: Action, object: ObjectRef): Promise<void>; // 拒絕時丟 Forbidden

// 物件登錄
function registerUnit(t: TxContext, input: AnchorInput & UnitInput): Promise<
  { kind: 'created' | 'attached'; anchorId: string; unitId: string } | { kind: 'needs_review'; reviewId: string }
>;
function mergeAnchors(t: TxContext, fromId: string, intoId: string): Promise<void>;

// 出租權源
function submitAuthority(t: TxContext, input: AuthorityInput): Promise<string>;
function verifyAuthority(t: TxContext, authorityId: string, decision: 'verified' | 'rejected'): Promise<void>;
function primaryAuthorityAt(t: TxContext, unitId: string, at: Date): Promise<LeasingAuthority | null>;

// 文件庫
function addVersion(t: TxContext, input: DocumentVersionInput): Promise<string>;
function isFresh(t: TxContext, versionId: string, use: DocumentUse): Promise<boolean>;
function readOriginal(t: TxContext, versionId: string): Promise<SignedUrl>; // 一定寫稽核事件

// 電子簽署 adapter
interface ESignProvider {
  createTask(doc: Uint8Array, signers: SignerStage[]): Promise<{ taskId: string }>;
  getSignLink(taskId: string, email: string, redirectUrl?: string): Promise<string>;
  voidTask(taskId: string): Promise<void>;
  resendTask(taskId: string): Promise<void>;
  verifyWebhook(rawBody: string, headers: Headers): boolean;
  toInboxMessage(rawBody: string): InboxMessageInput; // 決定去重鍵
  downloadFiles(taskId: string, kinds: ContractFileKind[]): Promise<DownloadedFile[]>;
}

// 入帳確認轉接層
interface DepositSource {
  readonly source: 'manual_upload' | 'recon_file' | 'bank_push';
  parse(message: InboxMessage): Promise<ParsedConfirmation[]>;
}
function ingest(source: DepositSource['source'], externalId: string, payload: unknown): Promise<'accepted' | 'duplicate'>;
function reviewManual(t: TxContext, confirmationId: string, decision: 'confirmed' | 'rejected'): Promise<void>;

// 鏡像帳
function postJournal(t: TxContext, j: JournalInput): Promise<string>;       // 借貸不平衡時丟錯
function reverseJournal(t: TxContext, journalId: string, reason: string): Promise<string>;
function balance(t: TxContext, accountCode: string, asOf?: Date): Promise<bigint>;

// 案件 orchestrator
function decideCaseTransition(state: CaseState, event: CaseInput): CaseDecision | null; // 純函式
function dispatch(t: TxContext, caseId: string, event: CaseInput): Promise<CaseState>; // 狀態、事件、outbox 同交易

// 撥款指示
function proposeSettlement(t: TxContext, caseId: string, lines: SettlementLine[]): Promise<string>;
function sendForSignatures(t: TxContext, instructionId: string): Promise<void>;

// 稽核
function appendAudit(t: TxContext, e: AuditEventInput): Promise<void>;     // 只呼叫資料庫函式 audit.append()
function verifyChain(orgId: string, fromSeq?: bigint): Promise<ChainReport>;
```

模組之間只透過上列介面呼叫，不直接讀別的模組的表。route handler 只呼叫應用服務，不直接寫 SQL。route handler 的寫法動工前先讀 `node_modules/next/dist/docs/`。

## 5. 關鍵機制深入

### 5.1 入帳確認轉接層

平台內部只認一個標準事件 `DepositConfirmed`。來源有三種，第一版不必押注單一銀行（報告第 9 章）。

| 來源 | 階段 | 去重鍵 `source_ref` | 是否需人工審核 | 舞弊風險 |
|---|---|---|---|---|
| `manual_upload`：租客或房東上傳匯款證明 | Now | 證明檔 SHA-256 加金額加入帳日 | 必須 | 最高【報告第 9 章】 |
| `recon_file`：銀行虛擬帳號每日對帳檔 | Next | 銀行交易序號 | 不需要，差異才送審 | 低 |
| `bank_push`：銀行或建經推送已入帳狀態 | Next 或 Later | 對方事件 ID | 不需要 | 低 |

`DepositConfirmed` 的內容：

```ts
interface DepositConfirmed {
  confirmationId: string;
  caseId: string;
  purpose: 'deposit' | 'rent';
  amount: bigint;
  valueDate: string;           // 銀行入帳日
  custody: 'landlord_account' | 'trust_account';
  source: 'manual_upload' | 'recon_file' | 'bank_push';
  evidenceVersionId: string;
}
```

報告建議的事件名稱是 `TrustDepositConfirmed`。本文件改名 `DepositConfirmed`，用 `custody` 欄位區分帳戶。理由是 Now 階段押金進房東帳戶，沒有信託專戶。

**inbox 去重。** 所有外部訊息先寫 `inbox_messages`，再由 worker 處理。

| 欄位 | 說明 |
|---|---|
| `id` | 主鍵 |
| `source` | `dottedsign`、`manual_upload`、`recon_file`、`bank_push` |
| `external_id` | 去重鍵 |
| `received_at` | |
| `payload` | 原始內容，敏感欄位加密 |
| `signature_ok` | 簽章驗證結果 |
| `processed_at`、`result`、`attempts`、`last_error` | 處理狀態 |

約束是 `UNIQUE (source, external_id)`。重複訊息在 INSERT 時被 `ON CONFLICT DO NOTHING` 擋下，回傳 `duplicate`。

點點簽 webhook 的 payload 有 `resource_id`、`action_name`、`event_datetime`、`event_email`。點點簽 API 文件查不到事件 ID 欄位。去重鍵定為這四欄串接後的 SHA-256。租客與房東各有一次 `signed`，`event_email` 能區分兩者。

**與狀態機同交易。** worker 處理一筆 inbox 訊息時，下列寫入在同一個資料庫交易內完成：

1. 以 `SELECT ... FOR UPDATE SKIP LOCKED` 鎖定 inbox 訊息。
2. 寫入或更新 `deposit_confirmations`。
3. 狀態為 `confirmed` 時，呼叫 `postJournal()` 寫鏡像帳分錄。
4. 呼叫 `dispatch()` 推進案件，寫 `case_events`。
5. 寫 outbox：通知房東與租客。
6. 寫稽核事件。
7. 設定 inbox 的 `processed_at`。

任一步失敗，整筆回滾。inbox 訊息保留，`attempts` 加 1 後重試。重試 5 次仍失敗，轉人工處理佇列。

現有 webhook route 把狀態與合約歷程同交易寫入，符合一半的思路。它沒有 inbox 表，重複事件只靠狀態機守門。已簽 PDF 保存在交易外執行，失敗要手動補抓。新架構把保存改成 outbox 任務，自動重試。

### 5.2 鏡像帳

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

**押金案件的分錄範例（押金 20,000 元，Now 階段進房東帳戶）：**

| 業務事件 | 借方 | 貸方 | 金額 |
|---|---|---|---|
| `deposit_confirmed` | `asset.bank.{房東帳戶}` | `liability.deposit.{case}` | 20,000 |
| `deduction_agreed`：扣抵修繕費 | `liability.deposit.{case}` | `income.deduction.{case}` | 3,000 |
| `disbursement_executed`：返還餘額 | `liability.deposit.{case}` | `asset.bank.{房東帳戶}` | 17,000 |
| `reversal`：更正誤記的入帳確認 | `liability.deposit.{case}` | `asset.bank.{房東帳戶}` | 20,000 |

結案條件是 `liability.deposit.{case}` 餘額為 0。押金台帳的狀態由這個餘額決定。

**對帳。** 真相在銀行。worker 每日比對鏡像帳與對帳檔，差異寫入 `recon_exceptions`。差異由人工處理，處理結果是一筆新分錄或沖銷分錄。對帳流程不改既有分錄。Now 階段沒有對帳檔，對帳只比對人工上傳的證明。

### 5.3 案件 orchestrator

案件用「狀態表加 append-only 事件表」，不全面採事件溯源（報告第 9 章）。`cases.state` 是目前狀態，`case_events` 是發生過的事。

延伸 `transitions.ts` 的模式。`decideCaseTransition()` 是純函式，輸入目前狀態與事件，輸出下一狀態、要記的事件與要發的 outbox 任務。`dispatch()` 把三者在同一交易寫入，並用 `state_version` 做樂觀鎖。

**租賃案件狀態表：**

| 狀態 | 意義 | 進入條件 | 下一狀態 |
|---|---|---|---|
| `draft` | 擬約中 | 建立案件 | `authority_verified`、`aborted` |
| `authority_verified` | 出租權源已驗證 | 存在有效的主要出租權源與新鮮謄本 | `signing`、`aborted` |
| `signing` | 合約簽署中 | 合約送簽 | `awaiting_deposit`、`authority_verified`（撤回或拒簽） |
| `awaiting_deposit` | 待押金入帳 | 合約 `completed` | `active`、`settling`（押金未入帳即解約） |
| `active` | 租期中 | 收到押金的 `DepositConfirmed` | `move_out` |
| `move_out` | 退租點交 | 房東或租客發起退租 | `settling` |
| `settling` | 押金結算中 | 點交紀錄雙方確認 | `closed` |
| `closed` | 結案 | 收到 `DisbursementExecuted`，押金負債餘額為 0 | 無 |
| `aborted` | 中止 | 簽署完成前放棄 | 無 |

合約撤回或拒簽時，案件回到 `authority_verified`。房東可在同一案件內擬新合約。

**步驟分類：**

| 步驟 | 類別 | 失敗或反悔時的處理 |
|---|---|---|
| 送簽通知、到期提醒 | 可重試 | outbox 指數退避重試，冪等鍵為 outbox ID |
| 合約送簽 | 可補償 | 呼叫 `voidTask()` 撤回 |
| 文件收集：謄本、授權書、點交照片 | 可補償 | 標記版本作廢，要求重新上傳 |
| 入帳確認 | 可補償 | 用沖銷分錄更正，案件寫 `deposit_confirmation_reversed` 事件 |
| 已簽 PDF 與 Audit Trail File 保存 | 可重試 | outbox 重試，取代現行手動補抓 |
| 對帳回寫 | 可重試 | 下一輪對帳再跑 |
| 撥款執行 | 不可回頭 | 執行前檢查所有前提，執行後只能用新的撥款指示處理 |
| 地政登記完成（Later 買賣） | 不可回頭 | 同上 |
| 結案通知 | 可重試 | outbox 重試 |

不可回頭步驟前，`decideCaseTransition()` 檢查全部前提。前提包含雙方簽署完成、謄本仍新鮮、鏡像帳餘額足夠。任一不符，轉移回傳 `null`，不寫 outbox。

**不全面事件溯源的理由。** 重播會重觸發對外訊息。讀端有最終一致性延遲。事後加入事件溯源很困難（報告第 9 章引 Fowler）【中】。案件的讀取需求多為「目前狀態」，狀態表直接滿足。

### 5.4 多租戶

第一版用 pool 模式加 PostgreSQL RLS（報告第 9 章）。每張組織表都有 `org_id`，開 RLS，政策比對 session 變數。

```sql
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON contracts
  USING (org_id = current_setting('app.org_id', true)::text)
  WITH CHECK (org_id = current_setting('app.org_id', true)::text);
```

`current_setting(..., true)` 在變數未設定時回傳 NULL。比對 NULL 的結果是沒有任何列，所以忘記設定時預設拒絕。

**案件成員的跨組織存取。** 租客與銀行經辦屬於別的組織，或沒有組織。案件範圍的表另加一條政策，允許案件成員讀取：

```sql
CREATE POLICY case_member_read ON contracts FOR SELECT
  USING (case_id IN (SELECT case_id FROM case_members
                     WHERE party_id = current_setting('app.party_id', true)::text
                       AND now() <@ valid_period));
```

這條政策只給 SELECT。案件成員的寫入一律走應用服務，由 `authorize()` 決定。報告第 9 章只談組織隔離，沒有談跨組織的案件成員。本文件補上這一條，代價是政策變複雜。

**三個陷阱與對策（報告第 9 章）：**

| 陷阱 | 後果 | 對策 |
|---|---|---|
| 超級使用者與 `BYPASSRLS` 角色不受 RLS 限制 | 應用用錯角色時，所有組織資料可見 | 應用連線用 `app_rw` 角色，沒有 `BYPASSRLS`、不是 superuser。migration 用 `app_owner`。維運用 break-glass 角色，每次使用寫稽核事件 |
| 表擁有者預設不受 RLS 限制 | 擁有者角色執行的查詢繞過政策 | 每張表 `FORCE ROW LEVEL SECURITY`。應用角色不是擁有者。CI 查 `pg_class.relrowsecurity` 與 `relforcerowsecurity`，任一組織表缺少就失敗 |
| 連線池讓 session 狀態外洩 | 上一個請求的 `app.org_id` 留在連線上 | 只用 `set_config('app.org_id', $1, true)`，作用範圍是交易。禁止 session 層級的 `SET`。PgBouncer 用 transaction 模式 |

**第四個陷阱。** PostgreSQL 的 view 預設以擁有者權限執行，會繞過 RLS。所有 view 都要設定 `security_invoker = true`，CI 一併檢查。這一項報告沒有列。

**跨組織滲透測試。** CI 建兩個組織的種子資料。測試以組織 A 的 context 對每個 repository 方法讀寫組織 B 的 ID，預期全部回傳空值或丟錯。新增表時沒有加測試，CI 失敗。

**全域登錄表。** `registry` schema 的產權錨點不掛組織 RLS。應用角色對它沒有直接讀寫權限。只能透過 `SECURITY DEFINER` 函式 `registry.claim_unit()` 與 `registry.lookup_unit()` 存取。函式只回傳呼叫組織有出租權源的資料。

**企業版 database-per-tenant 的升級路徑：**

1. 第一天起每張表都有 `org_id`，獨立資料庫的 schema 與 pool 完全相同。
2. 控制平面的 `orgs.db_locator` 決定連線目標。`withTx()` 依此選連線池。
3. 搬遷時用 logical replication 或依 `org_id` 篩選匯出，搬完切換 `db_locator`。
4. 獨立資料庫使用組織專屬的加密金鑰。
5. migration 工具改成對所有資料庫依序執行，記錄每個資料庫的版本。
6. 全域登錄表留在控制平面。企業版資料庫只存錨點 ID，查詢經 `registry` 函式。
7. 稽核 hash chain 本來就以組織為單位，可整條搬走，不需重算。

銀行或大型建經要求獨立資料與金鑰時，再提供企業版（報告第 9 章）。金融業客戶的委外與雲端境內存放要求本次未查，提供企業版前必須查明。

### 5.5 權限

第一版用 RBAC 加 `case_members`（報告第 9 章）。RBAC 管組織內的角色。`case_members` 管案件範圍的跨方關係。權限由「關係加動作」決定。

**組織內角色（RBAC）：**

| 角色 | 能做的事 |
|---|---|
| `org_owner` | 全部，含成員管理與方案設定 |
| `org_admin` | 物件、案件、文件、成員邀請 |
| `staff` | 被指派案件的擬約、文件收集、點交 |
| `accountant` | 鏡像帳、入帳確認審核、報表 |
| `viewer` | 唯讀 |

**案件關係清單（`case_members.relation`）：**

| relation | 中文 | 階段 | 主要權限 |
|---|---|---|---|
| `landlord` | 房東 | Now | 讀案件全部、簽合約、簽撥款指示、確認移交包 |
| `tenant` | 租客 | Now | 讀合約、押金狀態、點交紀錄，簽合約與撥款指示 |
| `property_manager` | 代管業者 | Now | 依授權範圍操作，代房東操作類動作需持照 |
| `sublessor` | 包租業或二房東 | Now | 對轉租段有出租人權限 |
| `co_tenant` | 共同承租人 | Now | 同租客，但不能單獨簽撥款指示 |
| `reviewer` | 平台審核員 | Now | 讀出租權源證據與入帳證明，做審核決定 |
| `trust_officer` | 信託經辦 | Next | 讀與確認撥款指示、入帳確認 |
| `bank` | 銀行系統帳號 | Next | 推送入帳與執行結果 |
| `buyer`、`seller` | 買方、賣方 | Later | 買賣案件的簽署與確認 |
| `broker` | 仲介 | Later | 讀流程與文件清單 |
| `land_agent` | 地政士 | Later | 上傳登記文件、更新完稅與過戶段 |
| `escrow` | 建經 | Later | 推送入帳狀態、上傳專戶收支明細 |

**代房東操作的閘門。** 灰區二指出，代房東催收、保管押金、派工、協調糾紛屬代管【低】。這類動作在 `Action` 定義上標記 `operation_mode: 'on_behalf'`。`authorize()` 只在組織 `licenses` 含有效代管業登記時放行。函詢結果出來後，只改動作的標記，不改程式結構。

**何時遷移 ReBAC（OpenFGA 或 SpiceDB）：**

1. 出現多層組織，例如集團、分店、團隊三層繼承。
2. 需要文件級共享，例如只把一份謄本給某銀行經辦看。
3. 需要反向查詢「誰能看這份文件」，例如回應個資查詢請求。
4. `relation` 超過 15 種，或客戶要求自訂角色。

任兩項成立時，評估遷移。遷移前把 `authorize()` 保持為唯一入口，遷移只換它的實作。

### 5.6 身分驗證分級

四級與金融業數位身分驗證指引的四級風險同構【低】（報告第 9 章）。指引不指定方法對應哪一級。

| 等級 | 方法 | 建議適用動作（需法務確認） |
|---|---|---|
| 1 | Email 加 OTP、手機簡訊 | 瀏覽、看自己的合約、看押金狀態 |
| 2 | 手機 OTP 加證件影像與人工審核，或行動身分 App | 一般住宅租約簽署、租金繳納設定、押金結算單簽署。外籍租客用居留證加人臉比對 |
| 3 | 行動自然人憑證（LoA3）、自然人憑證、工商憑證 | 買賣合約簽署、信託共同指示、修改收款帳戶、Next 階段送銀行的撥款指示 |
| 4 | 臨櫃或公證人面對面 | 不動產物權移轉、抵押權設定，本來就由地政士與地政機關處理 |

**「適用動作」欄沒有來源，是調研員擬定，必須由法務確認【低】。** 押金結算單放在等級 2，是本文件的提議，同樣待法務確認。

實作方式：

- session 記錄 `identity_level` 與驗證時間。
- 每個 `Action` 定義 `minIdentityLevel`。`authorize()` 發現等級不足時，回傳「需要升級驗證」，前端導向對應流程。
- 撥款指示的 `required_identity_level` 傳給點點簽的簽署人驗證設定。點點簽有 `verify_methods` 可用 email 或 SMS OTP（`known-simplifications.md`）。
- 驗證等級寫進每筆稽核事件的 `actor_identity_level`。

行動自然人憑證的持卡率與綁定門檻高，租客族群覆蓋不完整（報告第 9 章）。健保卡驗證與銀行身分驗證 API 沒查到，第一版不依賴。

### 5.7 稽核

**做法（報告第 9 章）：**

1. append-only：`audit.events` 表的觸發器禁止 UPDATE 與 DELETE。
2. 獨立寫入角色：應用角色只能呼叫 `SECURITY DEFINER` 函式 `audit.append()`，不能直接 INSERT。
3. hash chain：`audit.append()` 在函式內鎖定該組織的鏈頭，計算 `hash = SHA-256(prev_hash || canonical_json(event))`。
4. 外部錨定：worker 每小時把所有組織的鏈頭組成 Merkle tree，把根送 RFC 3161 時間戳記服務。時戳憑證存 `audit.anchors`。

只有 hash chain 擋不住有寫入權限的人重算整條鏈【低】。外部錨定把竄改的偵測時間縮到一個錨定週期內。錨定週期定為 1 小時，是假設，依稽核要求調整。

`verifyChain()` 每日重算每條鏈並比對最近一次錨定。結果不一致時發出最高等級告警。

**稽核範圍：**

| 類別 | 動作範例 | 是否含讀取 |
|---|---|---|
| 金流 | 入帳確認審核、分錄沖銷、撥款指示送出與執行 | 否 |
| 權限 | 成員授予與撤銷、角色變更、break-glass 使用 | 否 |
| 敏感文件 | 謄本與身分證件原檔讀取、下載 | 是 |
| 電子簽章同意 | 電子簽章法 §5④ 的告知與同意紀錄【高】 | 否 |
| 物件身分 | 錨點合併、出租權源驗證與撤銷、移交包封包與接受 | 否 |
| 合約 | 已簽 PDF 雜湊、Audit Trail File 保存結果 | 否 |

**與 ADR-0007 的關係。** ADR-0007 有三點維持不變：

- 合約歷程（`contract_events`）維持活動時間軸，不升級為稽核級紀錄。
- 簽署的法律舉證維持由點點簽 Audit Trail File 承擔。
- 平台不重做簽署過程的稽核。

ADR-0007 末段寫明，平台側稽核級紀錄屬新 effort，需重評。本文件的 AuditEvent 就是那個 effort。報告建議新增 ADR 取代 ADR-0007。本文件建議新增 ADR 補充它的範圍，不取代它。理由是 ADR-0007 對合約歷程的決定仍然成立，只是範圍外的金流與權限需要新紀錄。

這份補充 ADR 不在第 8 章的 5 份清單內，列為後續題目。

### 5.8 文件庫

文件庫管謄本、授權書、轉租同意書、信託契約、匯款證明、點交照片與已簽 PDF。每份文件是一個邏輯文件，底下有多個版本。

**`documents`：**

| 欄位 | 說明 |
|---|---|
| `id`、`org_id` | |
| `kind` | `transcript_class2`、`transcript_class1`、`authorization_letter`、`sublease_consent`、`trust_contract`、`remittance_proof`、`handover_photo`、`signed_pdf`、`audit_trail` |
| `subject_type`、`subject_id` | 對應的錨點、租賃單位、出租權源或案件 |
| `current_version_id` | 最新版本 |

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
| `status` | `pending_review`、`accepted`、`rejected`、`superseded` |

**版本規則。** 新上傳的檔案一律是新版本，舊版本保留，狀態改 `superseded`。版本不可改，也不可刪，直到保存期限屆滿。

**取得時間與新鮮度。** 謄本反映的是列印當下的登記狀態。新鮮度規則依用途設定，存在 `document_freshness_rules` 表：

| 用途 | 規則 | 來源 |
|---|---|---|
| 出租權源驗證 | 謄本 `obtained_at` 距今不超過 N 天 | N 待產品與法務決定 |
| 撥款前檢查 | 撥款前要求重新取得謄本 | 報告第 8 章 |
| 授權書 | `valid_until` 為授權期間迄日 | 授權書內容 |

**到期提醒。** worker 每日掃描 `valid_until` 在 30 天內的版本，寫 outbox 通知。授權書到期時，對應的出租權源轉為 `expired`，案件不能再送簽。30 天是假設。

**隱匿規則：**

| 規則 | 內容 | 信心 |
|---|---|---|
| 第二類謄本本身 | 已隱匿出生日期、部分姓名、部分統一編號 | 【高】 |
| 第二類但書 | 限制登記與非自然人的姓名及統一編號不在隱匿範圍 | 【高】 |
| 對外顯示物件 | 不顯示完整建號與登記名義人姓名 | 【低】，報告的建議，需法務確認 |
| 原檔存取 | 只有出租權源相關方與審核員能讀，每次讀取寫稽核事件 | 本文件設計 |

第一類與第三類謄本限登記名義人或利害關係人申請【高】。平台預設只收第二類。收第一類時，`extracted` 不存出生日期。

**取得管道。** 謄本由使用者自行申請第二類並上傳【中】。平台不爬電子謄本系統【中】。受房東委任以代理人名義申請的路徑是舊函釋，現行是否適用需覆核【低】。平台以公司身分常態取得謄本的合法管道，是報告列的高影響缺口。

## 6. 遷移計畫

### 6.1 現況

`db.ts` 用 better-sqlite3，所有函式同步執行。交易用 `db.transaction(() => {...})()`。函式以選用參數 `db?: Database.Database` 讓測試注入 in-memory DB。schema 用 `ensureSchema()` 的 `CREATE TABLE IF NOT EXISTS` 加補欄位，沒有 migration 工具（`known-simplifications.md`）。

PostgreSQL 的驅動都是非同步。改成非同步後，`applyDsEvent()`、`commitTransition()` 與它們的呼叫端全部要改。這是遷移工作量的主體。

### 6.2 步驟

| 步驟 | 內容 | 完成條件 |
|---|---|---|
| 1 | 定義 repository 介面與 `withTx()`，仍以 SQLite 實作，介面一律回傳 Promise | 現有 vitest 全數通過 |
| 2 | 呼叫端改為 async。`decideTransition()` 等純函式不動 | route handler 不再直接 import `getDb()` |
| 3 | 選定 migration 工具，寫第一版 PostgreSQL schema | schema 涵蓋現有 5 張表加 `org_id`、`legacy_id` |
| 4 | 寫 PostgreSQL 版 repository。同一組 repository 測試對兩個實作各跑一次 | 兩個實作的測試結果相同 |
| 5 | 開 RLS 與 FORCE，建立 `app_rw`、`app_owner` 角色，加跨組織滲透測試 | CI 的 RLS 檢查與滲透測試通過 |
| 6 | 寫一次性搬資料腳本：SQLite 匯出，掛預設組織，匯入 PostgreSQL | 每張表筆數相同，`fields` JSON 的雜湊相同 |
| 7 | `data/contract-files/` 的檔案搬到物件儲存，`rel_path` 改存 key | 每個檔案的 SHA-256 相同 |
| 8 | 切換正式環境到 PostgreSQL，SQLite 檔保留為唯讀備份 | 冒煙測試通過 |
| 9 | 移除 SQLite 實作與 `better-sqlite3` 相依 | 切換後穩定 2 週 |

步驟 1 與 2 在 SQLite 上完成，不改資料庫就能驗證介面。這呼應 BRD 風險 R12 的配套：先做資料存取層抽象。

### 6.3 型別與語法對照

| SQLite 現況 | PostgreSQL | 注意 |
|---|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | ULID 主鍵加 `legacy_id integer` | 網址與外部引用改用 ULID |
| `TEXT` 存 JSON | `jsonb` | `fields`、`signature_fields`、`equipment` |
| `datetime('now', 'localtime')` | `timestamptz DEFAULT now()` | 舊資料是無時區字串，搬移時以 `Asia/Taipei` 解讀 |
| `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` | `seedEquipmentVocabulary()` |
| `PRAGMA table_info` 補欄位 | migration 工具 | `addColumnIfMissing()` 退場 |
| 同步交易 | `withTx()` 非同步交易 | 交易內不能呼叫外部 API |

### 6.4 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| 同步改非同步的連鎖修改超出估算 | 時程延後 | 步驟 1 先量測呼叫點數量，再估工時 |
| 測試從 in-memory SQLite 改成 PostgreSQL 後變慢 | 開發回饋變慢 | 測試用 PGlite 或 testcontainers，每個測試用交易回滾隔離 |
| 時區：舊資料是 `localtime` 字串 | 時間位移 8 小時 | 搬移腳本明確以 `Asia/Taipei` 解讀，抽樣比對 |
| 交易內呼叫外部 API | 長交易與鎖等待 | 對外呼叫一律走 outbox，code review 檢查 |
| 忘記設定 `app.org_id` | 查不到資料，或在 `BYPASSRLS` 角色下外洩 | `withTx()` 是唯一取得交易的入口，政策預設拒絕 |
| Next.js 16 的 server 與 route handler 行為和預期不同 | 連線池在 dev 熱重載時重複建立 | 動工前先讀 `node_modules/next/dist/docs/`，連線池掛在 `globalThis`，比照現有 `getDb()` |

現有資料量是 PoC 規模，搬資料本身風險低。風險集中在程式碼的同步改非同步。

## 7. 取捨分析

### 7.1 與調研報告第 9 章不一致之處

| 項目 | 報告第 9 章 | 本文件 | 理由 |
|---|---|---|---|
| 入帳事件名稱 | `TrustDepositConfirmed` | `DepositConfirmed` 加 `custody` 欄位 | Now 階段押金進房東帳戶，沒有信託專戶 |
| 現有 webhook 是否已符合 inbox 思路 | 寫「已符合」 | 只符合同交易的一半 | 現有 route 沒有 inbox 表與去重鍵，檔案保存在交易外 |
| RLS 範圍 | 只談組織隔離 | 加上案件成員的 SELECT 政策 | 租客與銀行經辦屬於別的組織，需要讀案件資料 |
| 產權錨點歸屬 | 未說明 | 放在全域 `registry` schema，不掛組織 RLS | 唯一鍵必須跨組織成立，否則同一建號會在不同組織各建一筆 |
| 租賃單位鍵值 | 錨點 ID 加單位後綴 | 主鍵用 ULID，錨點 ID 加後綴為唯一約束 | 待驗證錨點會合併，主鍵含錨點 ID 時外鍵全要改 |
| RLS 陷阱 | 三個 | 三個加 view 的 `security_invoker` | view 預設以擁有者權限執行，會繞過 RLS |
| ADR-0007 的處理 | 新增 ADR 取代它 | 新增 ADR 補充它的範圍 | ADR-0007 對合約歷程的決定仍成立 |
| 權限關係清單 | 只列買賣角色 | 加上租賃角色與 `reviewer` | Now 階段只有租賃案件 |

其餘建議全部採用，清單如下：

- Next.js 與 antd 沿用，點點簽加 adapter。
- 狀態機擴成案件 orchestrator，不全面事件溯源。
- SQLite 換 PostgreSQL，採 RLS pool 模式。
- 鏡像帳加沖銷，稽核用 hash chain 加外部錨定。
- 身分驗證分四級，權限用 RBAC 加案件成員表。

### 7.2 重大決策的選項與取捨

**決策 1：資料庫與組織隔離**

| 選項 | 優點 | 缺點 |
|---|---|---|
| A. PostgreSQL pool 加 RLS（採用） | 單一 schema、成本低、資料庫層強制隔離 | 三個陷阱需要紀律與 CI 檢查 |
| B. PostgreSQL schema-per-tenant | 隔離較直觀 | migration 要對每個 schema 執行，組織數上千時難管理 |
| C. database-per-tenant | 隔離最強、可用專屬金鑰 | 成本與維運最高，第一版不划算，留給企業版 |
| D. 繼續用 SQLite，在應用層過濾 `org_id` | 不用遷移 | 沒有 RLS，單檔寫入並行受限，備援弱（報告第 9 章） |

**決策 2：入帳確認的來源**

| 選項 | 優點 | 缺點 |
|---|---|---|
| A. 轉接層，三種來源統一成一個事件（採用） | 不押注單一銀行，Now 可上線 | 人工上傳的舞弊風險最高，需要審核人力 |
| B. 只接單一銀行的 API | 自動化程度高 | 銀行規格未知，Now 無法上線 |
| C. 開放銀行 | 標準化 | 第三階段以個人客戶授權為主，實際只有一家上線【低】 |

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
| A. RBAC 加 `case_members`（採用） | 實作快、好理解 | 多層組織與文件級共享時會膨脹 |
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

## 8. 候選 ADR 草稿

下列 5 份狀態都是 Proposed。它們只存在本文件，不寫進 `docs/adr/`。使用者審閱通過後，再依 `docs/adr/` 的格式轉成正式 ADR。

### ADR-0010：PostgreSQL 與 RLS 多租戶

**Status:** Proposed
**Date:** 2026-10-29
**Deciders:** 待定（產品負責人、技術負責人）

#### Context

rent-poc 用 SQLite 單檔，沒有帳號與資料隔離（ADR-0002、`known-simplifications.md`）。產品要服務多家代管業者與多戶房東。BRD 風險 R11 指出跨房東資料外洩的影響為高。SQLite 沒有 RLS，單檔寫入並行受限，備援與時點復原弱（報告第 9 章）。團隊規模未知，不適合一開始就管理多個資料庫。

#### Decision

資料庫換成 PostgreSQL，採 pool 模式。每張組織表有 `org_id`，啟用並強制 RLS。應用以交易範圍的 `set_config('app.org_id', ..., true)` 傳遞組織。案件範圍的表另加案件成員的 SELECT 政策。企業版保留 database-per-tenant 的升級路徑。

#### Options Considered

| 面向 | A. PG pool 加 RLS | B. schema-per-tenant | C. database-per-tenant | D. SQLite 加應用層過濾 |
|---|---|---|---|---|
| 複雜度 | 中 | 中高 | 高 | 低 |
| 成本 | 低 | 低 | 高 | 最低 |
| 擴展性 | 組織數上萬可行 | 組織數上千後 migration 難管 | 每組織獨立擴展 | 單檔寫入瓶頸 |
| 團隊熟悉度 | 需學 RLS 陷阱 | 一般 | 需要多資料庫維運 | 已熟悉 |
| 隔離強度 | 資料庫層強制 | 資料庫層，靠 `search_path` | 實體隔離 | 只靠應用程式碼 |

**選項 A 優點：** 一份 schema，一次 migration。隔離由資料庫強制。
**選項 A 缺點：** 超級使用者、表擁有者、連線池三個陷阱需要 CI 守住。
**選項 C 優點：** 可給銀行專屬金鑰與獨立備份。
**選項 C 缺點：** 第一版客戶數少，成本不划算。

#### Trade-off

選 A 等於用紀律換成本。RLS 陷阱都有已知對策，能寫成 CI 檢查。C 的隔離最強，但只有銀行與大型建經需要。A 的 schema 從第一天就含 `org_id`，日後搬到 C 不需改 schema。

#### Consequences

- 變容易：新增組織只要一列資料。跨組織滲透測試能自動化。
- 變困難：每張新表都要記得 RLS 與 FORCE。view 要設 `security_invoker`。全域登錄表要另走 `SECURITY DEFINER` 函式。
- 要重看：組織數或單一組織的資料量造成鄰居干擾時，評估把大組織搬到 C。

#### Action Items

1. [ ] 定義 `app_rw`、`app_owner`、break-glass 三個角色。
2. [ ] CI 加 RLS 與 FORCE 檢查、view 的 `security_invoker` 檢查。
3. [ ] CI 加跨組織滲透測試。
4. [ ] 在 `GLOSSARY.md` 加「組織」，識別字用 `org`。

### ADR-0011：不持有款項與入帳確認轉接層

**Status:** Proposed
**Date:** 2026-10-29
**Deciders:** 待定（產品負責人、技術負責人、法務）

#### Context

資金一經手，就落入信託業法、電支條例、洗錢防制法或租賃條例的管制【高】。平台的定位是不持有任何一方的款項。押金與價金留在銀行信託專戶，Now 階段押金進房東帳戶。銀行的入帳通知、對帳檔與撥款指示沒有公開規格，只能商務洽談。BRD 風險 R05 指出，銀行沒有入帳資訊介接的可能性為高。

#### Decision

平台沒有任何轉帳或撥款的程式路徑。入帳狀態由轉接層統一成 `DepositConfirmed` 事件。來源為人工上傳、對帳檔、銀行推送三種，各自實作 `DepositSource` 介面。所有外部訊息先寫 inbox，以 `(source, external_id)` 去重。事件處理與案件狀態、鏡像帳、outbox 在同一交易內完成。撥款由雙方電子簽署指示，交銀行或房東執行，執行結果經同一轉接層回到平台。

#### Options Considered

| 面向 | A. 轉接層加三種來源 | B. 只接單一銀行 API | C. 開放銀行 | D. 平台自己收款再撥付 |
|---|---|---|---|---|
| 複雜度 | 中 | 中 | 高 | 高 |
| 成本 | 低，人工審核需人力 | 依銀行報價 | 需 TSP 資格 | 需牌照 |
| 擴展性 | 新銀行只加一個 adapter | 換銀行要重寫 | 受授權範圍限制 | 受電支 20 億元門檻限制 |
| 團隊熟悉度 | 一般 | 依銀行規格 | 低 | 低 |
| 法規風險 | 低，待灰區三函詢 | 低 | 中 | 高，信託業法、電支條例【高】 |
| Now 可上線 | 可 | 不可 | 不可 | 不可 |

**選項 A 優點：** 不押注單一銀行。Now 階段用人工上傳就能上線。
**選項 A 缺點：** 人工上傳的舞弊風險最高，必須人工審核。
**選項 D 缺點：** 直接落入牌照管制，與定位衝突。

#### Trade-off

A 用人工審核成本換上線時程與銀行中立。銀行合作簽訂後，`recon_file` 與 `bank_push` 只有差異列需要人工審核。D 雖然體驗最好，但與平台定位與法規結論衝突，不考慮。

#### Consequences

- 變容易：換銀行或加銀行只加一個 adapter。重複的外部訊息不會重複入帳。
- 變困難：人工審核需要介面、人力與 SLA。灰區三函詢若認定撥款指示屬代理收付，撥款指示流程要改。
- 要重看：銀行規格取得後，重估對帳頻率與差異處理流程。

#### Action Items

1. [ ] 建 `inbox_messages` 表，點點簽 webhook 先改走 inbox。
2. [ ] 實作 `manual_upload` adapter 與審核介面。
3. [ ] 帶金流圖拜訪 2 家銀行信託部，索取入帳通知與對帳檔規格。

### ADR-0012：鏡像帳與沖銷

**Status:** Proposed
**Date:** 2026-10-29
**Deciders:** 待定（技術負責人、會計顧問）

#### Context

代管業者需要證明租金與押金和自有資金分開（BRD 第 1 節）。平台不持有款項，真相在銀行。平台要記一份能和銀行對帳、且事後不能被改的副本。押金結算要能算清楚扣抵與返還。每日分錄量估計在數千筆，低於萬級。

#### Decision

鏡像帳用 PostgreSQL 內的雙式分錄。分錄只增不改，更正用沖銷分錄。每筆分錄以 `(business_event_type, business_event_id)` 唯一關聯一個業務事件。借貸平衡用延遲約束觸發器在提交時檢查。UPDATE 與 DELETE 由觸發器禁止，應用角色也撤銷權限。押金台帳是鏡像帳上的視圖，不存餘額。

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

A 用日後可能的搬遷成本，換現在的一致性與低成本。B 的能力較完整，但現在的量級用不到。C 與 D 寫得快，但無法證明借貸平衡，也無法表達沖銷。這正是代管業者要證明的事。

#### Consequences

- 變容易：押金台帳、房東報表、移交包的錢段都從同一份分錄產生。
- 變困難：任何金額更正都要兩筆分錄。介面要讓使用者看懂沖銷。
- 要重看：每日分錄超過 1 萬筆，或需要多幣別時，評估選項 B。

#### Action Items

1. [ ] 定義科目編碼規則與押金案件的分錄範本。
2. [ ] 實作延遲約束觸發器與禁止更新觸發器，加測試。
3. [ ] 實作每日對帳與 `recon_exceptions` 流程。

### ADR-0013：案件 orchestrator 不採全面事件溯源

**Status:** Proposed
**Date:** 2026-10-29
**Deciders:** 待定（技術負責人）

#### Context

一筆租賃從擬約到押金結算，跨越房東、租客、代管業者、銀行。現有 `transitions.ts` 只管單一合約的六態狀態機。現有模式是純函式 `decideTransition()` 加同交易的 `commitTransition()`，狀態與 `contract_events` 一起寫入（ADR-0007）。流程裡有撥款這類不可回頭的步驟。

#### Decision

案件用「狀態表加 append-only 事件表」。延伸現有模式：純函式 `decideCaseTransition()` 決定下一狀態、事件與 outbox 任務，`dispatch()` 在同一交易寫入。用 `state_version` 做樂觀鎖。步驟分為可補償、不可回頭、可重試三類，不可回頭步驟前檢查全部前提。合約狀態機維持六態不變，案件依合約事件推進。

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

A 放棄「從事件重建任意時點」的能力。案件的讀取需求多為目前狀態，這個能力的價值低。事件表仍保存完整歷史，稽核與除錯足夠。C 的機制完整，但團隊規模未知，多一套基礎設施的維運負擔不划算。

#### Consequences

- 變容易：新增案件狀態只改純函式與測試。現有合約程式碼不用改。
- 變困難：計時器類需求，例如押金逾期未入帳，要由 worker 排程掃描。
- 要重看：買賣七段流程上線後，若計時器與補償規則超過 20 條，評估選項 C。

#### Action Items

1. [ ] 定義租賃案件狀態表與事件型別，寫純函式測試。
2. [ ] 實作 `dispatch()` 與 outbox，把已簽 PDF 保存改成 outbox 任務。
3. [ ] 定義每個不可回頭步驟的前提檢查清單。

### ADR-0014：產權錨點複合鍵與租賃單位 ID

**Status:** Proposed
**Date:** 2026-10-29
**Deciders:** 待定（產品負責人、技術負責人）

#### Context

現有 `properties` 只有名稱與地址，無法判斷兩筆物件是否為同一產權。門牌同址多戶、整編會變，地政與戶政版本可能不同【高】。建號只在地段內唯一【高】。分租套房沒有官方房間級識別碼。代管業者更換時，同一單位要能跨組織延續。BRD 風險 R13 指出，使用者不願提供建號的可能性為高。

#### Decision

產權錨點的業務唯一鍵是「縣市＋鄉鎮市區＋段小段＋建號（含分號）」，用地政編碼存放。主鍵用 ULID。錨點放在全域 `registry` schema，不掛組織 RLS，只經 `SECURITY DEFINER` 函式存取。沒有建號時以 `pending_verification` 登錄，附門牌與座標。租賃單位主鍵用平台自發 ULID，`(anchor_id, suffix)` 為唯一約束，`0000` 代表整戶。重複偵測分硬性層與軟性層。所有權與管理關係由出租權源表達，不寫在錨點上。

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
**選項 D 缺點：** 同一建號在不同組織各一筆，平台的差異化在物件錨點（BRD R08），D 讓它失效。

#### Trade-off

A 用一個例外的存取路徑，換跨組織唯一性。例外集中在兩個 `SECURITY DEFINER` 函式，能逐行審查。B 在待驗證與重測時會碰到改主鍵的問題。

#### Consequences

- 變容易：同一單位換代管業者時，資料延續到新組織。疑似重複能在登錄當下發現。
- 變困難：第二個組織登錄同一建號時，介面只能顯示「需人工審核」，不能透露另一個組織。錨點合併需要審核流程，每次合併寫稽核事件。
- 要重看：分租套房的輔助鍵。電號、水號是否可用，報告建議另查。

#### Action Items

1. [ ] 取得縣市、鄉鎮市區、段小段的地政編碼表，定義更新方式。
2. [ ] 實作 `registry.claim_unit()` 與 `registry.lookup_unit()`，加安全審查。
3. [ ] 定義軟性重複偵測的地址正規化規則與審核介面。
4. [ ] 在 `GLOSSARY.md` 加「產權錨點」與「租賃單位」。

## 9. 隨規模要重看的事

| 項目 | 觸發條件 | 要重看什麼 |
|---|---|---|
| 1. 鏡像帳的位置 | 每日分錄超過 1 萬筆，或需要多幣別 | 拆出獨立帳本資料庫或改用外部帳本服務（ADR-0012） |
| 2. 組織隔離模式 | 第一家銀行或大型建經要求獨立資料與金鑰，或單一組織造成鄰居干擾 | 啟動 database-per-tenant，驗證搬遷腳本與 migration 對多資料庫執行（ADR-0010） |
| 3. 權限模型 | 出現多層組織、文件級共享、反向查詢需求，或 `relation` 超過 15 種 | 遷移到 OpenFGA 或 SpiceDB，`authorize()` 換實作（5.5） |
| 4. 背景任務吞吐量 | outbox 積壓超過 5 分鐘，或 inbox 每秒超過 100 筆 | 引入訊息佇列，outbox 改成轉送到佇列 |
| 5. 稽核錨定週期與保存 | 客戶或主管機關要求更短的竄改偵測時間，或稽核表超過 1 億筆 | 縮短錨定週期、分割稽核表、評估 WORM 儲存 |

另外兩件事不隨規模觸發，但有明確時點。第一，三個灰區的函詢結果出來時，重看 `operation_mode: 'on_behalf'` 的動作清單。第二，法務確認身分驗證分級的適用動作後，重看每個 `Action` 的 `minIdentityLevel`。
