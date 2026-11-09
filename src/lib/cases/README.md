<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 的對照，句長規則不適用 -->
# `src/lib/cases/`：案件狀態機與案件建立

純函式模組，沒有 I/O。只匯出純函式、常數與型別，不 import `src/lib/db.ts`，不呼叫 `Date.now()`，時間一律由參數傳入。ID 參數一律 `string`。

依據：ADR-0016（案件七態、委託管理案件六態、八種成員關係）、ADR-0023（案件從建約流程長出）、ADR-0024（跨組織移交與後繼案件）。票是 MIL-115 與 MIL-119 不碰資料庫的部分。

## 檔案

| 檔案 | 內容 |
|---|---|
| `transitions.ts` | 常數與型別、`decideCaseTransition()` |
| `creation.ts` | `decideCaseCreation()` 與它的輸入、輸出型別 |
| `index.ts` | 兩個檔案的匯出 |

## `decideCaseTransition(snapshot, input, now)`

回傳 `{ state, event, outbox }`，不接受時回傳 `null`，寫法沿用 `src/lib/transitions.ts` 的 `decideTransition()`。snapshot 依 `kind` 分派（`lease` 或 `management`）。

### 租賃案件

| 狀態 | 輸入 → 下一狀態 |
|---|---|
| `draft` | `contract_sent` → `signing`；`abandon` → `aborted` |
| `signing` | `contract_completed` → `active`；`contract_declined`、`contract_voided` → `draft` |
| `active` | `start_move_out` → `move_out`；`handover_effective` → `closed` |
| `move_out` | `cancel_move_out` → `active`；`complete_move_out_inspection`、`advance_after_notice` → `settling`；`handover_effective` → `closed` |
| `settling` | `close` → `closed`；`handover_effective` → `closed` |
| `closed`、`aborted` | 無 |

### 委託管理案件

| 狀態 | 輸入 → 下一狀態 |
|---|---|
| `draft` | `contract_sent` → `signing`；`register_paper_contract` → `active`；`abandon` → `aborted` |
| `signing` | `contract_completed` → `active`；`contract_declined`、`contract_voided` → `draft` |
| `active` | `terminate_mandate`、`handover_effective` → `terminated`；`mandate_expired` → `expired` |
| `terminated`、`expired`、`aborted` | 無 |

### 規則

- 合約輸入（`contract_*`）的 `contractId` 必須等於 `snapshot.currentContractId`，否則回傳 `null`。呼叫端拒絕後寫 `input_rejected` 事件（ADR-0016 決議 11），這個事件不由本函式產生。
- `close`：押金餘額不為 0、押金結算單未完成、退還證明未完成任一項成立時，必須有未結原因，並產生 `audit_unsettled_close` 任務。自管案件沒有退還證明，不列入。
- `advance_after_notice`：催告紀錄不得空白。
- `mandate_expired`：`validUntil` 是最後一天（含），以台灣日期判斷，隔天起才轉 `expired`。`validUntil` 是 `null` 時不會到期。
- `handover_effective`：租賃案件只在業務類型是 `managed`，且狀態是 `active`、`move_out`、`settling` 時轉 `closed`（ADR-0024 決議 3）。事件是 `handed_over`，未結原因填移交包 ID。委託管理案件只從 `active` 轉 `terminated`，不再通知屋主，因為屋主已在移交流程中。
- 委託管理案件的 `handover_effective`、`terminate_mandate`、`mandate_expired` 都產生 `close_mandatary_valid_period` 任務。`terminate_mandate` 與 `mandate_expired` 另外產生 `notify_mandator_handover`（P0-11 AC5）。
- `handover_effective` 只在台灣日期大於等於 `effectiveDate` 時接受。
- `contract_completed` 與 `register_paper_contract` 在委託管理案件產生 `link_managed_lease_cases` 任務（P0-11 AC3）。

## `decideCaseCreation(input, now)`

回傳 `{ ok: true, case, members, event }` 或 `{ ok: false, reasons }`。被擋下時回傳全部原因，寫法比照 `checkHandoverPreconditions()`。新案件的 `stateVersion` 是 0，`currentContractId` 是 `null`。

