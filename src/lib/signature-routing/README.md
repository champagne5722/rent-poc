# 簽章分流（signature-routing）

簽署序列由規則表產生。依據是 ADR-0018 與 ADR-0021。所有法律假設都待法務確認（MIL-62）。

## 檔案

| 檔案 | 內容 |
| -- | -- |
| `rules.ts` | 規則表，ADR-0018 決議 5 的 13 列。`SIGNATURE_RULES_VERSION` 在這裡 |
| `route.ts` | `routeSignatures(facts)`，純函式 |
| `sequence.ts` | `buildSignerSequence(plan, assignees, signatureFields)`，純函式 |
| `facts.ts` | 由合約類型與 `fields.routing` 組出分流事實，純函式 |
| `repository.ts` | `loadContractRoutingFacts(contractId)`，回傳 Promise。內部直接引用 `db.ts`，不在 `index.ts` 匯出 |
| `types.ts` | `RoutingFacts`、`PlannedSeat`、`SignatureRoute` |
| `seats.ts` | `evaluateRouting(stored)`：分流條件換成畫面用的席位（`SeatView`）或擋下原因。`printOrder`：簽署序列換成印列順序。`routingInputError`：存草稿時檢查形狀。純函式，client 與 server 都能引用 |
| `seat-fields.ts` | `seatOfField`、`countFieldsBySeat`、`reconcileSignatureFields`：簽署區域與席位的對應。有 `slot` 的歸該席位，沒有 `slot` 的舊資料歸同角色的第一個席位 |

## 規則表的 13 列

列在 `rules.ts` 的 `SEQUENCE_RULES`（12 列）與 `BROKER_APPEND_RULE`（第 6 列）。

| 列 | 文件類型 | 條件 | 簽署序列 |
| -- | -- | -- | -- |
| 1 | `management` | `managed` | 甲方、執業人員、乙方 |
| 2 | `lease` | `self_managed` | 乙方、甲方 |
| 3 | `lease` | `managed` | 乙方、甲方 |
| 4 | `lease` | `master_lease` | 乙方、執業人員、甲方 |
| 5 | `lease` | `self_managed`，承租人是包租業者 | 甲方、執業人員、乙方 |
| 6 | `lease` | 有經紀業者居間 | 上列序列之後加經紀人 |
| 7 | `handover_certificate` | `self_managed` | 不送簽（`not_required`） |
| 8 | `handover_certificate` | `managed` | 乙方、甲方、執業人員 |
| 9 | `handover_certificate` | `master_lease` | 乙方、執業人員、甲方 |
| 10 | `deposit_settlement` | 全部 | 乙方、甲方 |
| 11 | `deposit_refund_certificate` | `self_managed` | 乙方、甲方 |
| 12 | `deposit_refund_certificate` | `managed` | 乙方、甲方、執業人員 |
| 13 | `deposit_refund_certificate` | `master_lease` | 乙方、執業人員、甲方 |

## routeSignatures 的輸入與輸出

輸入 `RoutingFacts`。只有 `lease` 帶 `lesseeIsMasterLessor` 與 `brokerMediated`，缺少時拒絕。其他四種文件只帶 `documentType` 與 `businessType`，E 線不必傳其他旗標。

`documentType` 的值：`lease`、`management`、`handover_certificate`、`deposit_settlement`、`deposit_refund_certificate`。前兩個與 `contracts.contract_type` 相同。

輸出 `SignatureRoute` 有三種：

| `kind` | 意義 |
| -- | -- |
| `sequence` | 有簽署序列。`plan.seats` 依簽署順序排列 |
| `not_required` | 規則表有定義，但不送簽（點交證明，自管） |
| `rejected` | 規則表沒有這個組合。沒有預設序列 |

每個席位（`PlannedSeat`）有 `ruleId`、`role`、`statuteRef`、`verifyMethods`、`requiredFieldPages`。執業人員席位另有 `practitioner`：`certificateKinds`、`fullTime`、`entitySource`。

`ruleId` 在同一份序列內唯一，同時是簽署區域 `slot` 的值。

## fields.routing 的形狀

分流條件存在合約欄位快照的 `fields.routing`（ADR-0021 決議 1）。型別是 `ContractRoutingConditions`，定義在 `src/lib/types.ts`。

```ts
fields.routing = {
  businessType: 'self_managed' | 'managed' | 'master_lease',
  lesseeIsMasterLessor: boolean,
  brokerMediated: boolean,
}
```

讀取規則：

- 沒有 `fields.routing` 的 `lease` 合約，視為 `self_managed`、承租人不是包租業者、無居間。
- 沒有 `fields.routing` 的 `management` 合約，業務類型視為 `managed`。
- 三個鍵必須都在，且型別正確。形狀不對時 `loadContractRoutingFacts` 回傳 `invalid_routing`，不退回預設值。
- 文件類型由 `contracts.contract_type` 決定，不存在 `fields.routing`。

寫入者：建約 wizard 第一步（MIL-67）。`/contracts/new` 建草稿時隨 `POST /api/contracts` 寫入，草稿的第①步改條件時隨 `PUT` 存回。C 線建案件後，值改由案件提供，既有合約維持快照。

E 線不經過這個欄位。E 線自己組 `RoutingFacts`，直接呼叫 `routeSignatures`。

## 執業人員的指派（MIL-69）

- 指派、`practiceRegistry`、送簽前檢查與判定事實快照見 `src/lib/practitioner-assignment/README.md`。
- `prepareContractSigners(contract, facts, practitioners)` 的第三個參數是執業人員席位的簽署人，沒傳入時要求執業人員的組合仍會被擋下。資格檢查在 `checkSendPreconditions`，這裡不重複。

## 尚未做的事

- `requiredFieldPages` 的 `status_annex` 檢查：MIL-71。
- 同一人兼任的合併：MIL-76。`buildSignerSequence` 目前每個席位各是一位簽署人。

## 簽署欄與簽署區域（MIL-67）

- PDF 簽署欄依簽署序列印 N 列。版面是 `src/lib/pdf-layout.ts` 的 `signatureBlockLayout(seats)`，印列順序固定甲方、乙方、執業人員。兩方合約的落點不變，`src/lib/pdf-two-party.golden.json` 是改動前的逐字位置，測試逐字比對。
- 尚未指派的執業人員簽署欄印姓名與執業主體的底線。已指派時 `generateContractPdf(fields, practitioners)` 傳入姓名、法定稱謂與執業主體（MIL-69），不印證號。
- 簽署區編輯器依 `SeatView[]` 提供新增按鈕，新增的框寫入 `slot`。按鈕依印列順序排，與簽署順序無關。
- 送簽前的原因清單是 `contract-wizard.ts` 的 `sendBlockReasons`。沒有指派的執業人員席位列為「尚未指派」。資格由伺服器的 `checkSendPreconditions` 判定，確認頁併入列出。
