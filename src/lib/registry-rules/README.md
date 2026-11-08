<!-- ste-lint: off -->
<!-- 模組說明給 agent 與開發者讀，內容是指向 ADR 的對照，句長規則不適用 -->
# `src/lib/registry-rules/`：經理人驗證的純函式規則

純函式模組，沒有 I/O。只匯出純函式、常數與型別，不 import `src/lib/db.ts`，不呼叫 `Date.now()`。時間與今天的日期一律由參數傳入。ID 參數一律 `string`。日期是台灣日期的 `YYYY-MM-DD` 字串，時間戳記是 ISO 8601 字串。

依據：ADR-0017（驗證三態、三層狀態、專任四個判定點、效期與換證）、ADR-0020（worker 計時器）、MIL-100 Further Notes 的計時器表、PRD P0-03、P0-04、P0-05。票是 MIL-109、MIL-111、MIL-112 不碰資料庫的部分。表、定義者函式、畫面、通知、vault 與稽核事件等 MIL-82 之後的部分，在 `integration/line-c` 做。

識別字：業別 `management`、`master_lease`、`brokerage`。證書種類 `rental_housing_manager`、`real_estate_broker`、`real_estate_sales_agent`。驗證三態 `pending`、`verified`、`lapsed`。型別 `LicenseKind`、`CertificateKind` 來自 `src/lib/labels`。

## 檔案

| 檔案 | 內容 |
|---|---|
| `credential-transition.ts` | `decideCredentialTransition()`：ADR-0017 決議 4 的轉移表，三層共用 |
| `license-rules.ts` | `checkLicenseEligibility()`、`decideRegistrationLoss()`：業別規則與登記狀態失效 |
| `exclusivity.ts` | 專任判定點 1、2、4、`valid_until` 預填、標章 |
| `timers.ts` | 6 條計時器的決策與冪等鍵、`scanTimers()` |
| `dates.ts` | 日期運算，內部使用，不從 `index.ts` 匯出 |
| `index.ts` | 四個檔案的匯出 |

## 規則摘要

### `decideCredentialTransition(state, { layer, event })`

`state` 是 `pending`、`verified`、`lapsed` 或 `null`（無）。`layer` 是 `license`、`practitioner`、`employment`。不接受時回 `null`，接受時回 `{ from, to, event, validUntil? }`。

| 目前狀態 | 事件 | 條件 | 下一狀態 |
|---|---|---|---|
| 無 | `submitted` | `requiredFieldsComplete` | `pending` |
| `pending` | `check_matched` | `violatesExclusivity` 為 false | `verified` |
| `pending` | `check_mismatched`、`resubmitted` | | `pending` |
| `verified` | `renewed` | 新效期是有效日期，回傳 `validUntil` | `verified` |
| `verified` | `expired` | 查詢日晚於 `validUntil`，當天仍有效 | `lapsed` |
| `verified` | `revoked` | | `lapsed` |
| `verified` | `registration_lost` | 只限業別層 | `lapsed` |
| `verified` | `employment_ended`、`consent_ended` | 只限任職層 | `lapsed` |
| `lapsed` | `resubmitted` | 任職層不接受（新任職建新列） | `pending` |

`renewed` 與 `expired` 只限業別與證書，任職沒有效期。

### 業別規則

- `checkLicenseEligibility({ kind, entityType, businessItemCodes })`：代管 H706011，包租 H706021，經紀 H704031。代管與包租限公司（`entityType: 'company'`），經紀得為商號（`'firm'`）。被擋時回全部原因，每項帶 `message`，缺項目時帶 `missing`（P0-03 AC2、AC3）。
- `decideRegistrationLoss({ registrationStatus, licenses })`：登記狀態不是 `核准設立` 時，回傳所有 `verified` 業別的 `registration_lost` 轉移。`pending` 與 `lapsed` 的業別不動。

### 專任規則的四個判定點

| 判定點 | 函式 | 備註 |
|---|---|---|
| 1 建立任職 | `decideEmploymentCreation()` | 管理人員：別家已驗證在職（任職期間涵蓋今天）時 `blocked`，訊息固定為「此證號已有在職紀錄」。別家只有 `pending` 時並存。經紀人員：回 `consentRequired: true` 與提示，仍建 `pending` |
| 2 核對相符 | `decideEmploymentVerification()` | 回 `violatesExclusivity`（餵給 `check_matched`）、`message`（審核台訊息）與 `audit`。只涵蓋管理人員。經紀人員不擋，同意書未核對時回警示 `consent_missing`，已核對時 `consentedByEntity: true`（標示「經所屬業者同意」） |
| 3 送簽與簽章當下 | 不在本模組 | 由 D 線的 `credentialStatusAt()` 判定，C 線沿用（ADR-0017 決議 6，細節屬 MIL-46） |
| 4 定期重驗 | `decideRecheckResult()` | resim 與登錄不符、查無、廢止時，以 `revoked` 事件轉 `lapsed`。相符不改狀態 |

別家的任職由呼叫端查出後傳入（`OtherEmployment[]`）。回傳的訊息與稽核不含別家的任何 ID（ADR-0012 決議 8）。阻擋與提示的 `audit` 欄位含證號、時間與原因，呼叫端同交易寫稽核事件（P0-05 AC6）。

- `prefillValidUntil(issuedOn)`：發證日加 4 年。`checkValidUntilConsistency(issuedOn, validUntil)` 不一致時只提示，不阻擋。
- `certificateBadge(checkedOn)`：固定文字「證書資料已核對」加核對日。`containsForbiddenBadgeWord()` 檢查「保證合法」「認證」「擔保」。

### 計時器