| `input.type` | 用途 | 初始狀態 | 事件 |
|---|---|---|---|
| `new_lease` | 建約 wizard 第一步（ADR-0023 決議 1） | `draft` | `created` |
| `new_management` | 建立委託管理案件（ADR-0016 決議 9） | `draft` | `created` |
| `successor_lease` | 移交生效後的後繼案件（ADR-0024 決議 2 到 4） | `active` | `succeeded` |

### `new_lease` 的檢查

- 屋主組織只能建 `self_managed`，執業主體組織只能建 `managed` 或 `master_lease`（`business_type_not_allowed`）。
- 執業主體組織建代管或包租：對應業別必須是 `verified`（`practice_entity_not_verified`），且至少一位可簽章的專任管理人員（`no_signable_manager`）。業別對照在 `PRACTICE_CATEGORY_FOR_BUSINESS_TYPE`，由呼叫端查好狀態傳入。
- 代管案件必須連到 `active` 且涵蓋這個租賃單位的委託管理案件（`no_valid_mandate`，P0-09 AC3）。
- 成員：`lessor`、包租案件的 `owner`（取自屋主的自管案件，找不到時沒有）、居間時的 `broker`。`lessee` 在送簽時才加，`practitioner` 由 wizard 指派，都不在建立時處理。

### `new_management` 的檢查

只檢查 `mandator` 與 `mandatary` 非空且不相同，`validUntil` 是有效的 `YYYY-MM-DD` 或 `null`。不檢查主辦組織種類，因為屋主上傳紙本契約書時主辦組織不確定。業別驗證由移交的擋下條件與 MIL-116 負責。

### `successor_lease` 的檢查

- 接收方是屋主組織時業務類型必須是 `self_managed`，是執業主體組織時必須是 `managed`。
- 委託是否有效、接收方是否已驗證，不在這裡重查。這兩項由 F 線的 `checkHandoverPreconditions()` 在屋主確認、接手、生效處理三個時點檢查（ADR-0024 決議 12）。
- 成員：`lessor`，加上舊案件的 `lessee` 與 `co_lessee`（相同 party 只留一筆）。後繼案件沒有合約列，租期與租金欄位由呼叫端寫入案件。

## 與 F 線 `src/lib/handover/` 的邊界

本模組不 import、不改 `src/lib/handover/`。移交包本身的狀態機與擋下條件留在 F 線。案件側只提供：

1. 舊租賃案件轉 `closed`：`decideCaseTransition(..., { type: 'handover_effective', ... })`。
2. 舊委託管理案件轉 `terminated`：同一個輸入。
3. 後繼案件與成員：`decideCaseCreation({ type: 'successor_lease', ... })`。

`checkHandoverPreconditions()` 與案件狀態機重疊的條件：

| F 線條件 | 與案件側的關係 |
|---|---|
| `active_signing_task` | 租賃案件是 `signing` 時，`handover_effective` 回傳 `null`，案件側已涵蓋合約簽署。點交證明等其他簽署標的的進行中任務不在案件狀態裡，F 線仍須自己查。 |
| `no_valid_mandate` | `ReceiverMandate` 的 `valid` 與 `paper` 都對應委託管理案件是 `active`（紙本契約書建立的案件也是 `active`）。案件側當單一來源，查詢函式屬 MIL-119 等 MIL-82 的部分。 |
| `receiver_not_verified` | 屬於執業主體的驗證，與案件狀態無關。案件側不重查。 |
| `effective_date_in_past` | 方向相反，不重複。F 線擋「建立時生效日早於今天」，案件側擋「生效日還沒到就想生效」。 |

## 資料層：`src/lib/case-store/`（MIL-115）

本模組仍是純函式。帶 I/O 的部分在 `src/lib/case-store/`，表在 migration `0045_cases.sql`。

