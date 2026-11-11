<!-- ste-lint: off -->
<!-- 模組說明給開發者與 agent 讀，內容是介面與接點清單，句長規則不適用 -->
# 合約類型定義（`src/lib/contract-types/`）

MIL-73 的成果。欄位、範本與檢核由合約類型決定，共用流程（建約 wizard、送簽、清單）只經這個模組取用，不判斷具體類型。模組只有純資料與純函式，沒有 fs，client 端的 wizard 也能引用。

## 結構

| 檔案 | 內容 |
|---|---|
| `types.ts` | `ContractTypeDefinition<F>` 介面、`PartyIdentity`、`ContractListSummary` |
| `lease.ts` | 租賃合約的定義。必填欄位檢核、建立草稿欄位、當事人取值，從原本的 wizard 與 `POST /api/contracts` 搬來 |
| `management.ts` | 委託管理合約的定義（MIL-74）。兩方當事人、委託期間、報酬約定的必填檢核，`mergeManagementFields`，建立草稿時綁範本 v1。`sendSupported` 是 `false`，送簽屬 MIL-77 |
| `lease-family.ts` | 包租合約與轉租合約共用的檢核、當事人取值與建立草稿（MIL-199）。公告限制：租期不得少於三十日，押金最高不得超過二個月租金 |
| `master-lease.ts` | 包租合約的定義（MIL-199）。出租人與包租業，條文依住宅包租契約應約定事項。不附現況確認附件 |
| `sublease.ts` | 轉租合約的定義（MIL-199）。包租業與承租人，條文依住宅轉租契約應記載事項。現況確認附件跟著轉租合約，必附與否看簽章分流規則表 |
| `case-kind.ts` | `contractTypeForCaseKind`：建立合約的地方由案件種類決定合約類型（包租案件建包租合約，轉租案件建轉租合約）。反向的 `caseKindForContractType`，與過渡用的分流條件快照 `routingSnapshotFor` |
| `index.ts` | 登錄表 `DEFINITIONS` 與依類型取用的入口函式 |

## 介面

`ContractTypeDefinition<F>`：

| 成員 | 用途 |
|---|---|
| `type`、`documentName`、`labels` | 類型識別字、文件名稱（送簽檔名前綴）、甲乙方稱謂（取自 `src/lib/labels`） |
| `templates`、`optionalClauses` | 這個類型的範本與選用條款庫，取自 `src/lib/template-registry.ts` |
| `party(fields, role)`、`withParty(...)` | 取或寫甲方、乙方的姓名與 email |
| `partyFieldLabels(role)` | 當事人欄位的標籤，執業主體是該方時這兩欄由簽署人帶入 |
| `missingFields(fields, attachments?)` | 建約 wizard 第②步的必填檢核。`attachments` 帶欄位以外、另存子表的內容（委託標的清單），沒帶就不檢查那一項 |
| `missingFieldsForSend(fields, attachments?)` | 送簽 route 的必填檢核，回應文字沿用原本的 |
| `sendSupported` | 這個類型能不能送簽。送簽 route 與 wizard 第④步都看它，不判斷具體類型 |
| `initialFields({ property?, routing? })` | 建立草稿的欄位快照。租賃合約必須帶物件，委託管理合約不帶 |
| `listSummary(fields)` | 清單與工作台一列的摘要：物件、租金、乙方、期間 |

依類型取用的入口（傳入 `{ contract_type, fields }`，`Contract` 符合這個形狀）。`missingFieldsOf`、`missingFieldsForSendOf` 有選填的第二個參數 `attachments`：
`partyOf`、`withParty`、`missingFieldsOf`、`missingFieldsForSendOf`、`initialFieldsFor`、`listSummaryOf`、`partyFieldLabels`、`partyOfFields`。

## 欄位型別

`Contract` 是以 `contract_type` 判別的聯集：`LeaseContract`、`ManagementContract`、`MasterLeaseContract`、`SubleaseContract`（MIL-199）。三種租賃類合約共用 `LeaseTermsFields`（兩方當事人、物件快照、租金、押金、租期），包租與轉租合約另有 `terms`（公告的選項型約定，沒填用 `lease-family-terms.ts` 的預設值）。`isLeaseFamilyContract` 判斷是不是租賃類合約。欄位物件本身不帶類型，既有合約沒有類型欄位前建立，讀入後 `contract_type` 是 `lease`。`ContractFields` 是兩種欄位的聯集。租賃專用程式（PDF、條款、詳情頁）收 `LeaseContractFields` 或 `LeaseContract`，要從 `Contract` 取得它，先檢查 `contract_type === 'lease'`。

## 周邊的接點

