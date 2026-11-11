# 簽章分流（signature-routing）

簽署序列由規則表產生。依據是 ADR-0018 與 ADR-0021。所有法律假設都待法務確認（MIL-62）。

## 檔案

| 檔案 | 內容 |
| -- | -- |
| `rules.ts` | 規則表，ADR-0018 決議 5 的 13 列。`SIGNATURE_RULES_VERSION` 在這裡 |
| `route.ts` | `routeSignatures(facts)`，純函式 |
| `sequence.ts` | `buildSignerSequence(plan, assignees, signatureFields)`：組出簽署序列，同一人兼任時合併成一位簽署人（MIL-76）。另有 `findMergedSeats`、`seatSignerIndexes`、`fieldsOfSeat`。純函式 |
| `facts.ts` | 由合約類型與 `fields.routing` 組出分流事實，純函式 |
| `repository.ts` | `loadContractRoutingFacts(contractId)`，回傳 Promise。內部直接引用 `db.ts`，不在 `index.ts` 匯出 |
| `types.ts` | `RoutingFacts`、`PlannedSeat`、`SignatureRoute` |
| `seats.ts` | `evaluateRouting(stored, contractType = 'lease')`：分流條件換成畫面用的席位（`SeatView`）或擋下原因，稱謂依合約類型取字（MIL-74）。`printOrder`：簽署序列換成印列順序。`routingInputError(stored, contractType)`：存草稿時檢查形狀。`partyOnlySeats(contractType)`：退回的兩方席位。`signerChainLabels(seats, merges)`：合併後實際的簽署人，確認頁用（MIL-76）。純函式，client 與 server 都能引用 |
| `seat-fields.ts` | `seatOfField`、`countFieldsBySeat`、`reconcileSignatureFields`：簽署區域與席位的對應。有 `slot` 的歸該席位，沒有 `slot` 的舊資料歸同角色的第一個席位 |

## 規則表的 13 列

列在 `rules.ts` 的 `SEQUENCE_RULES`（12 列）與 `BROKER_APPEND_RULE`（第 6 列）。條件看文件類型與案件種類（ADR-0030 決議 2、3，MIL-197）。

列的 id 沒有改名。已凍結的簽章紀錄與簽署區域 `slot` 存的是 id，所以 id 沿用舊名。讀 id 時照下面的對照表換讀：

- id 中的 `master_lease` 是舊業務類型，指轉租案件。
- id 中的 `lessee_master_lessor` 指包租案件，也就是屋主租給包租業者那一份。
- 條件欄的 `master_lease` 是案件種類，指包租案件。

| 列 | 文件類型 | 條件（案件種類） | 列 id | 簽署序列 |
| -- | -- | -- | -- | -- |
| 1 | `management` | 委託管理案件 | `management.managed` | 甲方、執業人員、乙方 |
| 2 | `lease` | 租賃案件，業務類型自管 | `lease.self_managed` | 乙方、甲方 |
| 3 | `lease` | 租賃案件，業務類型代管 | `lease.managed` | 乙方、甲方 |
| 4 | `lease` | 轉租案件（`sublease`） | `lease.master_lease` | 乙方、執業人員、甲方 |
| 5 | `lease` | 包租案件（`master_lease`） | `lease.self_managed_lessee_master_lessor` | 甲方、執業人員、乙方 |
| 6 | `lease` | 有經紀業者居間 | `lease.broker` | 上列序列之後加經紀人 |
| 7 | `handover_certificate` | 租賃案件自管，或包租案件 | `handover_certificate.self_managed` | 不送簽（`not_required`） |
| 8 | `handover_certificate` | 租賃案件代管 | `handover_certificate.managed` | 乙方、甲方、執業人員 |
| 9 | `handover_certificate` | 轉租案件 | `handover_certificate.master_lease` | 乙方、執業人員、甲方 |
| 10 | `deposit_settlement` | 租賃案件、包租案件、轉租案件 | `deposit_settlement.all` | 乙方、甲方 |
| 11 | `deposit_refund_certificate` | 租賃案件自管，或包租案件 | `deposit_refund_certificate.self_managed` | 乙方、甲方 |
| 12 | `deposit_refund_certificate` | 租賃案件代管 | `deposit_refund_certificate.managed` | 乙方、甲方、執業人員 |
| 13 | `deposit_refund_certificate` | 轉租案件 | `deposit_refund_certificate.master_lease` | 乙方、執業人員、甲方 |

