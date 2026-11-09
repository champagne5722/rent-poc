<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 的對照，句長規則不適用 -->
# 簽章紀錄（MIL-70）

依據：ADR-0018 決議 12、決議 11、ADR-0017 決議 10。法律假設都待法務確認（MIL-62）。

簽章紀錄只為執業人員寫一列，參照簽署人列（`signers.id`）。送簽時在簽署模組的送簽交易內寫 `snapshot_at_send`，簽署事件時在簽署進度的交易內補 `snapshot_at_sign`。寫入後不得修改，只有 `snapshot_at_sign` 從空值補一次。

## 檔案

| 檔案 | 內容 |
|---|---|
| `db/migrations/0009_signature_records.sql` | `org.signature_records`（有 `org_id` 與 RLS）、plpgsql 的 trigger（擋修改、擋刪除）。同一支 migration 移除 MIL-69 的暫存表 `contract_credential_snapshots` |
| `snapshot.ts` | `buildCredentialSnapshot(candidate, at)`、`maskCertificateNo`，純函式。快照形狀 `CredentialSnapshot` |
| `types.ts` | `ContractSendContext`（送簽資料）、`SignatureRecord`、`SignatureRecordDetail` |
| `repository.ts` | 第一個參數都是 `OrgTx`：`insertSignatureRecords`、`completeSignSnapshot`、`listPendingSignRecords`（簽署模組的交易內用），`listSignatureRecords`、`listSignatureRecordSigners`（讀取用）。合約與簽署人的 ID 是 ULID |
| `view.ts` | 詳情頁「簽章紀錄」分頁的資料整理，純函式 |

合約訂閱者（`src/lib/contract-signing.ts`）是唯一寫入的地方。API：`GET /api/contracts/[id]/signature-records`，兩方合約回空陣列，頁面沒有紀錄就不顯示分頁。

## 欄位

法定欄位：`statute_ref`、`rule_id`（席位的 rule_id）、`rule_version`、`practitioner_id`、`employment_id`、`entity_id`、`concurrent_roles`（兼任角色）。另存 `license_kind`：判定事實的業別層用哪一種業別，簽署當下重新判定時要用同一種。

快照內容：證書種類、遮罩證號（只留最後三碼）、證書 `valid_until`、業別與證書與任職三層狀態、三層最新核對紀錄 ID、判定時點、判定結果。不存身分證字號、地址與證號原文。簽署事件到達時查不到登錄資料，快照記 `{ decidedAt, unavailable, reason }`，簽署進度照常推進。

## 簽署模組的擴充點

- `signing.send(subject, document, signers, { alsoInTx?, context? })`：`context` 原樣交給訂閱者 `onSent(tx, subject, { signers, context })`。合約的 `context` 是 `ContractSendContext`，由 `prepareContractSend` 的 `sendContext` 提供。
- `SigningSubscriber.prepareOutcome?(subject, event, eventAt, read)`：簽署事件進交易之前呼叫，沒有 `tx`。`read(fn)` 開一個短的唯讀組織交易，查完就提交。外部來源（登錄資料）在 `read` 之外查。回傳值放進 `onOutcome` 的 `outcomeContext.prepared`。丟例外時模組記 log 並當作沒有準備。
- `SigningSubscriber.onOutcome(tx, subject, outcome, { eventAt, prepared })`：`eventAt` 是事件時間，服務商沒提供時用模組的現在時間。判定一律用 `eventAt`。

快照的三層狀態與核對紀錄 ID 是收到事件當下的登錄資料（登錄沒有歷史查詢），判定時點與判定結果用事件時間。事件與 webhook 到達之間登錄資料有變時，兩者可能不同時點，這是登錄 seam 沒有「某時點的事實」查詢造成的，C 線 MIL-113 若提供歷史查詢再改。

哪些紀錄補快照：某位簽署人簽署時，補對應 email 的那一列。全員完成事件先到時，補所有還沒補的列，時間用完成事件的。拒簽與撤回不補。已補過的不會被覆蓋（webhook 重試）。

## 資料庫（A 線同步 main 時搬進 PostgreSQL）

- `signature_records.signer_id` 參照 `org.signers.id`（ULID）。`insertSignatureRecords` 用子查詢依 `(合約, position)` 找簽署人列，對不到時 `signer_id` 為空，違反 NOT NULL，整個送簽交易回滾。
- 兩個 trigger 是 plpgsql，規則不變：除了 `snapshot_at_sign` 從空值補一次，任何欄位都不得改，也不得刪除。測試在 `repository.test.ts`，跑在 PGlite。
- 快照欄位是 `jsonb`，讀出來就是物件。
- 紀錄存在時，刪除合約由外鍵擋下。送簽後的合約不是草稿，本來就不能刪。
- 滲透測試案例在 `src/lib/pg/rls-cases.ts`。`blockedUpdateMessage` 說明為什麼改 `org_id` 的錯誤是 trigger 的訊息。

## 給 E 線 MIL-138、139

- 執業人員席位的簽章紀錄以 `contract_id` 為鍵，目前只服務合約。E 線的文件（點交證明與退還證明有執業人員席位）要紀錄時，把 `contract_id` 一般化成簽署標的的 type 加 id，或另建對應的訂閱者。表的欄位與 trigger 不必改。
- 訂閱者做法照 `contract-signing.ts`：`onSent` 用 `context` 寫紀錄，`prepareOutcome` 用事件時間重新判定，`onOutcome` 補快照。
- `buildCredentialSnapshot` 與 `view.ts` 不綁合約，可直接沿用。

## 給 C 線 MIL-113

`PracticeRegistry` 的 `PractitionerCandidate` 多兩個欄位：`employmentId`（任職 ID）與 `certificateNo`（證書號碼原文，沒有證書是 null）。快照只存遮罩後的證號。契約測試已加一項。

## 給 MIL-75（簽署中失效）

簽署事件的判定結果已在 `snapshot_at_sign.result`（`signable: false` 與 `issues`）。決議 11 情況 B 的自動撤回，可以在 `onOutcome` 之後讀它，也可以在 `prepareOutcome` 的判定上加判斷。

## 同一人兼任與四位簽署人（MIL-76）已完成

- `concurrent_roles` 取自簽署序列的 `Signer.concurrentRoles`。合併後訂閱者自動寫入，不必改。
- `signerIndex` 是合併後的位置，由 `seatSignerIndexes`（`signature-routing/sequence.ts`）算出，`evaluateSend` 使用。`onSent` 仍檢查該位置的簽署人角色是 `practitioner`，對不上時整個送簽回滾。
- 合併只減少簽署人，不減少簽章紀錄。紀錄只為執業人員席位寫，所以合併的簽署人仍是一筆，兼任的當事人角色在 `concurrent_roles`。
- 居間加包租時有兩筆紀錄，各參照自己的簽署人，`statute_ref` 不同：專任管理人員是「§32 第 2、3 款」，經紀人是「經紀條例 §22」。
- 合併後 `listPendingSignRecords` 仍用簽署人的 email 對應簽署事件，合併的簽署人用執業人員的 email，所以簽一次就補上快照。
