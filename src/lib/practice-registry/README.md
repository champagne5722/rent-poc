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
- `credential`：業別層取查詢指定的業別，沒有登錄時 `state` 是 `null`。證書層 `validUntil` 是 `YYYY-MM-DD`。任職層是任職期間。三層的 `latestCheckId` 只在 `own` 與 `bound` 有值。`accountEmail` 在 `selecting` 是遮罩的。

## `listPractitioners` 的篩選

依序：證書種類、專任要求、人員本身查詢時點可簽章。第三項呼叫 `credentialStatusAt()`，但把業別層當成已驗證：證書或任職未驗證、已期滿、任職已結束的人不在清單內。業別層不排除，執業主體的業別未驗證時候選仍在，呼叫端靠判定事實說明原因（委託管理合約受託人的 `MANDATARY_LICENSE_UNVERIFIED` 靠這個）。seed adapter 套用同樣的篩選。`getPractitioner` 不套用任何資格條件，`selecting` 關係除外（見下）。

## 跨組織：呼叫者與執業主體的關係

`registry.caller_relation(entity_id)`（內部函式）由資料庫依交易的組織脈絡算出，呼叫者不能指定。`bound` 與 `selecting` 都是呼叫者自己能建立的關係（存一筆指派，或建一份草稿合約），所以它們看不到證號原文，也看不到未驗證與已失效的任職。

| 關係 | 條件 | 證號 | email | 核對紀錄 ID | 列出任職時 |
|---|---|---|---|---|---|
| `own` | 呼叫者是該執業主體自己的組織，或平台營運者 | 原文 | 真實 | 有 | 全部（含待驗證、失效） |
| `bound` | 呼叫者組織的案件成員（`mandatary`、`practitioner`、`broker`）屬於該執業主體的組織；或呼叫者組織的合約指派指向該執業主體 | 遮罩 | 真實 | 有 | 只回證書與任職都已驗證的人。用任職 ID 查單筆時回完整狀態 |
| `selecting` | 呼叫者是屋主或執業主體組織，而且至少有一份草稿合約 | 遮罩 | 遮罩 | 無 | 只回證書與任職都已驗證的人 |
| `none` | 其他 | 空，與執業主體不存在不可區分 | | | |

- 證號遮罩在 SQL 內做（`registry.mask_certificate_no`），原文不離開資料庫。規則與 `maskCertificateNo` 相同：`112年內授營字第1234567號` 只留最後 3 個字元。`maskCertificateNo` 對已遮罩的值結果不變，所以簽章紀錄的快照與以前相同。
- email 遮罩保留第一個字元與網域：`c***@example.com`。姓名與 ID 照回。
- `bound` 的真實 email 是送簽要寄信給簽署人所需。送簽前的 email 重複檢查發生在存指派之後，那時已是 `bound`。

任何屋主或執業主體組織都能查（不分關係）：已驗證執業主體的名單（ID、名稱、已登錄業別），以及 `getEntity` 的名稱與業別。不回統編、組織 ID、人員。

**遮罩 email 卡住的步驟：** 建約 wizard 的 `PractitionerAssignmentPanel` 在選定當事人簽署人時，把簽署人的 email 寫進合約的甲方或乙方欄位（`onPartySigner`）。選人階段是 `selecting`，拿到的是遮罩 email，寫進欄位會讓送簽前檢查的「甲方的姓名與 email 必須與所選的當事人簽署人相同」不通過。沒有放寬遮罩。需要 D 線的畫面配合：遮罩的 email 不要寫進欄位，改由使用者輸入，或存指派後重新讀選項（那時是 `bound`，email 是真實的）。API 流程（欄位的 email 由呼叫端提供）不受影響。

`selecting` 是過渡做法。委託管理合約現在不建案件（MIL-116），選人時沒有任何綁定，卻必須讀別的組織的候選人。MIL-116 把指派搬成案件成員後，可把 `selecting` 拿掉：只改 `caller_relation` 的最後一個判斷。待法務確認：選人階段揭露已驗證人員的姓名與遮罩 email 給有草稿合約的組織，是否符合個資告知（MIL-62）。

`registry.signing_facts()`（0047）沒有放寬，仍只給自己的組織與營運者。跨組織走 `registry.signing_view()`。

## 個資揭露矩陣

起因：MIL-113 的第一版讓其他組織讀到證號原文與成員 email，這條規則當時只寫在 Linear 留言，沒有測試守住（MIL-165）。現在規則由測試守住，測試在 `src/lib/pg/registry-disclosure.test.ts`。

### 規則

