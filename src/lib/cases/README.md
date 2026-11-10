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
| `case-kind.ts` | 案件種類四個值、舊欄位推出種類的 `caseKindOf()`、各種案件的主辦組織（MIL-195） |
| `rule-variant.ts` | 帳務、押金與權限規則的分類 `caseRuleVariantOf()`（MIL-198） |
| `index.ts` | 各檔案的匯出 |

## 規則分類（MIL-198，ADR-0030 決議 2、3）

帳務、押金帳戶規則、退租、移交與權限矩陣看案件種類。`caseRuleVariantOf({ caseKind, businessType })` 推出五種分類：`lease_self_managed`、`lease_managed`、`master_lease`、`sublease`、`management`。租賃案件的自管與代管規則不同，所以租賃案件再依業務類型分兩種，其他案件種類沒有業務類型。

- 規則的內容不變，只換判斷的依據。包租案件沿用自管的規則，轉租案件沿用原本業務類型 `master_lease` 的規則。包租案件沿用自管的假設待法務確認。
- `isManagerOperated(variant)`：租賃代管與轉租案件是。它們有管理人員簽章的點交證明與退還證明，社宅旗標適用，退租要等點交證明完成。
- 租賃案件的業務類型不是自管或代管時丟 `RangeError`，資料不一致時不猜。
- 後繼案件沿用原案件的案件種類：`SuccessorCaseInput.predecessorCaseKind` 必須是租賃案件（移交只適用租賃代管案件），其他種類被擋下（`case_kind_not_allowed`）。

## 案件種類（MIL-195，ADR-0030）

案件在資料上有四個種類，欄位是 `org.cases.case_kind`（migration 0077）：`lease`（租賃案件）、`management`（委託管理案件）、`master_lease`（包租案件）、`sublease`（轉租案件）。

用詞改了。讀 2026-11-10 之前的程式碼、ADR 與註解時照下表換讀：

| 案件種類 | `kind` | 舊欄位 `business_type` | 說明 |
|---|---|---|---|
| `lease` | `lease` | `self_managed` 或 `managed` | 租賃案件 |
| `management` | `management` | 無 | 委託管理案件 |
| `master_lease` | `lease` | `self_managed` | 包租案件，屋主租給包租業者那一份。承租人是包租業者 |
| `sublease` | `lease` | `master_lease` | 轉租案件，包租業者轉租給承租人那一份 |

- 舊值 `business_type = 'master_lease'` 指轉租，不是新的包租案件。兩個 `master_lease` 不同義。
- 舊欄位原封不動，既有的呼叫端照舊讀。MIL-197、MIL-198 逐批搬到 `case_kind`，MIL-203 才移除舊值。新程式碼判斷包租或轉租一律看 `case_kind`。
- 資料庫的 CHECK 擋下 `case_kind` 與 `kind`、`business_type` 的矛盾組合。舊的呼叫端不寫 `case_kind` 時，trigger 補成委託管理、轉租或租賃。trigger 補不出包租案件，因為它需要承租人的事實，呼叫端必須明寫。
- 既有案件的回填規則與 `caseKindOf()` 相同，承租人是不是包租業者讀目前合約的 `fields.routing.lesseeIsMasterLessor`。

| 案件種類 | 主辦組織 | 建立前的檢查（`decideCaseCreation`） |
|---|---|---|
| `lease` 自管 | 屋主組織 | 無 |
| `lease` 代管 | 代管業者 | 業別已驗證、有可簽章的專任管理人員、有效的委託管理案件涵蓋這個單位 |
| `management` | 代管業者 | 業別已驗證、有可簽章的專任管理人員 |
| `master_lease` | 包租業者 | 同上，業別是包租 |
| `sublease` | 包租業者 | 業別已驗證、有可簽章的專任管理人員、同組織有效（`active`）的包租案件涵蓋這個單位 |

- 轉租案件的連結存在 `linked_master_lease_case_id`（複合外鍵，限同一個組織）。舊的轉租案件沒有連結，資料庫不要求必填，必填由判定函式負責。
- 包租案件的事實由 `createLeaseCase` 自己用 `findCoveringMasterLeaseCase` 查，呼叫端不能傳入。查詢限目前組織主辦的案件。拒絕訊息不分「沒有」「別的組織的」「沒涵蓋」「不是 active」，不洩漏別的組織有沒有包租案件。
- 過渡旗標：舊建約精靈（`POST /api/contracts`）由屋主組織建立承租人是包租業者的自管案件，`createLeaseCase` 的 `lesseeIsMasterLessor` 讓它歸為包租案件，並放寬這一種案件的主辦組織。MIL-203 移除。

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

