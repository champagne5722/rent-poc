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
| `db/migrations/0005_practitioner_assignments.sql` | `org.contract_practitioner_assignments`、`org.contract_credential_snapshots`，有 `org_id` 與 RLS（MIL-85） |
| `repository.ts` | 指派與判定事實快照的存取，第一個參數是 `OrgTx`，合約 ID 是 ULID，其餘 ID 一律 TEXT |
| `service.ts` | `evaluateSend`（組輸入、跑檢查）、`loadSeatOptions`（wizard 選項）、`validateAssignments`（存指派時）、`loadPrintedPractitioners`（PDF 簽署欄） |
| `send.ts` | `loadSendInputs`（交易內讀）、`prepareContractSend`（交易外檢查）、`recordSendSnapshots`（交易內保存判定事實快照） |

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

## 給 MIL-70（簽章紀錄）

- `contract_credential_snapshots` 在送簽時保存判定用的事實與結果（`facts`、`result` 是 JSON），一個席位一列，重複送簽時覆蓋。MIL-70 要把它改成與簽署進度同交易的 `snapshot_at_send`，並補 `snapshot_at_sign`。
- 事實裡有三層最新核對紀錄 ID（`latestCheckId`）。

## 給 MIL-76（同一人兼任）

- 目前當事人簽署人與執業人員是同一人時，email 重複，送簽前檢查回 `duplicate_email`。MIL-76 做合併後，改成合併再檢查。seed 假資料的陳怡君同時是北辰的當事人簽署人與專任管理人員，可直接當測試案例。

## 正式金鑰的判定

沿用 `DOTTEDSIGN_VERIFY_SIGNERS=1`（MIL-65），不從金鑰字串推斷。設為 `1` 且沒有真實 adapter 時，`getPracticeRegistry()` 回 `{ available: false }`，要求執業人員的組合在檢查、存指派與 wizard 都被擋下，原因文字是 `REGISTRY_UNAVAILABLE_REASON`。
