<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 的對照，句長規則不適用 -->
# 執業人員的指派（MIL-69）

依據：ADR-0018 決議 2、10、14、ADR-0021 決議 3、4、ADR-0017 決議 6、8。法律假設都待法務確認（MIL-62）。

包租業者在建約 wizard 選執業主體、當事人簽署人與專任管理人員。送簽前系統檢查人選，不符時列出全部原因。通過後三位依序簽署。

## 模組與檔案

| 位置 | 內容 | 純函式 |
|---|---|---|
| `src/lib/credential-status/` | `credentialStatusAt(facts, at)`：三層狀態、效期、任職期間、換證窗口 | 是 |
| `src/lib/send-preconditions/` | `checkSendPreconditions(facts)`：ADR-0018 決議 10 的 7 項，併入 B 線的出租權源前提 | 是 |
| `src/lib/practice-registry/` | `practiceRegistry` seam：介面、seed 假資料 adapter、依環境選 adapter | seed adapter 是 |
| `src/lib/practitioner-assignment/` | 指派的表與 repository、`evaluateSend`、`loadSeatOptions`、`prepareContractSend` | 見下 |

本目錄：

| 檔案 | 內容 |
|---|---|
| `seats.ts` | 純函式與型別，client 可引用：`licenseKindForSeat`、`entityPartyRoles`、`PractitionerAssignmentInput`、`PrintedPractitioner` |
| `db/migrations/0005_practitioner_assignments.sql` | `org.contract_practitioner_assignments`，有 `org_id` 與 RLS（MIL-85）。判定事實快照表 `contract_credential_snapshots` 已由 `0009_signature_records.sql` 移除 |
| `repository.ts` | 指派的存取，第一個參數是 `OrgTx`，合約 ID 是 ULID，其餘 ID 一律 TEXT |
| `service.ts` | `evaluateSend`（組輸入、跑檢查）、`loadSeatOptions`（wizard 選項）、`validateAssignments`（存指派時）、`loadPrintedPractitioners`（PDF 簽署欄） |
| `send.ts` | `loadSendInputs`（交易內讀）、`prepareContractSend`（交易外檢查，通過後交出簽署人與 `sendContext`，也就是簽章紀錄的送簽資料） |

## 簽名

```ts
credentialStatusAt(facts: CredentialFacts, at: string, config?): CredentialStatus
// at 是 ISO 8601，以台灣日期比對。signable 為 true 時帶 renewalWindow（換證窗口內有值）

checkSendPreconditions(facts: SendPreconditionFacts): SendPreconditionResult
// { ok, reasons, notices }。reasons 一次列完，不綁合約 ID
```

`CredentialFacts` 是 `{ license, practitioner, employment }` 三層，每層 `{ state, latestCheckId, ... }`。業別與證書層有 `validUntil`，任職層有 `startsOn`、`endsOn`。形狀照 `src/lib/registry-rules/README.md` 的 MIL-113 接點。

## 給 C 線 MIL-113

- 實作 `PracticeRegistry`（`practice-registry/types.ts`）：`listEntities`、`getEntity`、`listPartySigners`、`getPartySigner`、`listPractitioners`、`getPractitioner`。通過 `registry.contract.test.ts` 的契約測試，把 factory 換成真實 adapter 即可。
- MIL-113 已完成：真實 adapter 在請求時接上，不需要啟動註冊。說明見 `src/lib/practice-registry/README.md`。
- 判定事實的業別層是查詢時指定的那一種業別（`licenseKind`），因為執業主體得兼營。
- `credentialStatusAt` 的證書層：已驗證卻沒有 `validUntil` 時不放行。業別層沒有 `validUntil` 代表不設期限。
- `checkSendPreconditions` 第 2 項：C 線建案件後，把 `signers` 裡執業人員的來源從「合約的指派」改成「案件的 `practitioner` 成員」。檢查函式不改。`entities`（各取得來源指向的執業主體）也改由案件提供。
- 指派表 `contract_practitioner_assignments` 是過渡做法。MIL-200 起，合約掛在案件下時改存案件成員（見下節「簽章人員只從自家指派」），只有沒有案件的合約仍用這張表（MIL-203 移除）。

## 給 E 線 MIL-131

- 直接呼叫 `checkSendPreconditions({ routing, at, entities, signers, registryAvailable })`。`routing` 用 `RoutingFacts` 的非租賃形狀，`entities['case_mandatary']` 填案件的受託人執業主體。
- 簽署人清單不綁合約 ID，用席位 `rule_id` 對應。
- `credentialStatusAt` 簽署當下用事件時間，不用系統收到的時間。

## MIL-70（簽章紀錄）已完成

判定事實快照改由簽章紀錄承接，`contract_credential_snapshots` 與 `recordSendSnapshots` 已移除。
`prepareContractSend` 回傳 `sendContext`，呼叫 `signing.send(subject, document, signers, { context: sendContext })` 時由合約訂閱者在送簽交易內寫入。
說明見 `src/lib/signature-records/README.md`。