| 位置 | 內容 |
|---|---|
| `src/lib/template-registry.ts` | 範本登錄。`templatesFor`、`currentTemplate`、`boundTemplateOf`、`isLegalReviewed`。法務審閱旗標是 `ContractTemplate.legalReviewed` |
| `src/lib/template-review.ts` | `templateReviewBlock`。正式金鑰（`DOTTEDSIGN_VERIFY_SIGNERS=1`）下，未審閱範本的送簽被擋下 |
| `src/lib/practitioner-assignment/send.ts` | `prepareContractSend` 在送簽前原因清單加上 `template_not_reviewed` |
| `src/lib/contract-pdf.ts` | 依類型產出 PDF。`contractPdfRenderer(type)`，沒有 PDF 的類型回 `null`。`render(fields, practitioners, attachments?)`，委託管理合約的附件頁從 `attachments.mandateItems` 取清單 |
| `src/lib/management-clauses.ts` | 委託管理契約書條文，`buildManagementClauses(fields)`，欄位進、條文出（MIL-74） |
| `src/lib/master-lease-clauses.ts`、`src/lib/sublease-clauses.ts` | 住宅包租契約與住宅轉租契約條文（MIL-199）。條號與公告點次一一對應，每條帶公告點次。公告原文在 `docs/research/asset-mgmt-platform/legal-sources/` |
| `src/lib/pdf-lease-family.ts` | 包租合約與轉租合約的 PDF。文件上印法定稱謂，不印「甲方」「乙方」。現況確認附件只有轉租合約 |
| `src/lib/mandate-schedule/` | 委託標的清單與委託範圍（MIL-74）：純函式、表 `contract_mandate_items`、repository，見該資料夾的 README |
| `src/components/contract-wizard/` | 建約 wizard 的類型畫面登錄。`wizardUiFor(type)` 回傳 `WizardTypeUi`，沒有畫面的類型回 `null` |
| `src/lib/contract-list.ts` | 清單欄名依類型取字。`listPartyBColumn` 等 |

## 新增合約類型要做的事

1. 在 `src/lib/labels` 的 `ContractType` 加值與稱謂。
2. 在 `src/lib/types.ts` 加欄位型別與 `Contract` 的成員。
3. 在這個資料夾寫一份定義，加進 `DEFINITIONS`。
4. 在 `template-registry.ts` 加範本與選用條款庫，旗標預設 `legalReviewed: false`。
5. 在 `contract-pdf.ts` 加產出函式。
6. 在 `src/components/contract-wizard/index.ts` 加畫面。

`DEFINITIONS`、`TEMPLATES`、`RENDERERS` 與 `WIZARD_UI` 都是以 `ContractType` 為鍵的 `Record`，漏一個編譯不過。

## 四種合約類型（MIL-199）

| 合約類型 | 法定文件名 | 甲方 | 乙方 | 範本 |
|---|---|---|---|---|
| `lease` | 住宅租賃契約 | 出租人 | 承租人 | `residential-lease` v2 |
| `management` | 委託管理租賃住宅契約書 | 委託人 | 受託人 | `management-agreement` v1 |
| `master_lease` | 住宅包租契約 | 出租人（屋主） | 包租業 | `master-lease-agreement` v1 |
| `sublease` | 住宅轉租契約 | 包租業 | 承租人 | `sublease-agreement` v1 |

- 新類型值與案件種類同名同義。舊業務類型的 `master_lease` 指轉租，與這裡相反。
- 既有合約不回填，仍是 `lease`。簽章分流規則表不動，`documentType` 維持 `lease`。
- 兩份新範本的 `legalReviewed` 是 `false`，正式金鑰下送簽被 `templateReviewBlock` 擋下。
- 範本的選項型約定存在 `fields.terms`，建約精靈目前沒有編輯畫面，欄位由後續的票接上。

## 已知缺口（留給 MIL-76、MIL-77）

- MIL-74 已讓 `evaluateRouting(stored, contractType)` 依類型取稱謂，簽署欄與席位檢核用「甲方（委託人）」「乙方（受託人）」。`pruneAssignments`、`applyRoutingChange` 等 wizard 函式也帶類型，沒帶時是租賃合約。MIL-76 改同一人合併時要留意這個簽名。
- 簽署區編輯器的簽名頁已改由 PDF 版面判定（`pdf-layout.ts` 的 `pageMapFromTexts`，找「立契約書人」所在的頁，找不到才退回最後一頁），有設備附件、現況確認附件或委託標的清單附件的合約，預設落點都在簽名頁（MIL-162、MIL-71）。
- 委託管理合約的送簽、詳情頁與簽署模組的訂閱者屬 MIL-77。`sendSupported` 在那時改成 `true`。
- `src/app/contracts/[id]/page.tsx` 的型別是 `LeaseContract`，沒有執行期檢查。委託管理合約的詳情頁屬 MIL-77。
- `WizardState.contractType`、`missingFieldLabels` 等函式沒帶類型時預設租賃合約（`DEFAULT_CONTRACT_TYPE`），為了讓既有呼叫端與測試不必改。新程式碼必須傳入類型。
- 送簽前檢查的原因清單只在伺服器的送簽 route 帶 `template_not_reviewed`，wizard 第④步的預檢（`GET /api/contracts/[id]/practitioners`）不含它。使用者按下送簽後，由既有的錯誤提示顯示原因。
