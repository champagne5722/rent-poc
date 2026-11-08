<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 的對照，句長規則不適用 -->
# `src/lib/access/`：權限判斷與動作表

純函式模組，沒有 I/O。只匯出純函式、常數與型別，不 import `src/lib/db.ts`，不呼叫 `Date.now()`。ID 參數一律 `string`。型別與常數沿用 `src/lib/cases/`（業務類型、案件狀態、成員關係），不重複定義。

依據：ADR-0023 決議 6、7，ADR-0016 決議 6、15、16，PRD P0-09 權限表，P0-23 AC6。票是 MIL-108 不碰資料層的部分。

## 檔案

| 檔案 | 內容 |
|---|---|
| `actions.ts` | `ACTIONS` 動作表、`ORG_ROLES`、`MANDATE_SCOPES`、`TERMINAL_CASE_STATES`、規則型別 |
| `facts.ts` | `AccessFacts` 與子型別、`AccessDecision`、`ACCESS_DENY_REASONS` |
| `decide-access.ts` | `decideAccess(facts, action)` |
| `decide-access.test.ts` | 全矩陣表格測試 |

## `decideAccess(facts, action)`

回傳 `{ allowed: true, via, onBehalf }` 或 `{ allowed: false, reason }`。`via` 是 `org_role`、`host_org`、`case_relation` 之一，`onBehalf` 標示這次允許是不是代操作，稽核必須記錄。

### 兩條路徑

| 路徑 | 誰 | 怎麼判斷 |
|---|---|---|
| 主辦組織 | 案件主辦組織的成員 | `isHostOrgMember` 為真，且 `orgRole` 在該列 `hostRoles[變體]` 內 |
| 案件成員 | 在 `case_members` 有關係的 party | `relations` 其中之一在該列 `relations[變體]` 內 |

任一條通過就允許。都不通過時回傳第一條路徑的原因。變體是業務類型（`self_managed`、`managed`、`master_lease`），委託管理案件是 `management`。同一個關係在不同變體意義不同：`lessor` 在自管是出租人，在代管是屋主，在包租是包租業者。

### 檢查順序與原因碼

| 順序 | 檢查 | 原因碼 |
|---|---|---|
| 1 | 動作存在 | `unknown_action` |
| 2 | 組織層動作：有組織脈絡、非 viewer 寫入、角色在列內 | `no_org_context`、`viewer_read_only`、`role_not_allowed` |
| 3 | 案件層動作：有案件事實 | `no_case` |
| 4 | 是主辦組織成員或有案件關係 | `not_a_member` |
| 5 | 動作授予這個成員 | `not_granted` |
| 6 | 寫入動作且 `orgRole` 是 `viewer` | `viewer_read_only` |
| 7 | 主辦組織路徑：組織角色在列內 | `role_not_allowed` |
| 8 | 寫入動作且案件在終態（`closed`、`aborted`、`terminated`、`expired`） | `case_closed_read_only` |
| 9 | 案件狀態在該列的允許狀態內 | `state_not_allowed` |
| 10 | 代操作的四個條件 | 見下表 |

對外，所有拒絕與「資料不存在」是同一個回應（P0-02 AC1）。原因碼只給內部與稽核使用，不得放進 response body。

### 代操作四個條件（ADR-0023 決議 7）

只適用代管案件（`managed`）的主辦組織路徑，且該列的 `onBehalfScope` 非 `null`。屋主（`lessor` 關係）是本人，不查。

| 條件 | 事實欄位 | 拒絕原因 |
|---|---|---|
| 連結的委託管理案件存在 | `onBehalf` 為 `null` | `no_mandate_link` |
| 1 委託管理案件是 `active` | `mandateCaseActive` | `mandate_not_active` |
| 2 租賃單位在委託標的清單上 | `rentalUnitInMandate` | `unit_not_in_mandate` |
| 3 委託範圍含這個動作 | `mandateScopes` 含該列的 `onBehalfScope` | `scope_not_covered` |
| 4 業別是 `verified` | `practiceEntityVerified` | `practice_not_verified` |
| 4 至少一位可簽章的專任管理人員 | `hasSignableManager` | `no_signable_manager` |

委託範圍對應：`rent_collection`（入帳確認、逾期提醒）、`deposit_management`（押金分錄）、`repair`（修繕）、`inspection`（確認點交、發起退租）。

### 時間

`decideAccess` 沒有時間參數。依時間而定的事實由載入者以 `now` 算好再放進 facts：

- `relations` 只放查詢時點 `valid_period` 有效的列。
- `mandateCaseActive` 已含委託是否到期。
- `practiceEntityVerified`、`hasSignableManager` 用查詢時點的可簽章判定（`credentialStatusAt()`）。