業務類型（自管、代管）只留給租賃案件（ADR-0030 決議 3），所以只有租賃案件的列再看業務類型。其他案件種類沒有業務類型。

第 7 與第 11 列的包租案件沿用自管那一列。版本 1 的點交證明、押金結算單與退還證明不帶「承租人是否為包租業者」，包租案件當時走自管那一列，版本 2 維持相同的序列。這個沿用待法務確認。

### 規則表版本

- 版本 1：條件看業務類型與「承租人是否為包租業者」。
- 版本 2：條件改看案件種類。列 id、席位、順序與依據都沒有改。

`SIGNATURE_RULES_VERSION` 是新送簽的序列帶的版本。`SUPPORTED_RULE_VERSIONS` 是仍能解讀的版本，目前是 1 與 2。`findSeatRule(ruleId, ruleVersion)` 由已凍結的 `rule_id` 找回規則列與席位。版本 2 只換條件，所以兩個版本共用同一份規則表。以後有列改了 id、席位或順序，必須保留舊版的列，並讓 `findSeatRule` 依版本找。

## routeSignatures 的輸入與輸出

輸入 `RoutingFacts`。每一份都帶 `documentType` 與 `caseKind`（案件種類）。`caseKind` 是 `lease` 時另帶 `businessType`（自管或代管）。只有 `lease` 文件帶 `brokerMediated`，缺少時拒絕。E 線不必傳其他旗標。

「承租人是否為包租業者」不再是分流事實，它已併入案件種類 `master_lease`（包租案件）。分流不讀 `lesseeIsMasterLessor`。

`documentType` 的值：`lease`、`management`、`handover_certificate`、`deposit_settlement`、`deposit_refund_certificate`。前兩個與 `contracts.contract_type` 相同。

輸出 `SignatureRoute` 有三種：

| `kind` | 意義 |
| -- | -- |
| `sequence` | 有簽署序列。`plan.seats` 依簽署順序排列 |
| `not_required` | 規則表有定義，但不送簽（點交證明，自管） |
| `rejected` | 規則表沒有這個組合，或事實不合法（不認得的文件類型、案件種類、業務類型）。沒有預設序列 |

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

- 沒有 `fields.routing` 的 `lease` 合約，視為租賃案件自管、無居間。
- 沒有 `fields.routing` 的 `management` 合約，視為委託管理案件。
- 三個鍵必須都在，且型別正確。形狀不對時 `loadContractRoutingFacts` 回傳 `invalid_routing`，不退回預設值。
- 文件類型由 `contracts.contract_type` 決定，不存在 `fields.routing`。
- 快照換成案件種類（`facts.ts`，換法同 `caseKindOf`）：自管且承租人是包租業者是包租案件，業務類型 `master_lease` 是轉租案件，其餘是租賃案件。
- 欄位互相矛盾的快照換不成案件種類：代管或轉租搭承租人是包租業者，委託管理合約搭代管以外的業務類型。`routingFactsOf` 回 `undefined_combination`，不給預設序列。存草稿時不擋，畫面與送簽時擋下。

寫入者：建約 wizard 第一步（MIL-67）。`/contracts/new` 建草稿時隨 `POST /api/contracts` 寫入，草稿的第①步改條件時隨 `PUT` 存回。C 線建案件後，值改由案件提供，既有合約維持快照。

E 線不經過這個欄位。E 線自己組 `RoutingFacts`，直接呼叫 `routeSignatures`。

## 執業人員的指派（MIL-69）

- 指派、`practiceRegistry`、送簽前檢查與判定事實快照見 `src/lib/practitioner-assignment/README.md`。
- `prepareContractSigners(contract, facts, practitioners)` 的第三個參數是執業人員席位的簽署人，沒傳入時要求執業人員的組合仍會被擋下。資格檢查在 `checkSendPreconditions`，這裡不重複。

## 同一人兼任的合併（MIL-76，ADR-0018 決議 9）

