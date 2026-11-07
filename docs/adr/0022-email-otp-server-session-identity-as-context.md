---
status: accepted
---

# 登入用自建 email OTP 與伺服器端 session，身分是可切換的脈絡

現有系統沒有登入，打開即是出租人視角。P0-01、P0-02 要求帳號一律是自然人，一個帳號得屬於多個組織，被移出組織後下一個請求就拒絕。決議：屋主、經理人、承租人與平台營運者用同一套 email OTP 登入，session 存在資料庫，cookie 只放隨機 token。帳號在當下操作所用的脈絡稱為身分，由使用者切換，`requestContext()` 把它轉成 A 線的 `withTx` 脈絡。

本決議延伸 ADR-0012 決議 5 的「登入」入口，以及 A 線 spec MIL-78 的 `requestContext()`。A 線過渡期回傳環境變數指定的預設組織，C 線只換這個函式的實作。

## 決議內容

1. **一套登入機制。** 四種人都用 email OTP，不做密碼與第三方登入。不引入 Auth.js，因為它的 adapter 仍要接 `control` 與 RLS，省不了工。

   | 項目 | 值 | 性質 |
   |---|---|---|
   | OTP 長度 | 6 碼數字 | 假設 |
   | 有效期 | 10 分鐘 | 假設 |
   | 錯誤上限 | 5 次後作廢 | 假設 |
   | 寄送頻率 | 同一 email 每分鐘 1 次 | 假設 |

   - OTP 只存雜湊，用過即作廢。
   - 不論 email 是否已有帳號，回應都相同，不洩漏帳號是否存在（P0-21 AC6 的同一原則）。
   - 承租人以 OTP 登入是否足夠，待法務確認（MIL-51，列在 MIL-62）。

2. **伺服器端 session。** session 存在 `control.sessions`，欄位含帳號、目前身分、`identity_level`、建立與到期時間。cookie 只放隨機 token，設 `HttpOnly`、`Secure`、`SameSite=Lax`。

   - 每個請求都查 session，並重新查目前身分的成員資格。成員已被移出時拒絕，並寫稽核紀錄（P0-02 AC6）。
   - 登出與成員移除時，刪除 session 列。
   - 不用無狀態 token，因為無法在下一個請求就撤銷。

3. **寄信經 `Mailer` seam。** 第一版只有兩個 adapter。

   | adapter | 用途 |
   |---|---|
   | `log` | 本機與 demo。寫 server log，demo 另有一頁列出最近的 OTP，放在 Basic Auth 之後 |
   | Mock | 測試 |

   真實寄信服務在 pilot 前由使用者選定，是上線閘門。demo 只放測試資料，外層仍有 Basic Auth（ADR-0011），所以 `log` adapter 可接受。

4. **組織的種類與建立。** `orgs.kind` 只有 `owner`、`practice`、`platform`。

   | 情境 | 系統的動作 |
   |---|---|
   | 第一次登入，選「我是屋主」 | 建一個屋主組織，帳號是 `admin` |
   | 第一次登入，選「我是經理人」 | 填統編與業別，建一個執業主體組織與待驗證的執業主體 |
   | 第二個組織認領同一統編 | 不建新的執業主體，送平台營運者人工審核（ADR-0017 決議 11） |
   | 被邀請加入組織 | 登入後成為該組織成員 |
   | A 線的預設組織 | 轉成屋主組織。環境變數 `SEED_OWNER_EMAIL` 指定的帳號是 `admin` |

   一個執業主體對應一個組織（P0-02）。一個帳號得屬於多個組織。

5. **組織角色只有三種。**

   | 角色 | 能做的事 |
   |---|---|
   | `admin` | 全部業務操作，加上成員邀請、移除與角色變更 |
   | `staff` | 業務操作，不含成員管理 |
   | `viewer` | 唯讀 |

   - 執業人員不是角色。帳號綁定執業人員，且任職可簽章時，才能被指派為簽章人。
   - 平台營運者是平台組織的成員，不另設角色。
   - 架構 4.5 的 `accountant`、`signing_practitioner`、`platform_reviewer` 不建，因為 P0 沒有對應的動作。之後加角色只改動作表。