結案後只允許讀取由案件狀態判斷，不結束 `valid_period`（ADR-0016 決議 15）。

## 動作表

`ACTIONS` 一列一個動作，欄位是 `scope`、`effect`、`states`、`hostRoles`、`relations`、`onBehalfScope`（案件層），或 `scope`、`effect`、`orgRoles`（組織層）。

| 動作 | 對應 P0-09 列或 ADR |
|---|---|
| `case.read_summary` | 讀租期與狀態，包租案件的所有權人只有這一項（AC5） |
| `contract.read`、`ledger.read` | 讀合約與帳務 |
| `report.read_owner` | 讀屋主報表 |
| `contract.draft_send` | 擬約與送簽 |
| `ledger.record_payment`、`ledger.record_deposit` | 登錄入帳確認與押金分錄 |
| `ledger.send_overdue_reminder` | ADR-0023 決議 7 收租範圍，P0-09 沒有這一列 |
| `repair.manage`、`repair.report` | 建立與處理修繕紀錄，承租人限報修 |
| `inspection.confirm` | 確認點交 |
| `move_out.start` | 發起退租，ADR-0016 決議 7 與 ADR-0023 決議 7 |
| `deposit.dispute` | 對押金扣抵標示異議 |
| `handover.initiate` | 發起移交 |
| `case_member.manage` | 案件成員管理（ADR-0023 決議 5） |
| `org_member.manage` | 組織成員管理，只限 `admin` |
| `audit.export` | 稽核紀錄匯出，只限 `admin`（P0-23 AC6） |

P0-09 表與 ADR-0023 決議 7 衝突的地方以 ADR 為準：代管業者的確認點交是點交範圍的代操作。

加新動作：在 `ACTIONS` 加一列，在 `decide-access.test.ts` 的預期表加一列。測試會檢查動作清單與預期表一一對應。E 線的動作加入時，必須標示 `onBehalfScope`。

這次不做的動作：案件放棄、結案、撤回合約等生命週期動作，由用到它們的票自己加列。

## 之後怎麼接（MIL-108 剩餘範圍，等 MIL-82 併進 `integration/line-a`）

### `authorize(t, action, object)`

```ts
// 示意，非本模組的程式碼
async function authorize(t: Tx, action: ActionId, object: AuthObject): Promise<void> {
  const ctx = requestContext();                       // org、party 或 operator
  const facts = await loadAccessFacts(t, ctx, object, new Date());
  const decision = decideAccess(facts, action);
  if (!decision.allowed) {
    await audit.append(/* 拒絕原因碼 */);
    throw new Forbidden();                             // 與「資料不存在」同一個回應
  }
}
```

`loadAccessFacts` 負責：

| 事實 | 來源 |
|---|---|
| `orgRole` | `ctx.kind === 'org'` 時取 `ctx.role`，其他脈絡是 `null` |
| `caseFacts.kind`、`state`、`businessType` | `cases` |
| `isHostOrgMember` | `ctx.orgId === cases.org_id` |
| `relations` | `case_members` 以 `ctx.partyId` 經 `self_read` 查，只取 `valid_period` 含 `now` 的列 |
| `onBehalf` | 只在 `managed` 案件載入：連結的委託管理案件狀態、委託標的清單、D 線的委託範圍查詢函式、`practiceRegistry` 的業別與可簽章專任管理人員 |

物件不存在時，`authorize()` 直接丟 `Forbidden`，不呼叫 `decideAccess`。物件層級的過濾（例如 `report.read_owner` 只回自己的報表、承租人限自己的案件）由載入事實與查詢條件負責，`decideAccess` 只回答「這個身分能不能對這個案件做這個動作」。

### `withCaseMemberTx`（MIL-115）

ADR-0016 決議 16 的四個步驟，第 2 步呼叫同一個 `authorize()`：

1. 以 `app.party_id` 經 `self_read` 查成員資格。
2. `authorize(t, action, caseObject)`，內部載入事實並呼叫 `decideAccess`。承租人這類 party 脈絡的 `orgRole` 是 `null`。
3. 以案件的 `org_id` 執行 `set_config`。
4. 執行固定的 repository 方法，同交易寫稽核紀錄。

`withCaseMemberTx` 只接受 `ACTIONS` 內 `relations` 列有案件成員路徑的動作（例如 `deposit.dispute`、`repair.report`、`inspection.confirm`）。傳入沒有案件成員路徑的動作時，`decideAccess` 回 `not_granted`。

### 既有 route 改走 `authorize()`

route 一律先 `authorize()` 再執行。route 測試必須涵蓋 `viewer` 寫入被拒、拒絕與不存在的 response 一致。