| 檔案 | 內容 |
|---|---|
| `dispatch.ts` | `dispatch(tx, caseId, input, options)`：呼叫 `decideCaseTransition`，同交易寫狀態與案件事件，以 `state_version` 樂觀鎖 |
| `commands.ts` | `createLeaseCase`、`attachContract`、`addCaseMember`：建案件、掛合約、加成員，各自寫事件與稽核 |
| `repository.ts` | 讀寫三張表的 SQL，`findOrCreateParty` |
| `contract-subscription.ts` | 案件訂閱合約的送簽、完成、拒簽、撤回。由 `contract-signing.ts` 的合約訂閱者呼叫 |
| `member-tx.ts` | `withCaseMemberTx`：成員寫入別的組織資料的唯一入口 |
| `legacy-migration.ts` | 既有合約遷移成自管租賃案件，可重複執行 |

### 規則

- 狀態轉移一律走 `dispatch()`，不直接 `UPDATE org.cases SET state`。
- 案件拒絕某個輸入時，`dispatch()` 不丟錯，寫 `input_rejected` 事件並回 `{ ok: false }`。合約的轉移照常提交（ADR-0016 決議 11）。
- `state_version` 衝突丟 `CaseVersionConflict`，呼叫端讓交易回滾，由 inbox 重試。
- 純函式回傳的 outbox 任務：`audit_unsettled_close` 由 `dispatch()` 寫成稽核事件。委託管理案件的任務原樣放在回傳值，由 MIL-119 處理。
- 成員讀取依關係過濾，矩陣在 `src/lib/pg/rls-cases.ts` 的 `CASE_SCOPED_READS`。新增案件範圍表時必須加一列，並在 migration 補政策。

### 給 E 線與 B 線：用 `withCaseMemberTx` 寫入別的組織的資料

承租人確認點交、標示異議、報修，以及屋主確認點交，寫入的是別的組織的資料表。入口只有 `withCaseMemberTx`：

```ts
// repository 方法收 CaseMemberTx，內部查詢一律用 tx.caseId 過濾，不接受呼叫端傳別的案件。
export async function reportRepair(tx: CaseMemberTx, input: RepairInput): Promise<string> {
  const id = newUlid();
  await tx.query(
    `INSERT INTO org.repairs (id, org_id, case_id, reporter_party_id, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, tx.orgId, tx.caseId, input.reporterPartyId, input.body],
  );
  await appendAudit(tx, { action: 'repair.report', object: { type: 'case', id: tx.caseId } });
  return id;
}

// route：把 Forbidden 轉成與「案件不存在」相同的回應
try {
  const id = await withCaseMemberTx(rc, { caseId, action: 'repair.report' }, (tx) => reportRepair(tx, input));
  return jsonOk({ data: { id } }, { status: 201 });
} catch (error) {
  if (error instanceof Forbidden) return forbiddenResponse(error);
  throw error;
}
```

- `rc` 是 `requestContext()` 的結果，`org` 或 `party` 脈絡都可以。屋主以自己的組織身分操作時也走這裡。
- `action` 必須是動作表（`src/lib/access/actions.ts`）裡的動作。沒有就先加一列。
- `tx.grant.onBehalf` 為真時，稽核事件的 payload 必須帶它。
- 第 3 步之後，這個交易看得到整個組織的資料。callback 內不得直接寫 SQL，只呼叫收 `CaseMemberTx` 的 repository 方法。
- 新的案件範圍表必須在 `CASE_SCOPED_READS` 登記可讀的關係。

## 承租人端（MIL-121）

承租人登入、我的案件、已簽 PDF 下載與承租人換 email，見 `src/lib/tenant/README.md`。成員 email 更新新增案件事件 `member_replaced`（0049 改 `case_events` 的 CHECK），由 `replaceTenantMemberEmail` 寫入。

## 這個階段不做

代管與包租案件的建立檢查接線（MIL-116）、委託管理案件的建立、委託連結與 `onBehalf` 事實載入、`close_mandatary_valid_period` 等 outbox 任務的處理（MIL-119）、worker 計時器接線、退租與結案的操作入口（E 線）、站內通知。

四個純函式模組（`cases`、`access`、`registry-rules`、`labels`）各自定義型別，併 main 後再開一張小票抽共用型別，由本模組當來源。