| 函式 | 計時器 | 觸發 | 動作 | 冪等鍵的日期 |
|---|---|---|---|---|
| `decideMandateExpiry` | 委託到期 | `active` 且今天晚於 `validUntil` | `expire_mandate`，通知屋主 1 次 | `validUntil` 隔天 |
| `decideRenewalReminders` | 換證窗口 | 今天 = `validUntil` 減 6 個月 | `notify` 執業人員與執業主體 | 當日 |
| `decideRenewalReminders` | 期滿前 30 日 | 今天 = `validUntil` 減 30 日 | `notify` 執業人員與執業主體 | 當日 |
| `decideCertificateExpiry` | 證書期滿 | `verified` 且今天晚於 `validUntil` | `lapse_certificate`，通知執業人員與執業主體 | `validUntil` 隔天 |
| `decideEmploymentRecheck` | 任職重驗 | `verified` 且今天 >= 上次核對加 6 個月 | `enqueue_review`，不通知 | 到期日 |
| `decideEntityRecheck` | 執業主體重查 | 有已驗證業別，每月 | `enqueue_review`，不通知 | 年月（`YYYY-MM`） |
| `decideEvidencePurge` | 證據檔刪除 | 不符後滿 30 日，或同意書失效後滿 30 日 | `purge_evidence` | 到期日 |

- 共 6 條計時器。換證窗口這條會產生兩種提醒事件（進入窗口當日、期滿前 30 日），所以事件名有 7 個（`TIMER_EVENTS`）。
- 日期壞掉的事實（含 `today`）會被略過，不拋例外，一筆壞資料不會中斷整輪（ADR-0020 決議 7）。
- `decideEvidencePurge` 以最新一筆不符核對的日期起算。補件後的新檔是新的證據檔，傳入時它的 `latestCheck` 是 `null`，不會被舊的不符紀錄刪掉。
- `decideRecheckResult` 把 `mismatch`、`not_found`、`revoked` 都視為重驗不符，以 `revoked` 事件轉 `lapsed`。ADR-0017 決議 7 第 4 點只寫「不符」，查無算不符是本模組的解讀。
- 冪等鍵是 `主體ID:事件:日期`，通知再加 `:收件者`。`scanTimers(facts, today, config)` 一次掃完，依上表順序輸出。
- 30 日、6 個月都是 `TimerConfig` 的設定值，`DEFAULT_TIMER_CONFIG` 是預設。
- 兩條提醒只在觸發當日產生，不補發。`scan-timers` 漏跑那一天會漏掉該次提醒，另一條提醒與期滿轉 `lapsed` 不受影響。其他狀態驅動的計時器補跑時鍵不變，呼叫端依鍵去重即可。
- 掃描入口只傳入該掃的事實：委託管理案件、已建立證書的執業人員、任職、執業主體、證據檔。已結束或已刪除的不必傳。

## 與各票的接點

### MIL-109：執業主體登錄與審核台核對業別

- 登錄業別時呼叫 `checkLicenseEligibility()`，被擋就顯示 `reasons[].message`。
- 審核台寫入核對結果時，用 `decideCredentialTransition(state, { layer: 'license', event })` 決定下一狀態。相符是 `check_matched`，不符是 `check_mismatched`，補件是 `resubmitted`。
- 月度重查查到登記狀態時呼叫 `decideRegistrationLoss()`，對回傳的每一列在同交易更新狀態並寫稽核。
- 核對紀錄、稽核事件、`registry` 定義者函式與批次查詢由 `integration/line-c` 實作。

### MIL-111：證書登錄、任職與專任規則

- 證書登錄表單：`prefillValidUntil()` 預填，`checkValidUntilConsistency()` 提示。
- 建立任職：查出同證號在別家的任職，呼叫 `decideEmploymentCreation()`。`blocked` 時不建列，顯示 `message`，寫 `audit`。`created` 時建 `pending`，`consentRequired` 為 true 時要求上傳同意書。
- 營運者按相符：先呼叫 `decideEmploymentVerification()`，把 `violatesExclusivity` 帶進 `check_matched`。資料庫的排除約束（只涵蓋 `verified` 的管理人員專任任職）是最後防線，本函式是它的純函式對照。
- 屋主端標章：`certificateBadge()`。
- 證書與任職的狀態轉移用 `decideCredentialTransition()`，`layer` 分別是 `practitioner` 與 `employment`。

### MIL-112：`scan-timers`

- worker 取得各組織的事實後呼叫 `scanTimers(facts, today, config)`，今天是台灣日期。
- 對每筆 `TimerDecision` 依 `action` 執行，並用 `idempotencyKey` 去重。通知再用 `notifications[].idempotencyKey` 去重。
- `lapse_certificate` 的 `transition` 已算好，呼叫端照寫。已指派的執業人員轉 `lapsed` 時通知執業主體撤回後改派，掛在轉移上（ADR-0018 決議 11 情況 A）。
- `expire_mandate` 對應 `decideCaseTransition()` 的 `mandate_expired` 輸入，由案件模組執行。
- 定期重驗查回結果後，用 `decideRecheckResult()` 決定要不要轉 `lapsed`。

### MIL-113：可簽章判定事實

- 本模組不實作 `credentialStatusAt()`，它屬 D 線。`practiceRegistry` 真實 adapter 回傳的事實是三層 `CredentialState`、`validUntil`、任職期間與最新核對紀錄 ID。
- 本模組的 `CredentialState` 與 `CredentialLayer` 是這些事實的型別來源。判定「可簽章」時，三層都必須是 `verified`，任職期間涵蓋查詢時點，查詢時點不晚於 `validUntil`（ADR-0017 決議 6）。
- 專任判定點 3（送簽與簽章當下）就是這個判定，接點在 D 線的 `checkSendPreconditions()`。
