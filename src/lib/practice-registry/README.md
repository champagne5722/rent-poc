<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 與函式的對照，句長規則不適用 -->
# `src/lib/practice-registry/`：執業主體登錄 seam

MIL-65（seam 與 seed adapter）、MIL-113（真實 adapter）。依據：ADR-0021 決議 3、ADR-0023 決議 8、ADR-0018 決議 2 與 10、ADR-0017 決議 6 與 7、ADR-0012 決議 8。

seam 回傳執業主體、當事人簽署人候選、執業人員候選與可簽章的判定事實。回傳形狀不隨 adapter 改變。可簽章由 `src/lib/credential-status` 的 `credentialStatusAt()` 判定，adapter 只提供事實。

## 檔案

| 檔案 | 內容 |
|---|---|
| `types.ts` | `PracticeRegistry` 與候選的型別 |
| `index.ts` | `getPracticeRegistry()`、`resolvePracticeRegistry()`、`registerLivePracticeRegistry()` |
| `live-adapter.ts` | 真實 adapter：`createLivePracticeRegistry({ run, now })`、`txRunner(tx)` |
| `request-runner.ts` | `requestOrgRunner()`：在目前請求的組織脈絡內開短交易 |
| `seed-adapter.ts` | seed 假資料，只給測試與明確指定的 mock 示範 |
| `live-test-kit.ts` | 真實 adapter 的 PGlite 測試資料 |
| `registry.contract.test.ts` | 兩個 adapter 共用的契約測試，加上選擇規則的測試 |
| `live-adapter.test.ts`、`live-adapter.pg.test.ts` | 揭露規則：PGlite，以及真實 PostgreSQL（有 `TEST_DATABASE_URL` 時） |
| `../pg/registry-disclosure.test.ts` | 個資揭露矩陣：registry 每個函式乘以每種呼叫者關係（見下方「個資揭露矩陣」） |

資料庫端是 `db/migrations/0070_practice_registry_live.sql`，沒有新表。

## 怎麼接上：請求時，不需要啟動註冊

`getPracticeRegistry(env?, { run? })` 每次呼叫回傳一個 `PracticeRegistryResolution`，選擇順序：

1. 有 `registerLivePracticeRegistry(registry)` 的覆寫：用它。測試用。
2. `PRACTICE_REGISTRY=seed`：走 `resolvePracticeRegistry`。非正式金鑰用 seed，`DOTTEDSIGN_VERIFY_SIGNERS=1` 時不可用（要求執業人員的組合一律擋下送簽，原因是 `REGISTRY_UNAVAILABLE_REASON`）。
3. 其他（預設）：真實 adapter。dev server、demo 與正式環境都走這一條。

vitest 的 `vitest.setup.ts` 設 `PRACTICE_REGISTRY=seed`，所以既有的 route 與整合測試仍用 seed。要在本機用假資料示範時，在 `.env.local` 加 `PRACTICE_REGISTRY=seed`。

呼叫端沒有改，只換取得 registry 的預設：

- route handler 呼叫 `getPracticeRegistry()`。真實 adapter 的每個方法透過 `requestOrgRunner()` 開一個短交易，用目前請求的組織脈絡。一個 `getPracticeRegistry()` 回傳的 adapter 只解析一次請求脈絡。這些呼叫都在交易外（ADR-0012 決議 10），所以不會巢狀開交易。**不要在 `inOrgTx` 的 callback 內呼叫 registry 方法**：`withTx` 不得巢狀。已經有 tx 時用 `createLivePracticeRegistry({ run: txRunner(tx) })`。
- 簽署 webhook 沒有請求脈絡。`createContractSubscriber` 的 `prepareOutcome` 傳入簽署模組給的唯讀執行器：`getPracticeRegistry(process.env, { run: read })`，脈絡是合約所在的組織。

## 回傳形狀與 ID