## 同一人兼任與經紀人（MIL-76）已完成

- `evaluateSend` 多回傳 `identities`（席位簽署人的 `partyId` 與執業主體）與 `merges`（要合併的席位）。`prepareContractSend` 把 `identities` 交給 `prepareContractSigners`，簽署序列合併成一位簽署人。
- `checkSendPreconditions` 第 7 項在合併後檢查 email。同一人兼任不算重複，執業人員同時是相對人、兩人共用信箱仍擋下。
- 簽章紀錄的 `signerIndex` 是合併後的位置。紀錄的 `concurrentRoles` 取自簽署人的 `concurrentRoles`。送簽時合約歷程多一筆 `signers_merged`。
- 經紀人席位只能綁定不動產經紀人。`validateAssignments` 指派不動產經紀營業員時拒絕並說明，已存的指派原樣再存也拒絕。選單不列出營業員，席位帶說明（`SeatOption.notice`）。
- 登錄資料的候選多一個必填欄位 `partyId`，見下節。

## 給 C 線 MIL-113 與 116（MIL-76 之後）

- `PartySignerCandidate` 與 `PractitionerCandidate` 多一個必填欄位 `partyId`：自然人的 party ID。同一個人以兩種身分出現時，兩邊相同。合併靠它判定，真實 adapter 要提供，契約測試已加一項。
- 合併的另一個條件是兩者的 `entityId` 相同。當事人簽署人的 `entityId` 是 `PartySignerCandidate.entityId`，執業人員的是 `PractitionerCandidate.entityId`。
- MIL-200 把指派搬到案件成員時，`evaluateSend` 回傳的 `identities` 與 `merges` 照樣算。身分資料來源換成案件成員，`findMergedSeats` 不改。

## 簽章人員只從自家指派（MIL-200）

依據：ADR-0029 決議 3。任何組織都只能指派自己組織的人，查別的組織的人，回應與查無資料相同。資料庫那一側的規則在 `src/lib/practice-registry/README.md`。

| 項目 | 做法 |
|---|---|
| 選項 | `loadSeatOptions` 的回傳只有姓名，不含 email。`EntityOption.partySigners` 是 `{ id, name }`，`PractitionerOption` 沒有 `email` |
| 存指派 | `validateAssignments` 只認自家組織的執業主體（`registry.listEntities()` 找得到才算）。別的組織的與不存在的，執業主體、人員、簽署人各用同一句訊息：`NOT_OWN_ASSIGNMENT`、`NOT_OWN_PRACTITIONER`、`NOT_OWN_PARTY_SIGNER` |
| 補 email | `resolveAssignmentFacts` 用「依 ID 查單筆」讀執業人員的 party 與當事人簽署人的真實 email。route 在寫入的交易內把姓名與 email 補進合約的甲方或乙方欄位。瀏覽器只知道姓名 |
| 來源 | 合約掛在案件下：指派存成案件成員（`org.case_members` 的 `slot`、`entity_id`、`employment_id`、`party_signer_id`，migration 0084），`relation` 是 `practitioner` 或 `broker`。沒有案件：仍用 `contract_practitioner_assignments` |
| 寫入權限 | 合約掛在案件下時，PUT 還要 `case_member.manage`（主辦組織的 admin、staff） |
| 送簽前提 | `getAssignments` 依合約有沒有案件讀案件成員或舊表，`evaluateSend` 不變。搬資料搬不動的舊列（沒有案件、別的組織的執業主體、任職查不到）留在舊表，案件裡沒有那個席位時仍讀得到，送簽前檢查會說明原因 |
| 分流條件 | 合約掛在案件下時，案件種類與業務類型讀案件列（`loadContractRoutingFacts`），不讀合約快照。快照不回寫，「是否有居間」仍存在快照 |
| 居間 | `broker-guard.ts`：只看呼叫者自己組織的 `registry.my_registration()`。屋主與平台組織不顯示居間選項，也不提示；執業主體組織的經紀業別已驗證才可勾；登錄了未驗證時顯示成不能選並寫原因；沒有登錄經紀業別不顯示。屋主組織送 `brokerMediated: true` 回 409 `broker_not_allowed` |

仍走舊表的地方（給 MIL-203）：`replaceAssignments`、`getAssignments`、`copyAssignments` 裡 `caseId` 為空的分支；沒有案件的合約（舊建約路徑，業者組織走 `POST /api/contracts` 不帶 `case_kind`）；`ContractWizard` 的 `loadPractitioners` 對兩種來源一視同仁，不必改。

## 正式金鑰的判定

沿用 `DOTTEDSIGN_VERIFY_SIGNERS=1`（MIL-65），不從金鑰字串推斷。設為 `1` 且指定 `PRACTICE_REGISTRY=seed`（沒有真實 adapter）時，`getPracticeRegistry()` 回 `{ available: false }`，要求執業人員的組合在檢查、存指派與 wizard 都被擋下，原因文字是 `REGISTRY_UNAVAILABLE_REASON`。
