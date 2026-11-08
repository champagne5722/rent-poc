<!-- ste-lint: off -->
<!-- 模組說明給 agent 讀，內容是介面與不變條件的清單，句長規則不適用 -->
# orgs：建立組織、邀請成員、身分切換（MIL-106）

ADR-0022 決議 4 到 6。登入與 session 在 `src/lib/auth/`，這裡只管「帳號有了之後，組織與身分怎麼來」。

## 介面

| 檔案 | 匯出 | 說明 |
|---|---|---|
| `onboarding-rules.ts` | `validateOwnerForm`、`validatePracticeForm`、`landingPath`、`landingPathFor` | 純函式。個體商號選代管或包租回 `company_required`（用 `registry-rules` 的 `checkLicenseEligibility`，不看營業項目）。登入落地：所有身分都是屋主組織才到 `/owner` |
| `onboarding.ts` | `createOwnerOrg`、`createPracticeOrg` | 帳號沒有任何身分時建第一個組織。一個交易：組織、第一位 admin、session 切到新組織、稽核（`org.create`、`member.grant`）。經理人另呼叫 `registry.claim_practice_entity` |
| `members.ts` | `listMembers`、`inviteMember`、`cancelInvitation`、`changeRole`、`removeMember` | 在目前組織的 org 脈絡內呼叫。只有 admin 能管理（`decideAccess` 的 `org_member.manage`）。至少留一位 admin |
| `invitations.ts` | `pendingInvitationsFor`、`acceptInvitation` | 給 `login-flow.completeLogin` 用：被邀請者登入時轉成成員 |

切換身分與切換器的資料在 `auth/login-flow.ts`：`listSessionIdentities`、`switchIdentity`。

## 不變條件

- 回應不透露別的組織：統編已被登錄時，認領方的回應、畫面與稽核事件和第一個登錄者完全相同。`registry.claim_practice_entity` 只回傳結果代碼。
- `control` 的表不掛 RLS，所以 `members.ts` 每個查詢都明確帶 `org_id`。
- 移除成員與刪除該組織身分的 session 在同一個交易。其他身分的 session 不動。
- 成員異動的稽核事件寫在該組織自己的鏈，payload 不放 email 與姓名。
- 邀請信寄出是外部呼叫，route 在交易提交之後才寄。

## 測試

- `onboarding-rules.test.ts`：純函式。
- `orgs.test.ts`：PGlite 整合，涵蓋全部 AC。
- `orgs.pg.test.ts`：真實 PostgreSQL 的併發（最後一位 admin、同 session 建兩次組織、同統編認領）。
- `practice-registry-schema.test.ts`：`registry` 新表 `app_rw` 沒有直接權限。
- route 層：`src/app/api/org/org.route.test.ts`。