判定條件：執業人員席位的執業主體是甲方或乙方，當事人簽署人與執業人員的 `partyId` 相同，而且當事人簽署人屬於同一執業主體。`partyId` 與 `entityId` 放在 `SeatAssignee.identity`，由登錄資料提供（`PartySignerCandidate.partyId`、`PractitionerCandidate.partyId`）。沒有帶身分資料的席位不合併。

合併的結果：

- 兩個席位成為一位簽署人，排在執業人員席位的位置，主要角色是 `practitioner`，`concurrentRoles` 放被併入的當事人角色。
- email 與姓名取自執業人員。兩個席位的簽署區域都歸這位簽署人，一個 stage 帶多個 `field_settings`。
- 其後的席位往前補。居間加包租合併後是三位：乙方、合併的簽署人、經紀人。
- 經紀人席位的執業主體不是合約當事人，不合併。

三個函式共用同一份判定，送簽前檢查與組簽署序列不會不一致：

```ts
findMergedSeats(plan, identities): MergedSeats[]
// MergedSeats = { practitionerRuleId, partyRuleId, partyRole }
seatSignerIndexes(plan, merged): Record<ruleId, number>
// 席位在簽署序列中的位置。兼任的當事人席位與執業人員席位同一個位置
fieldsOfSeat(plan, ruleId, signatureFields): SignatureField[]
// 歸屬某個席位的簽署區域。送簽前逐席位檢查有沒有簽署區域
```

簽章紀錄的 `signerIndex` 用 `seatSignerIndexes`，所以紀錄參照的是合併後的簽署人。簽署中失效（MIL-75）以 `rule_id` 為鍵，每個執業人員席位一列，合併與四位都成立。

## 尚未做的事

- 無。`requiredFieldPages` 的 `status_annex` 檢查已在 MIL-71 完成，見下一節。

## 簽署欄與簽署區域（MIL-67）

- PDF 簽署欄依簽署序列印 N 列。版面是 `src/lib/pdf-layout.ts` 的 `signatureBlockLayout(seats)`，印列順序固定甲方、乙方、執業人員。兩方合約的落點不變，`src/lib/pdf-two-party.golden.json` 是改動前的逐字位置，測試逐字比對。
- 尚未指派的執業人員簽署欄印姓名與執業主體的底線。已指派時 `generateContractPdf(fields, practitioners)` 傳入姓名、法定稱謂與執業主體（MIL-69），不印證號。
- 簽署區編輯器依 `SeatView[]` 提供新增按鈕，新增的框寫入 `slot`。按鈕依印列順序排，與簽署順序無關。
- 送簽前的原因清單是 `contract-wizard.ts` 的 `sendBlockReasons`。沒有指派的執業人員席位列為「尚未指派」。資格由伺服器的 `checkSendPreconditions` 判定，確認頁併入列出。

## 分流事實取自案件（MIL-200）

`loadContractRoutingFacts` 在合約掛在案件下時，案件種類與租賃案件的業務類型讀案件列（`org.cases.case_kind`、`business_type`），不讀合約的欄位快照。快照 `fields.routing` 仍保存建約當時的條件，不回寫；「是否有居間」只存在快照裡，所以仍讀快照。沒有案件的合約仍由快照推導。案件的資料不一致（租賃案件沒有自管或代管的業務類型）時不猜，沿用快照推導的結果。

## 現況確認附件頁（MIL-71）

- `requiredFieldPages` 含 `status_annex` 的席位必須在附件頁有簽署區域。第一版只有 `lease.master_lease.practitioner`。
- `missingStatusAnnexSeats(plan, signatureFields, statusAnnexPage)`：伺服器用，回傳缺少的 `PlannedSeat`。`seatViewsMissingStatusAnnex(seats, signatureFields, statusAnnexPage)`：編輯器與 wizard 用。判定相同，沒有附件頁（null）時後者不提示，前者視為全部缺少。
- `SeatView.requiresStatusAnnex`：規則列要求這個席位在附件頁簽章。
- `body` 頁的要求維持原狀：席位至少一個簽署區域。不另檢查「本文頁」。
- 附件頁的頁碼是 PDF 的 0-based 頁碼，與點點簽 `field_settings[].page`（從 0 起算）一致。
