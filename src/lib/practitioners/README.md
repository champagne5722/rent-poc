<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 與函式的對照，句長規則不適用 -->
# `src/lib/practitioners/`：執業人員證書登錄、任職與專任規則

MIL-111。依據：ADR-0017（三態、三層、專任四個判定點、核對紀錄、證據檔補充）、ADR-0022 決議 9（本人登錄）、ADR-0012 決議 8（回應不透露別的組織）、PRD P0-04、P0-05、P0-24。規則的純函式在 `src/lib/registry-rules/`，這裡只呼叫、不重寫。分層沿用 `src/lib/practice-entities/`。

## 資料與函式

| 項目 | 位置 |
|---|---|
| `registry.practitioners`（證書層）、`registry.practitioner_employments`（任職層）、專任排除約束、本人端函式、營運者核對函式、`signing_facts()`、`certificate_badges()` | `db/migrations/0047_practitioners_employments.sql` |
| `vault.credential_evidence` 的對象種類加 `practitioner`（證書影本）與 `employment_consent`（同意書） | `db/migrations/0048_vault_practitioner_evidence.sql` |

| 函式 | 脈絡 | 用途 |
|---|---|---|
| `my_practitioner()` | 組織成員 | 自己的證書，以及目前組織的任職，含補件原因 |
| `org_employments()` | 組織成員 | 目前執業主體的任職清單 |
| `employment_exclusivity_facts(key)` | 組織成員 | 同一證號的任職事實，只標 `self` 或 `other`，沒有別家的 ID。`other` 只回已驗證的任職（0071，MIL-165） |
| `submit_practitioner(...)` | 組織成員 | 本人登錄或補件證書，排 `certificate` 項目 |
| `create_employment(...)` | 組織成員 | 本人建立待驗證任職，排 `employment` 項目 |
| `submit_consent(...)` | 組織成員 | 本人送所屬業者同意書，排 `consent` 項目 |
| `end_employment(...)` | 組織成員 | 結束已驗證任職，執業主體 admin 或任職本人 |
| `record_practitioner_check(...)`、`record_employment_check(...)`、`record_consent_check(...)` | 營運者 | 登錄核對，先 `assert_operator()` |
| `practitioner_party(id)` | 營運者 | 補件通知要寄給誰 |
| `review_queue()`、`review_item_detail()` | 營運者 | 0043 的函式，多列證書、任職、同意書三種項目與同一證號的其他任職 |
| `signing_facts(entity_id, party_ids)` | 該執業主體的組織、營運者 | 可簽章判定事實（MIL-113） |
| `certificate_badges(party_ids)` | 任何組織脈絡 | 標章（F 線 MIL-102） |

`app_rw` 對兩張表沒有任何權限。`src/lib/pg/rls-cases/practitioners.ts` 的 `definerOnlyTables` 登記（彙總成 `DEFINER_ONLY_TABLES`），`rls-penetration.test.ts` 檢查。

## 檔案

| 檔案 | 內容 |
|---|---|
| `rules.ts` | 證書登錄與核對表單的欄位規則、證號格式與遮罩（純函式） |
| `dates.ts` | 台灣日期 |
| `applicant.ts` | 本人端：`getMyPractitioner`、`registerCertificate`、`createEmployment`、`submitConsentLetter`、`endEmployment`、個資告知同意 |
| `desk.ts` | 審核台：`getCredentialReview`、`recordCertificateCheck`、`recordEmploymentCheck`、`recordConsentCheck` |
| `flows.ts` | 交易與交易外的事（寫檔、刪檔、寄信）。route 只呼叫這裡 |
| `notify.ts` | 補件通知。E 線通知模組的接點 |
| `signing.ts` | `getSigningFacts`、`getCertificateBadges` |

## 規則摘要

- 登錄頁：先對「證書資料個資告知」目前版本表態（`recordConsent`，P0-24 AC3）。同意記在登錄時所在的組織，換到新組織要重新表態。
- 成員只能登錄自己的證書：party 來自 `app.party_id`，資料庫函式再查成員資格。
- 專任判定（`decideEmploymentCreation`）：管理人員在別家已有已驗證任職時阻擋，不建列，訊息固定「此證號已有在職紀錄」。別家只有待驗證時並存。經紀人員掛第二家時提示，要求同意書，仍建待驗證。阻擋與提示都寫稽核事件（`rule.full_time_block`、`rule.full_time_notice`），含證號、時間、原因，寫在宣稱方自己的鏈。
- 營運者核對任職（`decideEmploymentVerification`）：別家已有已驗證任職時擋下，兩家都待驗證時由營運者判定哪一家相符。經紀人員不擋，同意書尚未核對時回警示。
- 排除約束：部分唯一索引 `employments_exclusive_verified`，同一證號最多一筆已驗證的管理人員任職。已驗證代表進行中，任職結束時轉 `lapsed`。證書層另有 `practitioners_one_verified_per_cert`，同一證號最多一位已驗證的證書持有人。
- 證書層核對跨組織沿用：換公司時只建任職與核對任職。舊任職結束後，新任職才能建立，一律是待驗證。
- 證書影本相符後刪除（`vault.delete`），不符時保留。同意書在任職有效期間保留。
- 核對不符、查無、廢止：維持待驗證，執業人員在「我的證書」頁看到判定理由，並收到信。

## 給 MIL-112、MIL-113、MIL-116、F 線 MIL-102

- MIL-112：`registry.practitioners.valid_until`、`registry.practitioner_employments.consent_valid_until`、`consent_ended_at` 是計時器的輸入。同意書的證據檔 subject_type 是 `employment_consent`，刪除用 `deleteEvidence(tx, ids, 'expired')`。
- MIL-113：`getSigningFacts(tx, entityId, partyIds)`。`practiceRegistry` 真實 adapter 在該執業主體的組織脈絡呼叫，把回傳的事實餵給 `credentialStatusAt()`。MIL-113 已完成：真實 adapter 讀 `registry.signing_view()`（0070），跨組織的關係判定在那裡。`signing_facts` 沒有放寬。
- MIL-116：分流條件的「執業主體至少有一名已驗證專任管理人員」可由 `signing_facts().practitioners` 推導。
- F 線 MIL-102：`getCertificateBadges(tx, partyIds)`，只回 party ID、證書種類與標章文字加核對日。
