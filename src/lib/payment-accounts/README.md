<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 的對照，句長規則不適用 -->
# `src/lib/payment-accounts/`：收款帳戶與押金帳戶規則表

票是 MIL-118。依據：ADR-0014 決議 9、10、13，ADR-0050 決議 9、11。資料表在 `db/migrations/0051_deposit_holder_rules.sql` 與 `0052_payment_accounts.sql`。

平台不經手錢。收款帳戶只存遮罩識別：銀行代碼與帳號末四碼。介面與文件不顯示 `account_kind`，也不出現「信託」。

## 資料表

| 表 | 內容 | 權限 |
|---|---|---|
| `org.payment_accounts` | 名稱、持有人（種類、party、名稱）、`account_kind`（`general`、`cash`）、遮罩識別、停用時間 | `app_rw` 可讀寫，不可清空。組織 RLS |
| `control.deposit_holder_rules` | 押金帳戶規則，5 列，`(rule_id, version)` 為主鍵 | `app_rw` 只能讀。登記在 `CONTROL_TABLE_EXCEPTIONS` |

- 持有人的 party 掛了到 `control.parties` 的外鍵（`0074`，MIL-187）。lessor、owner、manager 的 party 從選單挑，other 沒有 party，以姓名識別。
- 選單的選項是本組織的成員與本組織案件上目前有效的成員（`holder-candidates.ts`），只回顯示名稱與 party ID。登錄與修改時 repository 用同一份清單檢查，不在清單內回 `holder_not_allowed`（422）。不存在的 party、別的組織的 party、格式錯誤的 ID 回應相同。
- 修改帳戶時，持有人沿用原值就不重新檢查：持有人離開組織後，帳戶仍能改名稱。請求沒有指定持有人時，登錄用呼叫端給的預設值（目前登入者），修改沿用原值。
- 每位持有人一個啟用中的現金收取帳戶（唯一索引：組織、持有人種類、party 或姓名）。登錄或修改持有人時同交易補上缺的那一個。
- 帳戶有分錄引用（`org.ledger_entries.account = 'asset.bank.{id}'`）後，持有人與遮罩識別不得修改。repository 回 `locked`，觸發器是最後一道防線。介面提示「停用並新增」。
- 帳戶只能停用，不能刪除，也不能重新啟用，觸發器擋下。
- 規則表缺列時 `DHR-05` 不在，`evaluateHolderRule` 會回 `warn`。`holder-rules-store.test.ts` 檢查 5 列都在，並逐欄比對 `DEPOSIT_HOLDER_RULES`。

## 函式

| 函式 | 用途 |
|---|---|
| `registerPaymentAccount(tx, input, defaultPartyId)` | 登錄。持有人的 party 取 `input.holderPartyId`，沒有時用 `defaultPartyId`。銀行帳戶會補持有人的現金收取帳戶。寫 `payment_account.register` |
| `updatePaymentAccount(tx, id, input, fallbackPartyId?)` | 修改。有分錄引用後只能改名稱。持有人的 party 取 `input.holderPartyId`，沒有時沿用原值，只有原本沒有 party 時才用 `fallbackPartyId`。寫 `payment_account.update` |
| `deactivatePaymentAccount(tx, id)` | 停用。寫 `payment_account.deactivate` |
| `listPaymentAccounts(tx)`、`getPaymentAccount(tx, id)` | 讀取。含 `locked`、`isCash`、`active` |
| `assertPaymentAccountsInOrg(tx, ids, { allowInactive })` | 檢查 `asset.bank.{id}` 的帳戶屬於本組織且啟用，並對帳戶列加共享鎖。MIL-125 的業務函式必須在寫分錄的同一個交易內呼叫，持有人鎖定才不會被競態繞過 |
| `listHolderCandidates(tx)`、`isHolderCandidate(tx, partyId)` | 持有人選單與寫入檢查。`GET /api/payment-accounts/holder-options` 回 `{ data: [{ partyId, displayName }], selfPartyId }`，權限同 `payment_account.manage` |
| `loadHolderRules(tx)`、`getHolderRule(tx, ruleId, version)` | 讀規則表，同一個 `rule_id` 取最新版本。傳給 `evaluateHolderRule` |
| `listAffectedCases(tx, ruleId, version)` | 列出受影響案件，回傳 `{ caseId }`。MIL-123 起依案件列出：有押金台帳的租賃案件，業務類型與社宅旗標符合，押金曾進入該持有人種類的帳戶（收取淨額大於 0）。委託範圍條件案件上沒有資料，先忽略。MIL-125 有持有人確認紀錄後改成依確認紀錄列出。規則版本目前只用來取規則列，不另做版本區分 |

稽核 payload 只放 ID、持有人種類與收款方式，不放姓名與銀行識別。
