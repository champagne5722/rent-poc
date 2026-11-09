<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 與票的對照，句長規則不適用 -->
# `src/lib/authorize/`：`authorize()` 與事實載入

`src/lib/access/` 是純函式（`decideAccess`、動作表）。這個目錄是它的 I/O 那一半：在交易內載入事實，呼叫 `decideAccess`，拒絕時丟 `Forbidden`。依據：ADR-0023 決議 6、7，P0-02 AC1，P0-23 AC6。票是 MIL-108。

## 用法

```ts
import { authorize } from '@/lib/authorize';

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return inOrgTx(async (tx) => {
    await authorize(tx, 'property.manage', { type: 'property', id }); // 拒絕時丟 Forbidden
    // 之後才讀寫資料
  });
}
```

- `authorize(t, action, object)` 回 `{ via, onBehalf }`。代操作（`onBehalf: true`）時，呼叫端必須把它放進自己的稽核事件。
- `checkAccess(t, action, object)` 同上，但拒絕時回 `{ allowed: false, forbidden }`，不丟錯。要保留自己的 403 訊息的呼叫端用（成員管理 route）。
- 在 `inOrgTx`、`inOrgTxAs`（`src/lib/org-route.ts`）開的交易內呼叫。它們開交易時呼叫 `bindAccessContext(tx, rc)`，把請求脈絡綁在 tx 上。沒綁定的 tx 丟程式錯誤（不是 `Forbidden`），不會被當成放行或拒絕。
- 交易外要先過權限、再進簽署模組的 route，用 `authorizeOnly(action, object)`（`org-route.ts`）。通過回 `null`，拒絕回 response。
- `Forbidden` 在 `inOrgTx`、`inOrgTxAs` 統一轉成 response。route 不必自己 catch。
- `authorizeAuditExport(t)`：稽核紀錄匯出的權限檢查，只限 admin。匯出 route 還不存在，等做的人在交易內第一個呼叫它。route 另外要做到：只查目前組織的鏈、不收 chain 參數（P0-23 AC6）。

## 物件與動作

| 物件 | 用在 | 說明 |
|---|---|---|
| `{ type: 'org' }` | 成員管理、稽核匯出、列表、建立物件或合約 | 沒有單一資料可指 |
| `{ type: 'property', id }` | 物件 route | 物件沒有案件，只用組織層動作 |
| `{ type: 'contract', id }` | 合約 route | 目前沒有案件，案件動作改用組織角色判斷（見下） |

物件查不到（含別的組織的）一律先回 `object_not_found`，不看角色。查詢帶 `org_id`，再加 RLS。

### 沒有案件的物件

案件表還沒有（MIL-115）。案件動作對沒有案件的物件，依動作表的 `uncased` 欄位改用組織層動作：`contract.read` 對應 `uncased_contract.read`（所有角色），合約寫入類動作對應 `uncased_contract.write`（admin、staff，viewer 被拒）。沒有 `uncased` 欄位的動作（`ledger.*`、`repair.*`、`inspection.confirm`、`move_out.start`、`deposit.dispute`、`handover.initiate`、`case_member.manage`、`report.read_owner`、`case.read_summary`）沒有案件就回 `no_case`，不會因為是 admin 而放行。

## 拒絕怎麼對外回應（`response.ts`）

規則：呼叫者看不到的，回得和「不存在」逐位元相同；看得到、只是不能做，回 403。

| 原因 | 對外 |
|---|---|
| `object_not_found`、`not_a_member` | 物件類型的 404，本文與 route 自己的 notFound 相同（`contractNotFound()`、`propertyNotFound()`） |
| 其他（`viewer_read_only`、`role_not_allowed`、`state_not_allowed`…） | 403 `{ "error": "沒有權限執行此操作" }` |

response body 不含原因碼。原因碼在 `Forbidden.reason`，只給內部與日誌。

這和 `src/lib/access/README.md` 寫的「所有拒絕與不存在是同一個回應」不同。P0-02 AC1 的條件是「A 組織成員以 B 組織的資料 ID 呼叫」，防的是跨組織洩漏。同組織的 viewer 本來就能讀到這筆資料，對他回 404 只會誤導。若要改成一律 404，只改 `response.ts` 的 `HIDDEN_REASONS`。

## 不寫稽核

`authorize()` 不寫稽核事件。拒絕時交易整個回滾，事件跟著消失；寫入還會鎖住這個組織的鏈頭，被濫用時拖慢正常寫入。成員被移出後的拒絕已由 `auth.membership_rejected` 記錄（P0-02 AC6）。代操作的允許由呼叫端寫稽核，用 `grant.onBehalf`。

## MIL-115 要從哪裡接

兩個接線處都在 `load-facts.ts`，檔內有標記：

1. **`resolveObject`**：合約表加 `case_id` 後，查詢改成 `SELECT case_id FROM org.contracts ...`，回傳 `caseId`。新增 `{ type: 'case', id }` 物件時，在這裡處理。
2. **`loadCaseFacts`**：目前拋錯（拒絕處理，不放行）。實作時依 `src/lib/access/README.md` 的 `loadAccessFacts` 表載入案件種類與狀態、`isHostOrgMember`、`relations`（只取 `valid_period` 含 `now` 的列）、代管案件的 `onBehalf`。`now` 由呼叫端傳入。

`withCaseMemberTx`（ADR-0016 決議 16）：

- 以 party 脈絡開 `PartyTx` 後，呼叫 `bindAccessContext(tx, rc)`，第 2 步呼叫 `authorize(tx, action, { type: 'case', id })`。
- 不必另寫權限判斷。承租人的 `orgRole` 是 `null`，`decideAccess` 走案件成員路徑。
- 載入事實時 party 脈絡看不到組織表。成員資格用 `self_read` 查。`resolveObject` 對 party 脈絡目前一律回「不存在」，案件物件要另外處理。

## 檔案

| 檔案 | 內容 |
|---|---|
| `authorize.ts` | `authorize`、`checkAccess` |
| `load-facts.ts` | `loadAccessFacts`，兩個 MIL-115 接線處 |
| `context.ts` | `bindAccessContext`、`accessContextOf`（WeakMap，綁在 tx 上） |
| `forbidden.ts` | `Forbidden` |
| `response.ts` | `forbiddenResponse` |
| `guards.ts` | `authorizeAuditExport` |
| `types.ts` | `AuthObject`、`ForbiddenReason`、`AccessGrant` |
