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
| `tables.ts` | `contract_practitioner_assignments`，由 `ensureSchema` 建立 |
| `repository.ts` | 指派的存取，介面回傳 Promise。ID 一律 TEXT |
| `service.ts` | `evaluateSend`（組輸入、跑檢查）、`loadSeatOptions`（wizard 選項）、`validateAssignments`（存指派時）、`loadPrintedPractitioners`（PDF 簽署欄） |
| `send.ts` | `prepareContractSend`：route handler 與整合測試共用的送簽準備，通過後交出簽署人與 `sendContext`（簽章紀錄的送簽資料） |

## 簽名

```ts
credentialStatusAt(facts: CredentialFacts, at: string, config?): CredentialStatus
// at 是 ISO 8601，以台灣日期比對。signable 為 true 時帶 renewalWindow（換證窗口內有值）

checkSendPreconditions(facts: SendPreconditionFacts): SendPreconditionResult
// { ok, reasons, notices, leasingAuthorityFacts }。reasons 一次列完，不綁合約 ID
```

`CredentialFacts` 是 `{ license, practitioner, employment }` 三層，每層 `{ state, latestCheckId, ... }`。業別與證書層有 `validUntil`，任職層有 `startsOn`、`endsOn`。形狀照 `src/lib/registry-rules/README.md` 的 MIL-113 接點。

## 給 C 線 MIL-113

- 實作 `PracticeRegistry`（`practice-registry/types.ts`）：`listEntities`、`getEntity`、`listPartySigners`、`getPartySigner`、`listPractitioners`、`getPractitioner`。通過 `registry.contract.test.ts` 的契約測試，把 factory 換成真實 adapter 即可。
- 啟動時呼叫 `registerLivePracticeRegistry(adapter)`。有註冊就任何環境都用它，正式環境不再被擋下。
- 判定事實的業別層是查詢時指定的那一種業別（`licenseKind`），因為執業主體得兼營。
- `credentialStatusAt` 的證書層：已驗證卻沒有 `validUntil` 時不放行。業別層沒有 `validUntil` 代表不設期限。
- `checkSendPreconditions` 第 2 項：C 線建案件後，把 `signers` 裡執業人員的來源從「合約的指派」改成「案件的 `practitioner` 成員」。檢查函式不改。`entities`（各取得來源指向的執業主體）也改由案件提供。
- 指派表 `contract_practitioner_assignments` 是過渡做法。案件成員完成後，用案件成員取代，這張表與 `evaluateSend` 的 `assignments` 來源一起換掉。

## 給 E 線 MIL-131

- 直接呼叫 `checkSendPreconditions({ routing, at, entities, signers, registryAvailable })`。`routing` 用 `RoutingFacts` 的非租賃形狀，`entities['case_mandatary']` 填案件的受託人執業主體。
- 簽署人清單不綁合約 ID，用席位 `rule_id` 對應。
- `credentialStatusAt` 簽署當下用事件時間，不用系統收到的時間。

## MIL-70（簽章紀錄）已完成

判定事實快照改由簽章紀錄承接，`contract_credential_snapshots` 與 `recordSendSnapshots` 已移除。
`prepareContractSend` 回傳 `sendContext`，呼叫 `signing.send(subject, document, signers, sendContext)` 時由合約訂閱者在送簽交易內寫入。
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
- MIL-116 把指派搬到案件成員時，`evaluateSend` 回傳的 `identities` 與 `merges` 要照樣算。身分資料來源換成案件成員，`findMergedSeats` 不改。

## 正式金鑰的判定

沿用 `DOTTEDSIGN_VERIFY_SIGNERS=1`（MIL-65），不從金鑰字串推斷。設為 `1` 且沒有真實 adapter 時，`getPracticeRegistry()` 回 `{ available: false }`，要求執業人員的組合在檢查、存指派與 wizard 都被擋下，原因文字是 `REGISTRY_UNAVAILABLE_REASON`。