- `PracticeEntity.id`：`registry.practice_entities.id`。`licenseKinds` 是已登錄的業別，不論狀態。
- `PartySignerCandidate.id`：成員關係 ID（`control.org_memberships.id`）。`partyId` 是自然人的 party。成員離開再加入會換 ID，舊指派因此失效。
- `PractitionerCandidate.id` 與 `employmentId`：同一個，任職 ID。`getPractitioner(id)` 沒有執業主體參數，只有任職 ID 對得到唯一的執業主體與證書。`entityId` 與同一人的 `PartySignerCandidate.entityId` 相同，`partyId` 也相同，MIL-76 的合併靠這兩個欄位。
- `certificateNo`：格式 `112年內授營字第123456號`。`own` 關係是原文，其他關係是資料庫遮罩後的值。簽章紀錄只存 `maskCertificateNo()` 遮罩後的值。
- `fullTime`：管理人員且任職已驗證。專任由 `employments_exclusive_verified` 保證（同一證號最多一筆已驗證的管理人員任職）。經紀人員沒有專任要求，永遠是 `false`。
- `isResponsiblePerson`：登錄沒有負責人資料，永遠是 `false`。「負責人沒有證書」（P0-12 AC5）的情境在真實 adapter 不會出現，契約測試對這項只跑 seed。
- `credential`：業別層取查詢指定的業別，沒有登錄時 `state` 是 `null`。證書層 `validUntil` 是 `YYYY-MM-DD`。任職層是任職期間。三層的 `latestCheckId` 只在 `own` 與 `bound` 有值。`accountEmail` 只有 `own` 用 ID 查單筆（`getPractitioner`）時是真實的，列出（`listPractitioners`）與其他關係都是遮罩的（MIL-200）。

## `listPractitioners` 的篩選

依序：證書種類、專任要求、人員本身查詢時點可簽章。第三項呼叫 `credentialStatusAt()`，但把業別層當成已驗證：證書或任職未驗證、已期滿、任職已結束的人不在清單內。業別層不排除，執業主體的業別未驗證時候選仍在，呼叫端靠判定事實說明原因（委託管理合約受託人的 `MANDATARY_LICENSE_UNVERIFIED` 靠這個）。seed adapter 套用同樣的篩選。`getPractitioner` 不套用任何資格條件。

## 簽章人員只從自家指派：呼叫者與執業主體的關係（MIL-200）

ADR-0029 決議 3：合約上的簽章人與當事人簽署人，都由主辦組織從自家指派，任何組織都看不到別的組織的人員。`registry.caller_relation(entity_id)`（內部函式，migration 0084）由資料庫依交易的組織脈絡算出，呼叫者不能指定。

| 關係 | 條件 | 證號 | email | 核對紀錄 ID | 列出任職時 |
|---|---|---|---|---|---|
| `own` | 呼叫者是該執業主體自己的組織，或平台營運者 | 原文 | 用 ID 查單筆時真實，列出時遮罩 | 有 | 全部（含待驗證、失效） |
| `bound` | 呼叫者組織的案件成員，關係是 `mandatary`，而且屬於該執業主體的組織 | 遮罩 | 遮罩 | 有 | 只回證書與任職都已驗證的人。用任職 ID 查單筆時回完整狀態 |
| `none` | 其他，包含只有草稿合約、只有合約指派的組織 | 空，與執業主體不存在不可區分 | | | |

- 拿掉的兩條路：`selecting`（有草稿合約就能讀任何執業主體的人員），與「呼叫者自己存的合約指派造出 `bound`」。兩者都是呼叫者不需要任何人同意就能建立的關係。
- `listEntities` 只列呼叫者自己組織的執業主體，業別還沒驗證的也列（自己的登錄，自己看得到）。依業別查時只列該業別已驗證的。營運者列出全平台已驗證的。別的組織的執業主體不出現。
- 列出成員與任職（`listPartySigners`、`listPractitioners`）時，email 一律遮罩，連 `own` 也一樣：選單只需要姓名。合約欄位與簽署信要用的真實 email，由伺服端用 ID 查單筆讀（`getPartySigner`、`getPractitioner`），而且只有 `own` 拿到。這就是「依 ID 讀真實 email，只回自家組織的人」。
- `validateAssignments` 與 `resolveAssignmentFacts`（`practitioner-assignment/service.ts`）只認自家組織：別的組織的與不存在的執業主體、人員、簽署人，回同一句錯誤訊息。
- 證號遮罩在 SQL 內做（`registry.mask_certificate_no`），原文不離開資料庫。規則與 `maskCertificateNo` 相同：`112年內授營字第1234567號` 只留最後 3 個字元。email 遮罩保留第一個字元與網域：`c***@example.com`。
- `getEntity` 沒有改：它走 `lookup_practice_entities`，任何組織都能依 ID 查名稱與業別狀態，用在簽章紀錄的名稱顯示（ID 不可猜，不回統編、組織 ID、人員）。送簽與存指派的路徑不用它判斷歸屬。
- seed adapter 是示範用假資料，不分組織，每個呼叫者都看到全部。只用在 `PRACTICE_REGISTRY=seed` 的 mock 示範與測試，不是安全邊界。