- 輸入可傳 `caseKind`（`lease`、`master_lease`、`sublease`）。不傳時，業務類型 `master_lease` 當轉租案件，其餘當租賃案件。
- 租賃案件：屋主組織只能建 `self_managed`，執業主體組織只能建 `managed`（`business_type_not_allowed`）。包租與轉租案件只有執業主體組織能建（`host_org_not_allowed`），包租案件的業務類型是 `self_managed`，轉租案件是舊值 `master_lease`。
- 轉租案件必須連到同組織、`active`、涵蓋這個租賃單位的包租案件（`no_valid_master_lease`，ADR-0030 決議 5）。
- 執業主體組織建代管、包租或轉租案件：對應業別必須是 `verified`（`practice_entity_not_verified`），且至少一位可簽章的專任管理人員（`no_signable_manager`）。業別對照在 `PRACTICE_CATEGORY_FOR_BUSINESS_TYPE`，由呼叫端查好狀態傳入。
- 代管案件必須連到 `active` 且涵蓋這個租賃單位的委託管理案件（`no_valid_mandate`，P0-09 AC3）。
- 成員：`lessor`、轉租案件的 `owner`（取自包租案件的出租人，找不到時沒有）、居間時的 `broker`。`lessee` 在送簽時才加，`practitioner` 由 wizard 指派，都不在建立時處理。出租人：租賃案件是建約的人，代管與包租案件是屋主，轉租案件是包租業者。

### `new_management` 的檢查

檢查 `mandator` 與 `mandatary` 非空且不相同，`validUntil` 是有效的 `YYYY-MM-DD` 或 `null`。主辦組織必須是執業主體組織（`host_org_not_allowed`），對應業別必須已驗證且有可簽章的專任管理人員（ADR-0030 決議 1）。屋主不上線時由業者上傳紙本契約書，主辦組織仍是業者（ADR-0029 決議 7）。

### `successor_lease` 的檢查

- 接收方是屋主組織時業務類型必須是 `self_managed`，是執業主體組織時必須是 `managed`。
- 後繼案件的案件種類沿用原案件（`predecessorCaseKind`），目前只接受租賃案件。
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
- 成員讀取依關係過濾，矩陣是 `src/lib/pg/rls-cases.ts` 匯出的 `CASE_SCOPED_READS`，內容登記在 `src/lib/pg/rls-cases/<模組>.ts` 的 `caseScopedReads`。新增案件範圍表時必須在自己模組的檔加一列，並在 migration 補政策。登記步驟見 `rls-cases.ts` 的檔頭。

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
- `action` 必須是動作表（`src/lib/access/actions.ts` 匯出的 `ACTIONS`）裡的動作。沒有就先在 `src/lib/access/actions/<模組>.ts` 加一列，步驟見 `src/lib/access/README.md`。
- `tx.grant.onBehalf` 為真時，稽核事件的 payload 必須帶它。
- 第 3 步之後，這個交易看得到整個組織的資料。callback 內不得直接寫 SQL，只呼叫收 `CaseMemberTx` 的 repository 方法。
- 新的案件範圍表必須在 `CASE_SCOPED_READS` 登記可讀的關係。

## 承租人端（MIL-121）

承租人登入、我的案件、已簽 PDF 下載與承租人換 email，見 `src/lib/tenant/README.md`。成員 email 更新新增案件事件 `member_replaced`（0049 改 `case_events` 的 CHECK），由 `replaceTenantMemberEmail` 寫入。

## 這個階段不做

代管與包租案件的建立檢查接線（MIL-116）、委託管理案件的建立、委託連結與 `onBehalf` 事實載入、`close_mandatary_valid_period` 等 outbox 任務的處理（MIL-119）、worker 計時器接線、退租與結案的操作入口（E 線）、站內通知。

四個純函式模組（`cases`、`access`、`registry-rules`、`labels`）各自定義型別，併 main 後再開一張小票抽共用型別，由本模組當來源。