6. **身分是可切換的脈絡。** 切換器列出帳號目前可用的身分，選擇存在 session。

   | 身分 | 出現條件 | 對應的 `withTx` 脈絡 |
   |---|---|---|
   | 一個組織 | 帳號是該組織的成員 | `org` |
   | 承租人 | 帳號的 party 有 `lessee` 或 `co_lessee` 案件成員關係 | `party` |
   | 平台營運者 | 帳號是平台組織的成員 | `operator`，目標組織與工單號由審核台的動作另外帶入 |

   只有一種身分時不顯示切換器。介面上的稱謂由標籤對照表依組織的業別與案件的業務類型決定（P0-01 AC2、AC5），不由身分決定。

7. **`requestContext()` 的形狀。**

   ```ts
   type RequestContext =
     | { kind: 'org'; orgId: string; orgKind: 'owner' | 'practice' | 'platform'; userId: string; partyId: string; role: 'admin' | 'staff' | 'viewer'; requestId: string }
     | { kind: 'party'; userId: string; partyId: string; requestId: string }
     | { kind: 'operator'; userId: string; partyId: string; requestId: string };
   ```

   - 沒有 session 時丟 `Unauthenticated`，頁面導向登入。
   - 成員資格失效時丟 `Unauthenticated`，並寫稽核紀錄。
   - `operator` 轉成 `withTx` 脈絡時，呼叫端必須另外帶目標組織與工單號，由 A 線的 `withTx` 檢查。

8. **驗證等級。** Phase 1 全部帳號都是等級 1。session 記 `identity_level = 1`，稽核事件照架構 4.6 記 `actor_identity_level`。不做 `requireIdentityLevel()` 與升級驗證，因為等級 2 以上沒有 P0 需求，行動自然人憑證 P1-08 不做。

9. **執業人員帳號綁定。** 執業人員由本人在自己的帳號登錄證書，組織不得替別人登錄（ADR-0017 留給 C 線的項目）。

   1. 執業主體的 `admin` 以 email 邀請成員。
   2. 成員登入後開啟證書登錄頁，系統先顯示證書資料個資告知並記錄同意（P0-24 AC3）。
   3. 成員填證書資料並上傳影本，系統建執業人員與該執業主體的待驗證任職。
   4. 專任判定依 ADR-0017 決議 7 的四個判定點。
   5. 執業人員的簽署 email 固定取自帳號 email（ADR-0018 決議 10 第 6 項）。

   理由：證書屬於自然人本人。換公司時證書核對跨組織沿用，只核任職。組織不能先登錄別人的證號再綁帳號。

## Considered Options

- **密碼加 email 驗證：** 使用者熟悉，但要存密碼雜湊、做重設流程，也多一種外洩風險。
- **Auth.js：** 社群維護，但 adapter 要自己接 `control` 與 RLS，email provider 也要接寄信服務。省下的只有 cookie 處理。
- **無狀態 JWT session：** 不用查表，但被移出組織後 token 到期前仍有效，不符 P0-02 AC6。
- **架構 4.5 的七種角色：** 對應未來的分工，但 P0 只用得到三種，其餘角色沒有可測的動作。
- **身分與帳號一對一（每種身分一個帳號）：** 權限判斷簡單，但違反 P0-01「一個帳號得有多種身分」。
- **組織替執業人員登錄證書：** 執業人員不必登入，但任何組織都能先登錄別人的證號。

## Consequences

- 每個請求多一次 `control` 查詢。session 與成員資格得放在同一個查詢。
- demo 的 OTP 在 log 與 demo 專用頁面可見。這只因 demo 只放測試資料才成立，pilot 前必須換真實寄信服務。
- 平台營運者帳號由 migration 或環境變數建立，沒有自助註冊。
- 承租人第一次登入時，若 email 還不屬於任何案件，系統只顯示「沒有案件」，不建組織。
- 架構文件第 2.4 節的 `RequestContext` 與第 4.5 節的角色清單，由 MIL-61 修正。