`bound` 仍存在，因為受託人（例如屋主組織的案件，受託人是業者組織的人員）是合法的跨組織關係。`bound` 只認 `relation = 'mandatary'`。`practitioner` 與 `broker` 是簽章席位，呼叫者能自己指派，所以不產生 `bound`：乙公司把同時是甲公司成員的人指派進席位，乙公司對甲公司的執業主體仍是 `none`。測試在 `registry-disclosure.test.ts` 的「簽章席位成員不產生 bound」。殘餘風險：`org.case_members` 的寫入入口目前只有共同承租人（`POST /api/cases/[id]/members`）與簽章人員的指派（要求執業人員屬於自家組織，見 `resolveAssignmentFacts`），但資料庫本身沒有限制成員必須經對方同意。若之後開放別的成員關係的寫入，必須同步檢查成員的 party 屬於主辦組織或已接受邀請。

`registry.signing_facts()`（0047）沒有放寬，仍只給自己的組織與營運者。跨組織走 `registry.signing_view()`。

## 個資揭露矩陣

起因：MIL-113 的第一版讓其他組織讀到證號原文與成員 email，這條規則當時只寫在 Linear 留言，沒有測試守住（MIL-165）。現在規則由測試守住，測試在 `src/lib/pg/registry-disclosure.test.ts`。

### 規則

1. `registry` schema 內授權給 `app_rw` 的每個函式，必須在 `src/lib/pg/rls-cases/<模組>.ts` 的 `registryFunctions` 登記 `disclosure`。測試從系統目錄列出這些函式，沒登記的讓測試失敗。
2. 函式不回傳個資時，登記 `{ kind: 'none', reason }`，寫出為什麼不揭露。不能靠漏登記通過。
3. 函式回傳個資時，登記 `{ kind: 'matrix', variants }`。每種呼叫方式一個 variant，每個 variant 對每種呼叫者關係各有一列期望值。
4. 呼叫者自己能建立的關係，不得解鎖證號原文。判斷重點是「這個關係是誰能建立的」。建草稿合約、存一筆指派、替案件加成員、開一個執業主體組織，都不需要任何人同意，所以 `bound`、`draftAssigned`、`unrelated` 都讀不到證號原文。
5. 沒有關係的組織探測真實對象，與探測不存在的對象，回應必須逐值相同。
6. 期望值有兩種：回應含哪些個資欄位（空陣列代表成功但不含個資），或被拒（42501）。兩者不同。該拒絕卻回了空結果，測試會失敗。

### 檢查的個資欄位

| 欄位 | 偵測方式 |
|---|---|
| `certificateNo` | 回應文字含任何一個證書序號原文 |
| `fullEmail` | 回應文字含任何一個完整 email（遮罩後的 `c***@example.com` 不算） |
| `taxId` | 回應文字含任何一個統編 |
| `checkId` | 回應文字含任何一個核對紀錄 ID |
| `inactiveEmployment` | 回應文字含待驗證、證書失效、已結束任職的任職 ID，或已結束任職的結束日 |

### 呼叫者關係

關係定義在 `src/lib/pg/registry-disclosure-kit.ts` 的 `CALLER_RELATIONS`，每種關係一列。`creatable` 為 true 的關係是呼叫者自己能建立的。

| 關係 | 說明 | creatable |
|---|---|---|
| `own` | 自己的組織（執業主體組織的成員） | 否 |
| `operator` | 平台營運者 | 否 |
| `draftAssigned` | 草稿合約的指派指向北辰。MIL-200 起不再綁定，與無關的組織相同，留著當對照 | 是 |
| `bound` | 已綁定：案件的受託人屬於北辰 | 是 |
| `unrelated` | 無關的組織：另一個執業主體組織的成員 | 是 |
| `unrelatedOwner` | 無關的組織：沒有合約的屋主組織 | 是 |
| `noContext` | 沒有組織脈絡 | 是 |

