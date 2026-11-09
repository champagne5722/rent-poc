<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 與函式的對照，句長規則不適用 -->
# `src/lib/practice-entities/`：執業主體送件、審核台核對、證據檔、批次查詢

MIL-109。依據：ADR-0017（核對管道、三態、核對紀錄、證據檔補充）、ADR-0012 決議 5 與 8（營運者脈絡、`registry` 只經定義者函式）、ADR-0019（稽核鏈）。規則的純函式在 `src/lib/registry-rules/`，這裡只呼叫、不重寫。

## 資料與函式

| 項目 | 位置 |
|---|---|
| `registry.credential_checks`（只增不改）、`practice_entities` 與 `practice_licenses` 的新欄位、`review_items.resolution` | `db/migrations/0043_practice_registry_review.sql` |
| 執業主體端函式 `my_registration()`、`submit_license()` | 同上 |
| 審核台函式 `review_queue()`、`review_item_detail()`、`record_license_check()`、`resolve_entity_claim()`，內部的 `assert_operator()` | 同上 |
| 批次查詢 `lookup_practice_entities()` | 同上 |
| `vault.credential_evidence` 與 `register_`、`list_`、`open_`、`mark_..._deleted`、`confirm_..._file_removed`、`pending_file_removals`、`transfer_claim_evidence` | `db/migrations/0044_vault_credential_evidence.sql` |

`app_rw` 對這些表沒有任何權限，只能呼叫上面的函式。審核台函式第一行呼叫 `assert_operator()`：`app.operator_id` 必須是平台組織的成員，`app.org_id` 必須是平台組織。`src/lib/pg/rls-cases/practice-entities.ts` 的 `definerOnlyTables` 登記每張表（彙總成 `DEFINER_ONLY_TABLES`），`rls-penetration.test.ts` 檢查權限、`SECURITY DEFINER`、固定 `search_path`。

## 檔案

| 檔案 | 內容 |
|---|---|
| `rules.ts` | 送件與核對表單的欄位規則（純函式） |
| `display.ts` | 畫面標籤、等待時間格式（純函式） |
| `applicant.ts` | `getMyRegistration`、`submitLicense`（組織脈絡） |
| `desk.ts` | `listQueue`、`getReviewDetail`、`recordLicenseCheck`、`resolveEntityClaim`（營運者脈絡） |
| `evidence.ts` | 證據檔：寫 FileStore、登記、開啟、刪除 |
| `flows.ts` | 把交易與交易外的事（寫檔、刪檔、寄信）接起來的流程。route 只呼叫這裡 |
| `lookup.ts` | 批次查詢，稱謂取自 `src/lib/labels` |
| `notify.ts` | 補件通知。E 線通知模組的接點 |
| `operator-tx.ts` | 審核台 route 的交易入口（營運者脈絡，稽核事件在平台組織的鏈） |
| `access.ts` | 執業主體端的角色檢查，MIL-108 之後可換成 `decideAccess` |

## 規則摘要

- 送件：`registry.submit_license()`。新業別 `submitted`，待驗證或已失效 `resubmitted`，狀態一律變 `pending`，已驗證的業別拒絕。證據檔先寫 FileStore 再登記，登記失敗會刪檔。
- 核對相符前先檢查 `checkLicenseEligibility()`（代管 H706011、包租 H706021、經紀 H704031，P0-03 AC2）與登記狀態。不通過什麼都不寫，回傳缺少的項目。
- 核對相符：業別 `pending` 轉 `verified`，核對紀錄、稽核事件、項目結案、證據檔標記刪除同交易。提交後刪檔，成功才登記 `file_removed_at`。刪檔失敗留在 `pending_file_removals()`。
- 核對不符、查無、廢止：維持 `pending`，項目結案，判定理由必填。執業主體頁面顯示判定理由（`lastNote`），並寄信給組織 admin。證據檔保留。
- 登記狀態不是「核准設立」：其他已驗證的業別各寫一筆 `revoked` 紀錄並轉 `lapsed`（`decideRegistrationLoss`）。
- 稽核事件：核對（`practice_entity.verify`）、證據檔開啟（`vault.read`）與刪除（`vault.delete`）、認領判定（`practice_entity.claim_resolve`）都在營運者脈絡，寫進平台組織的鏈，行為者是營運者。送件（`practice_entity.submit`）與上傳（`vault.upload`）在送件組織自己的鏈。
- 認領同一統編：登錄者與認領方的 `getMyRegistration()` 形狀與值完全相同，認領方送的字號與證據檔掛在認領項目上。營運者判定 `keep_registrant` 或 `to_claimant`，後者只在沒有已驗證業別時允許。

## 與各票的接點

- MIL-111：證書與任職的核對沿用 `registry.credential_checks`（`subject_type` 已含 `practitioner`、`employment`）與 `review_items`（`type` 已列齊）。新增 `record_*_check()` 時照 `record_license_check()` 的寫法：先 `assert_operator()`，驗證合法的 (目前狀態, 下一狀態, 結果)，稽核位置傳進來。
- MIL-112：`pendingFileRemovals()` 與 `deleteEvidence()` 是 worker 刪除證據檔的入口（reason 有 `expired`）。`decideEvidencePurge` 決定哪些該刪。
- MIL-113：`lookupPracticeEntities()` 是批次查詢，不是 `practiceRegistry` adapter，兩者不衝突。
- E 線通知：把 `notify.ts` 的 `sendSupplementRequested()` 換成 `notify()`，kind 沿用 `registry.supplement_requested`。
