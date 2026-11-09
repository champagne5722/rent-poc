<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 的對照，句長規則不適用 -->
# `src/lib/tenant/`：承租人端（MIL-121）

承租人登入後看自己在所有組織的案件，案件詳情顯示合約狀態並能下載已簽 PDF。依據：ADR-0022 決議 6（承租人身分）、ADR-0016 決議 15、16（成員讀取與寫入入口）、ADR-0023 決議 5（成員 email 更新）、PRD P0-21、P0-09。

## 身分與路徑

- 承租人身分：帳號的 party 是任何案件的有效 `lessee` 或 `co_lessee` 成員。判斷在資料庫函式 `org.party_has_tenant_membership(party_id)`（0049，定義者函式，跨組織讀成員表，只回 boolean）。登入流程在驗證碼通過之後才呼叫它，MIL-89 的系統目錄檢查要納入這個跨組織讀取的函式。
- 脈絡是 `party`，不需要組織。出租人、屋主等關係的 party 不得從承租人端讀，`requireTenantRelation` 擋下。
- 頁面：`/tenant`（我的案件）、`/tenant/cases/[id]`。API：`/api/tenant/cases`、`/api/tenant/cases/[id]`、`/api/tenant/cases/[id]/signed-pdf`。`/tenant` 底下一律只接受 party 脈絡，組織脈絡回 403。
- 殼層：`shellFor('/tenant...')` 是 `'tenant'`，由 `src/app/tenant/layout.tsx` 掛 `TenantShell`。`OwnerShell` 與 `/owner` 不動。

## 函式

| 函式 | 說明 |
|---|---|
| `listTenantCases(rc)` | party 脈絡，靠成員讀取政策，列出所有組織的案件，新的在前。結案的仍列出 |
| `loadTenantCaseDetail(rc, caseId)` | `withCaseMemberTx`，動作 `case.read_summary`。不是成員、關係已結束、案件不存在，一律丟 `Forbidden` |
| `loadSignedPdf(rc, caseId, files)` | `withCaseMemberTx`，動作 `contract.download_signed`。檔案經 `FileStore` 在交易外讀取，SHA-256 不符視為不可用 |

route 把 `Forbidden` 轉成 `caseNotFound()`：別人的案件、不存在的案件、格式錯誤的編號，回應逐位元相同（P0-09 AC1）。

## 給 E 線（MIL-140、MIL-123）：怎麼加押金、點交、報修

1. 動作：在 `src/lib/access/actions/<模組>.ts` 加一列，再依 `src/lib/access/README.md` 把模組接進 `actions.ts`（承租人報修 `repair.report`、點交 `inspection.confirm`、異議 `deposit.dispute` 已在表裡）。
2. 資料：寫一個收 `CaseMemberTx` 的 repository 方法，查詢一律用 `tx.caseId` 過濾（見 `queries.ts`）。讀取加進 `loadTenantCaseDetail` 的回傳，寫入用 `withCaseMemberTx`（見 `src/lib/cases/README.md`）。
3. 畫面：在 `src/app/tenant/cases/[id]/page.tsx` 讀資料，包成 `{ key, label, children }`，傳給 `TenantCaseView` 的 `extraTabs`。結案後所有寫入入口必須隱藏，`readOnly` 在 `TenantCaseView` 依案件狀態算好。
4. 新的案件範圍表必須在自己模組檔 `src/lib/pg/rls-cases/<模組>.ts` 的 `caseScopedReads` 登記可讀的關係（彙總成 `CASE_SCOPED_READS`），並在 migration 補政策。

## 承租人換 email

出租人或受託人所屬組織在後台案件詳情的成員分頁按「更新 email」，呼叫 `PATCH /api/cases/[id]/members/[memberId]`，經 `authorize(case_member.manage)`。`replaceTenantMemberEmail`（`src/lib/case-store/commands.ts`）在同一個交易內：關閉舊成員列的 `valid_period`（不刪列）、以新 email 找或建 party、加一列同關係的新成員、寫案件事件 `member_replaced` 與稽核 `case_member.replace_email`（payload 只放 ID）。不改 `control.parties.email`，不改合約內的乙方 email。舊 email 的 party 下一個請求就失去成員資格，沒有其他承租人案件時 session 失效。