MIL-200 刪掉了 `selecting`。

### 各函式的揭露規則

下表只列有個資讀取路徑的函式。「空」代表成功但不含上列欄位。其他函式（寫入函式、產權函式）登記為「不揭露」，理由寫在各自的 `disclosure.reason`。

| 函式 | own | operator | bound | draftAssigned / unrelated / unrelatedOwner | noContext |
|---|---|---|---|---|---|
| `signing_view`（列出任職） | 證號原文、核對紀錄 ID、失效任職 | 同 own | 核對紀錄 ID | 空 | 被拒 |
| `signing_view`（用任職 ID 查單筆） | 證號原文、email、核對紀錄 ID、失效任職 | 同 own | 核對紀錄 ID、失效任職 | 空 | 被拒 |
| `party_signer_candidates`（列出成員） | 空（email 遮罩） | 空 | 空 | 空 | 被拒 |
| `party_signer_candidates`（用成員 ID 查單筆） | email | email | 空（email 遮罩） | 空 | 被拒 |
| `signing_facts` | 證號原文、核對紀錄 ID、失效任職 | 同 own | 空 | 空 | 被拒 |
| `org_employments` | 證號原文、失效任職 | 被拒 | 空 | 空 | 被拒 |
| `my_practitioner` | 證號原文（本人的） | 被拒 | 空 | 空 | 被拒 |
| `my_registration` | 統編 | 空 | 空 | 空 | 被拒 |
| `review_queue`、`review_item_detail` | 被拒 | 統編、證號原文、核對紀錄 ID、失效任職 | 被拒 | 被拒 | 被拒 |
| `practitioner_party` | 被拒 | 空 | 被拒 | 被拒 | 被拒 |
| `list_practice_entities`、`lookup_practice_entities`、`certificate_badges` | 空 | 空 | 空 | 空 | 被拒 |

`signing_view` 單筆查詢的 `bound` 讀得到失效任職，是設計：送簽前檢查要說明被拒的原因。呼叫者必須先知道任職 ID，任職 ID 不可猜。

專任事實沒有查詢函式。`employment_exclusivity_facts` 已在 0072 移除（MIL-186）。判定在 `submit_practitioner` 與 `create_employment` 內，這兩個函式列為「不揭露」：回傳值只有物件 ID 與結果代碼。詳見下方「殘餘風險」。

### 新增或修改函式時

1. 在自己模組檔的 `registryFunctions` 加 `disclosure`。不確定時先登記 `matrix`，讓測試告訴你實際回了什麼，再對照規則判斷哪個值是對的。不要直接照測試輸出填期望值。
2. 期望值表的 `by` 只寫與 `default` 不同的關係。
3. 新增個資欄位時，在 `PiiField` 與 `registry-disclosure-kit.ts` 的 `sentinels` 加一項，測試資料要有對應的特徵值。
4. 修好已知缺口後，把期望值改成正確值，並刪掉 `knownGaps` 的那一項。

### 已知缺口

目前沒有已知缺口。MIL-200 關掉了 MIL-116 留下的缺口（`bound` 回全部成員的真實 email）：`bound` 不再拿到真實 email，真實 email 只有 `own` 用 ID 查單筆才拿到。

### 殘餘風險：專任判定的阻擋結果（待法務確認）

歷史：MIL-165 的矩陣測試發現，0047 的 `employment_exclusivity_facts` 對任何執業主體組織的成員回傳任意證書鍵在各家的任職，含已失效與待驗證的，連同起訖日。證書鍵可以枚舉。0071 先收斂成別家只回已驗證的列。MIL-186 在 `0072_exclusivity_decision_in_writes.sql` 把判定搬進寫入函式，移除這個函式。

現在的做法：