1. `registry` schema 內授權給 `app_rw` 的每個函式，必須在 `src/lib/pg/rls-cases/<模組>.ts` 的 `registryFunctions` 登記 `disclosure`。測試從系統目錄列出這些函式，沒登記的讓測試失敗。
2. 函式不回傳個資時，登記 `{ kind: 'none', reason }`，寫出為什麼不揭露。不能靠漏登記通過。
3. 函式回傳個資時，登記 `{ kind: 'matrix', variants }`。每種呼叫方式一個 variant，每個 variant 對每種呼叫者關係各有一列期望值。
4. 呼叫者自己能建立的關係，不得解鎖證號原文。判斷重點是「這個關係是誰能建立的」。建草稿合約、存一筆指派、替案件加成員、開一個執業主體組織，都不需要任何人同意，所以 `bound`、`selecting`、`unrelated` 都讀不到證號原文。
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
| `bound` | 已指派：草稿合約的指派指向該執業主體 | 是 |
| `boundByCase` | 已指派：案件成員屬於該執業主體的組織 | 是 |
| `selecting` | 選人階段：有草稿合約，沒有綁定 | 是 |
| `unrelated` | 無關的組織：另一個執業主體組織的成員 | 是 |
| `unrelatedOwner` | 無關的組織：沒有合約的屋主組織 | 是 |
| `noContext` | 沒有組織脈絡 | 是 |

### 各函式的揭露規則

下表只列有個資讀取路徑的函式。「空」代表成功但不含上列欄位。其他函式（寫入函式、產權函式）登記為「不揭露」，理由寫在各自的 `disclosure.reason`。

| 函式 | own | operator | bound / boundByCase | selecting | unrelated / unrelatedOwner | noContext |
|---|---|---|---|---|---|---|
| `signing_view`（列出任職） | 證號原文、email、核對紀錄 ID、失效任職 | 同 own | email、核對紀錄 ID | 空 | 空 | 被拒 |
| `signing_view`（用任職 ID 查單筆） | 證號原文、email、核對紀錄 ID、失效任職 | 同 own | email、核對紀錄 ID、失效任職 | 空 | 空 | 被拒 |
| `party_signer_candidates` | email | email | email | 空（email 遮罩） | 空 | 被拒 |
| `signing_facts` | 證號原文、核對紀錄 ID、失效任職 | 同 own | 空 | 空 | 空 | 被拒 |
| `org_employments` | 證號原文、失效任職 | 被拒 | 空 | 空 | 空 | 被拒 |
| `my_practitioner` | 證號原文（本人的） | 被拒 | 空 | 空 | 空 | 被拒 |
| `my_registration` | 統編 | 空 | 空 | 空 | 空 | 被拒 |
| `employment_exclusivity_facts` | 失效任職 | 被拒 | 被拒 | 被拒 | `unrelated` 見已知缺口，`unrelatedOwner` 被拒 | 被拒 |
| `review_queue`、`review_item_detail` | 被拒 | 統編、證號原文、核對紀錄 ID、失效任職 | 被拒 | 被拒 | 被拒 | 被拒 |
| `practitioner_party` | 被拒 | 空 | 被拒 | 被拒 | 被拒 | 被拒 |
| `list_practice_entities`、`lookup_practice_entities`、`certificate_badges` | 空 | 空 | 空 | 空 | 空 | 被拒 |

`signing_view` 單筆查詢的 `bound` 讀得到失效任職，是設計：送簽前檢查要說明被拒的原因。呼叫者必須先知道任職 ID，任職 ID 不可猜。

### 新增或修改函式時

1. 在自己模組檔的 `registryFunctions` 加 `disclosure`。不確定時先登記 `matrix`，讓測試告訴你實際回了什麼，再對照規則判斷哪個值是對的。不要直接照測試輸出填期望值。
2. 期望值表的 `by` 只寫與 `default` 不同的關係。
3. 新增個資欄位時，在 `PiiField` 與 `registry-disclosure-kit.ts` 的 `sentinels` 加一項，測試資料要有對應的特徵值。
4. 修好已知缺口後，把期望值改成正確值，並刪掉 `knownGaps` 的那一項。

### 已知缺口

目前行為與原則不符，已有人負責，期望值先登記目前的行為。每則缺口必須指向一張票。

| 函式 | 關係 | 缺口 | 負責 |
|---|---|---|---|
| `party_signer_candidates`、`signing_view` | `bound`、`boundByCase` | 回該執業主體全部成員（或全部已驗證人員）的真實 email，不限於被指派的人 | MIL-116 |
| `employment_exclusivity_facts` | `unrelated` | 任何執業主體組織的成員，用任意證書鍵都能查到別家任職的狀態與起訖日，與查不存在的證書鍵可區分 | MIL-165，待主控決定修法 |

### MIL-116 拿掉選人階段時

1. 刪掉 `registry-disclosure-kit.ts` 的 `CALLER_RELATIONS` 裡 `selecting` 那一列。
2. 刪掉 `rls-cases/` 內所有 `by.selecting` 的項目。測試會列出還沒刪的。
3. 同一個 PR 把 `registry.caller_relation` 最後一個判斷拿掉。
4. 若 `bound` 改成只回被指派的人的 email，刪掉 `party_signer_candidates` 與 `signing_view` 的 `knownGaps`，並調整 `bound` 的期望值。

## 給下游

- MIL-116：分流條件「至少一名已驗證專任管理人員」可由 `listPractitioners(entityId, { certificateKinds: ['rental_housing_manager'], fullTime: true, licenseKind })` 是否非空推導。案件成員建立後，`bound` 關係自動成立，不必改 adapter。
- MIL-77：委託管理合約沿用同一個 seam。
- F 線：標章用 `getCertificateBadges`（MIL-111），不走 registry seam。