- 專任判定在資料庫內，與寫入同一個函式呼叫。別家的任職事實只在函式內部讀取，不回給呼叫者，也不回給應用程式。
- `registry.exclusivity_verdict` 是內部函式，不授權給 `app_rw`。只有 `submit_practitioner` 與 `create_employment` 呼叫它。
- `submit_practitioner` 在呼叫者目前執業主體還沒有未結束的任職時判定（第一次登錄，或舊任職失效後換證）。被阻擋時什麼都不寫，回傳 `outcome = 'blocked'`。
- `create_employment` 在建立任職前判定。被阻擋時回傳 `outcome = 'blocked'`。經紀人員在別家已有已驗證在職時，`consent_required` 為 true。
- 阻擋用回傳值表示，不用例外。例外會讓同一個交易回滾，應用程式在同一個交易寫的稽核事件（`rule.full_time_block`、`rule.full_time_notice`）也會消失。稽核事件寫在宣稱方組織的鏈。
- 「今天」取資料庫的台灣日期。函式不收日期參數，因為呼叫者能指定日期，就能用二分法從阻擋與否推出別家任職的起訖日。
- 規則的參考實作是 `src/lib/registry-rules/exclusivity.ts` 的 `classifyEmploymentCreation`。`src/lib/practitioners/exclusivity-sql.test.ts` 固定資料庫與純函式對 82 組輸入的結論相同。
- `decideEmploymentCreation` 保留。應用程式用 `presentCreationVerdict` 把結論轉成訊息與稽核內容。

沒有做「呼叫者必須持有這個證書鍵」的條件。第一次登錄時呼叫者還沒有這個證書鍵的證書列，加了條件，第一次登錄就不再被阻擋（P0-05 AC1、AC6）。

測試：

- `src/lib/pg/exclusivity-disclosure.test.ts`：各種呼叫者直接呼叫。查詢入口一律被拒，寫入路徑只回結論。
- `src/lib/pg/registry-disclosure.test.ts`：直接查詢某個證書鍵在別家有沒有在職，一律被拒，真實與不存在的證書鍵回應相同。
- `src/lib/practitioners/exclusivity-in-writes.pg.test.ts`：真實 PostgreSQL 的授權與寫入。

殘餘風險（待法務確認）：

- 能到達判定的呼叫者（有執業主體登錄的執業主體組織的成員），仍能從「被阻擋」得知某個證書鍵在別家有已驗證在職。
- 這與登錄時的阻擋訊息「此證號已有在職紀錄」揭露的資訊相同，是 ADR-0017 決議 7「建立任職時判定」本身帶來的。
- 回應不含任職的起訖日、狀態、筆數與別家的 ID。
- 經紀人員的 `create_employment` 回傳 `consent_required`，是要求同意書的提示（P0-05 AC3），揭露的資訊與阻擋相同。
- 用別人的證號反覆嘗試登錄，仍能枚舉。登錄嘗試的頻率上限需要產品決定，另案處理。
- 被阻擋的稽核事件由應用程式在同一個交易寫入。直接以 SQL 呼叫寫入函式的人不會留下稽核事件。要讓稽核事件與判定不可分，需要授權寫入函式的擁有者執行 `audit.append`，這會改變稽核模組的授權，尚未做。
- 任職結束後（已驗證轉已失效），阻擋隨之解除。重複嘗試的人能觀察到解除的時間。

### MIL-200 已做的四步（原「MIL-116 拿掉選人階段時」）

1. 刪掉 `registry-disclosure-kit.ts` 的 `CALLER_RELATIONS` 裡 `selecting` 那一列。已刪。
2. 刪掉 `rls-cases/` 內所有 `by.selecting` 的項目。已刪。
3. 同一個 PR 把 `registry.caller_relation` 最後一個判斷拿掉，並拿掉合約指派那一段（migration 0084）。已做。
4. `bound` 改成不回真實 email，刪掉 `party_signer_candidates` 與 `signing_view` 的 `knownGaps`。已做。

## 給下游

- MIL-116（已由 MIL-200 取代）：分流條件「至少一名已驗證專任管理人員」可由 `listPractitioners(entityId, { certificateKinds: ['rental_housing_manager'], fullTime: true, licenseKind })` 是否非空推導。
- MIL-77：委託管理合約沿用同一個 seam。
- F 線：標章用 `getCertificateBadges`（MIL-111），不走 registry seam。
