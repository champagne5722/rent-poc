# Q13：SQLite 改 PostgreSQL 的呼叫點數量

本筆記已依 [稽核報告](../audit/audit-phase1-map-research.md) 修正。

調查日期：2026-11-07。對應 Linear MIL-37。量測基準 commit：`2f39b875`。

讀這份筆記前的三個提醒：

1. 本筆記的數字都由 TypeScript compiler API 與 grep 兩種方法量測，檔案與行號可重查。
2. 工時是估算，不是量測。假設寫在第 6 節。稽核後新增的假設也在第 6 節。
3. 這次只量測現況的程式碼。M2 起新增的模組會增加呼叫點。

---

## 結論

`src/lib/db.ts` 匯出 27 個符號，其中 23 個是函式。19 個函式會碰資料庫。

production 程式碼有 19 個檔案、45 個呼叫點。45 個點是 37 次 db 函式呼叫、4 次 `getDb()`、4 次直接 `.prepare()`。測試有 6 個檔案、140 個呼叫點。

db 層改回傳 Promise 後，必須新變 async 的 production 函式有 5 個：`applyDsEvent()`、`isSaved()`、`writeContractFile()`、`recordFailure()`、`readSavedContractFile()`。route handler 共 25 個，全部已是 async。24 個在連鎖範圍內。

漏掉 `await` 而 `tsc` 不報錯的點有 24 處，不是 13 處。其中 9 處連 ESLint 的兩條規則都抓不到，必須靠驗 response body 的測試。

沒有 server component、server action 或 middleware 碰 db。6 個業務 `page.tsx` 都是 client component。`layout.tsx` 與 `design/page.tsx` 是 server component（依文件預設），但不 import db。

runtime 交易有 5 個，初始化交易有 2 個。交易內沒有外部 API 呼叫。外部呼叫都在交易之外。

步驟 1 加步驟 2 的估算改為 6.5 至 10 人日，原為 6 至 8.5。這是估算，不是量測。
上調的原因是稽核後新增兩項假設：SQLite 版 `withTx` 要加序列化佇列，以及 24 處漏 `await` 要靠 lint 加 response body 測試處理。這兩項的人日數是新增假設，沒有實測依據。
M1 排得下的前提是沒有新增模組搶同一批檔案。待步驟 1 實作後更新。

---

## 1. `db.ts` 匯出清單

來源：`src/lib/db.ts`。方法見第 7 節。

| 符號 | 行 | 種類 | 碰資料庫 | production 呼叫 | 測試呼叫 |
|---|---|---|---|---|---|
| `DATA_DIR` | 20 | const | 否 | 1（`contract-files.ts:59`，只讀路徑） | 0 |
| `ensureSchema` | 27 | function | 是 | 0 | 15 |
| `getDb` | 140 | function | 取得連線 | 4 | 0 |
| `setDb` | 146 | function | 否（換連線） | 0 | 10 |
| `rowToProperty` | 158 | function | 否（純函式） | 0 | 0 |
| `rowToContract` | 162 | function | 否（純函式） | 0 | 0 |
| `listProperties` | 170 | function | 是 | 1 | 0 |
| `getProperty` | 174 | function | 是 | 2 | 3 |
| `listEquipmentVocabulary` | 182 | function | 是 | 1 | 6 |
| `addCustomEquipmentItem` | 192 | function | 是 | 1 | 6 |
| `ensureEquipmentVocabulary` | 203 | function | 是（交易） | 2 | 0 |
| `listContracts` | 214 | function | 是 | 1 | 0 |
| `getContract` | 218 | function | 是 | 15 | 19 |
| `findContractByTaskId` | 223 | function | 是 | 1 | 0 |
| `ContractEventInput` | 232 | interface | 否 | 型別引用 1（`transitions.ts:11`） | 0 |
| `appendContractEvent` | 239 | function | 是 | 0 | 7 |
| `listContractEvents` | 252 | function | 是 | 1 | 14 |
| `TransitionCommit` | 258 | interface | 否 | 0 | 0 |
| `commitTransition` | 267 | function | 是（交易） | 2 | 1 |
| `insertContractWithEvent` | 286 | function | 是（交易） | 1 | 3 |
| `copyContractAsDraft` | 308 | function | 是（交易） | 1 | 11 |
| `getContractRelations` | 325 | function | 是 | 1 | 7 |
| `deleteContractWithEvents` | 338 | function | 是（交易） | 1 | 0 |
| `ContractFileInput` | 347 | type | 否 | 0 | 0 |
| `upsertContractFile` | 350 | function | 是 | 2 | 5 |
| `getContractFile` | 367 | function | 是 | 2 | 3 |
| `listContractFiles` | 374 | function | 是 | 2 | 6 |

小計：

- 27 個符號 = 23 個函式 + 1 個 const + 2 個 interface + 1 個 type。
- 23 個函式 = 19 個碰資料庫 + 4 個不碰（`getDb`、`setDb`、`rowToProperty`、`rowToContract`）。
- production 呼叫合計 41 = 37 次 db 函式 + 4 次 `getDb`。
- 測試呼叫合計 116 = 91 次 db 函式 + 15 次 `ensureSchema` + 10 次 `setDb`。

`db.ts` 另有 4 個未匯出的函式：`seedEquipmentVocabulary`（99）、`normalizePropertyEquipment`（111）、`addColumnIfMissing`（126）、`createDb`（132）。它們屬於 schema 初始化，步驟 3 的 migration 工具會取代它們。

`db.ts` 內部：26 次 `.prepare`、7 次 `.transaction`、2 次 `.exec`、1 次 `.pragma`、18 次 `getDb()`（預設參數與函式本體）、4 次 `appendContractEvent` 內部呼叫（281、300、317、318）。

---

## 2. 呼叫點：依檔案

### 2.1 production 程式碼（19 個檔案、45 個點）

「fn」是 db 函式呼叫。「getDb」與「prepare」是直接碰 better-sqlite3 的點。

| 檔案 | fn | getDb | prepare | 呼叫與行 |
|---|---|---|---|---|
| `src/app/api/contracts/[id]/audit-trail/route.ts` | 1 | 0 | 0 | getContract@11 |
| `src/app/api/contracts/[id]/copy/route.ts` | 2 | 0 | 0 | getContract@10, copyContractAsDraft@13 |
| `src/app/api/contracts/[id]/events/route.ts` | 2 | 0 | 0 | getContract@10, listContractEvents@13 |
| `src/app/api/contracts/[id]/files/route.ts` | 4 | 0 | 0 | getContract@10,18, listContractFiles@12,26 |
| `src/app/api/contracts/[id]/pdf/route.ts` | 1 | 0 | 0 | getContract@10 |
| `src/app/api/contracts/[id]/resend/route.ts` | 1 | 0 | 0 | getContract@11 |
| `src/app/api/contracts/[id]/route.ts` | 5 | 1 | 1 | getContract@9,16,35, getContractRelations@11, deleteContractWithEvents@41, getDb+prepare@25 |
| `src/app/api/contracts/[id]/send/route.ts` | 2 | 0 | 0 | getContract@11, commitTransition@39 |
| `src/app/api/contracts/[id]/sign-link/route.ts` | 1 | 0 | 0 | getContract@12 |
| `src/app/api/contracts/[id]/signed-pdf/route.ts` | 1 | 0 | 0 | getContract@11 |
| `src/app/api/contracts/[id]/void/route.ts` | 1 | 0 | 0 | getContract@11 |
| `src/app/api/contracts/route.ts` | 3 | 0 | 0 | listContracts@8, getProperty@15, insertContractWithEvent@39 |
| `src/app/api/equipment-vocabulary/route.ts` | 2 | 0 | 0 | listEquipmentVocabulary@8, addCustomEquipmentItem@16 |
| `src/app/api/mock/advance/route.ts` | 1 | 0 | 0 | getContract@13 |
| `src/app/api/properties/[id]/route.ts` | 2 | 2 | 2 | getProperty@9, ensureEquipmentVocabulary@22, getDb+prepare@23,42 |
| `src/app/api/properties/route.ts` | 2 | 1 | 1 | listProperties@6, ensureEquipmentVocabulary@20, getDb+prepare@21 |
| `src/app/api/webhooks/dottedsign/route.ts` | 1 | 0 | 0 | findContractByTaskId@34 |
| `src/lib/contract-files.ts` | 4 | 0 | 0 | getContractFile@159,210, upsertContractFile@177,191 |
| `src/lib/transitions.ts` | 1 | 0 | 0 | commitTransition@69 |
| 合計 | 37 | 4 | 4 | 45 個點 |

`db.transaction` 在 `db.ts` 之外是 0 次。4 次直接 `.prepare` 都在 route handler，必須搬進 repository 方法：

- `src/app/api/contracts/[id]/route.ts:25`（UPDATE 合約欄位）
- `src/app/api/properties/[id]/route.ts:23`（UPDATE 物件）、`:42`（DELETE 物件）
- `src/app/api/properties/route.ts:21`（INSERT 物件，用 `lastInsertRowid`）

grep 交叉檢查：18 個 db 函式名加 `(` 在 production（排除 `db.ts` 與測試）共 37 行，與 AST 一致。

### 2.2 測試檔（6 個檔案、140 個點）

| 檔案 | ensureSchema | setDb | fn | prepare | exec | 合計 | 測試案例 |
|---|---|---|---|---|---|---|---|
| `src/lib/clause-snapshot-db.test.ts` | 1 | 2 | 11 | 3 | 0 | 17 | 10 |
| `src/lib/contract-derivation.test.ts` | 3 | 2 | 25 | 6 | 1 | 37 | 9 |
| `src/lib/contract-files-db.test.ts` | 1 | 2 | 10 | 1 | 0 | 14 | 3 |
| `src/lib/contract-files-store.test.ts` | 1 | 2 | 4 | 1 | 0 | 8 | 6 |
| `src/lib/equipment-vocabulary-db.test.ts` | 8 | 2 | 15 | 2 | 0 | 27 | 10 |
| `src/lib/transitions.test.ts` | 1 | 0 | 26 | 6 | 4 | 37 | 20 |
| 合計 | 15 | 10 | 91 | 19 | 5 | 140 | 58 |

測試案例數以 `vitest list` 為準，共 58。`transitions.test.ts` 的 20 含 `it.each` 展開的 4 列。

另有 7 次 `new Database(':memory:')`（每檔 1 次，`contract-derivation.test.ts` 多 1 次建舊 schema，`:39`）。

測試的 24 個 `prepare` 與 `exec` 直接寫 SQLite 方言。例如 `transitions.test.ts:123,134` 用 `CREATE TRIGGER ... RAISE(ABORT, ...)` 模擬寫入失敗。這些必須改成 repository 種子函式，或改寫成 PostgreSQL 語法。

測試另有 3 個同步輔助函式會變 async：`seedDraft`、`saveDraftFields`（`clause-snapshot-db.test.ts:62,71`）與 `seedContract`（`contract-derivation.test.ts:20`）。

AST 的 91 次 fn 呼叫與 grep 的 84 行不同。原因是同一行有多次呼叫，例如 `getContractRelations(getContract(...))`。

---

## 3. `applyDsEvent()`、`commitTransition()` 與呼叫端

### 3.1 `commitTransition()`

定義：`src/lib/db.ts:267`。簽章 `(contractId, commit, db = getDb()): void`。本體是一個 `db.transaction`（272）：UPDATE `contracts`，再呼叫 `appendContractEvent`（281）。

| 呼叫端 | 行 | 備註 |
|---|---|---|
| `src/app/api/contracts/[id]/send/route.ts` | 39 | 語句位置，回傳值不用 |
| `src/lib/transitions.ts`（`applyDsEvent`） | 69 | 語句位置，傳入可選 `db` |
| `src/lib/transitions.test.ts` | 171 | 測試 |

### 3.2 `applyDsEvent()`

定義：`src/lib/transitions.ts:60`。簽章 `(contract, event, reason?, db?): ContractStatus | null`。先呼叫純函式 `decideTransition()`（不動），再呼叫 `commitTransition()`。

| 呼叫端 | 行 | 結果值用途 |
|---|---|---|
| `src/app/api/contracts/[id]/void/route.ts` | 22 | 語句位置，回傳值不用 |
| `src/app/api/mock/advance/route.ts` | 20 | `const next = ...`，之後判斷 `next` |
| `src/app/api/webhooks/dottedsign/route.ts` | 47 | `const next = ...`，之後判斷 `next === 'completed'` |
| `src/lib/transitions.test.ts` | 88, 89, 102, 115, 125, 136 | 125 與 136 用 `expect(() => ...).toThrow()` |

`void/route.ts:22` 是語句位置。漏寫 `await` 時型別檢查不會報錯，只會留下沒等待的 Promise，交易失敗無人知道。

---

## 4. 連鎖範圍與入口

### 4.1 規則

起點是 19 個碰資料庫的匯出函式。從呼叫圖往外推，只要函式內呼叫了起點，這個函式就必須變 async。推到 route handler、server action、server component 為止。

### 4.2 必須新變 async 的函式（production，db.ts 之外）

| 函式 | 位置 | 為何必須變 async |
|---|---|---|
| `applyDsEvent` | `src/lib/transitions.ts:60` | 呼叫 `commitTransition` |
| `isSaved` | `src/lib/contract-files.ts:158` | 呼叫 `getContractFile` |
| `writeContractFile` | `src/lib/contract-files.ts:172` | 呼叫 `upsertContractFile` |
| `recordFailure` | `src/lib/contract-files.ts:189` | 呼叫 `upsertContractFile` |
| `readSavedContractFile` | `src/lib/contract-files.ts:209` | 呼叫 `getContractFile` |

連鎖內已是 async 的函式有 4 個：`saveContractFiles`（100）、`saveMockSignedPdf`（162）、`saveContractFilesOnCompleted`（150）、`serveContractFile`（218）。它們只需要補 `await`。

### 4.3 需要補 `await` 的 production 呼叫點

| 類別 | 點數 |
|---|---|
| db 函式呼叫（見 2.1） | 37 |
| 4 次直接 `getDb().prepare()`，改成 repository 方法後再 `await` | 4 |
| `applyDsEvent` | 3 |
| `isSaved` | 1 |
| `recordFailure` | 5 |
| `writeContractFile` | 2 |
| `readSavedContractFile` | 2 |
| 合計 | 54 |

### 4.4 無法直接補 `await` 的點（匿名 callback）

3 個點在同步 callback 內，必須改寫流程：

- `src/lib/contract-files.ts:107`：`.filter((kind) => ... !isSaved(...))`。`filter` 不接受 async callback。改成先 `Promise.all` 查出已保存清單再過濾。
- `src/lib/contract-files.ts:115`、`:123`：`kinds.map((kind) => recordFailure(...))`。改成 `Promise.all(kinds.map(async ...))` 或循序迴圈。兩處的回傳型別從 `SaveFileResult[]` 變成 `Promise<SaveFileResult[]>`。

### 4.5 漏 `await` 而 `tsc` 不報錯的點（24 處）

原筆記只算語句位置的 13 處。稽核實測後共 24 處。實測方法：在 scratchpad 副本把 db 函式改 async，跑 `tsc` 與 type-aware ESLint。結果依兩條規則分三類。

目前 `eslint.config.mjs` 只用 `next/core-web-vitals` 與 `next/typescript`，兩條規則都沒開。

**甲、`no-floating-promises` 抓得到（13 處）**

這是語句位置，回傳 `void`。13 處同原筆記：

- db 函式（7 處）：`send/route.ts:39`、`contracts/[id]/route.ts:41`、`properties/route.ts:20`、`properties/[id]/route.ts:22`、`contract-files.ts:177,191`、`transitions.ts:69`
- 連鎖函式（3 處）：`void/route.ts:22`（`applyDsEvent`）、`contract-files.ts:138,165`（`writeContractFile`）
- 直接 `.prepare().run()`（3 處）：`contracts/[id]/route.ts:25`、`properties/[id]/route.ts:23,42`

其中 10 處進了實驗，全部被抓到。後 3 處 `.prepare().run()` 還不是 repository 方法，沒進實驗。

**乙、`no-misused-promises` 抓得到（2 處）**

| 位置 | 程式碼形式 | 漏 `await` 的後果 |
|---|---|---|
| `equipment-vocabulary/route.ts:16` | `if (!added)` | 409 分支不會觸發 |
| `contract-files.ts:107` | `!isSaved(...)` 在 `filter` 內 | 未帶 `force` 時清單變空 |

**丙、兩條規則都抓不到（9 處）**

原因是 `Response.json` 的參數型別是 `any`。

| 位置 | 程式碼形式 | 漏 `await` 的後果 |
|---|---|---|
| `contracts/route.ts:8` | `Response.json({ data: listContracts() })` | 回傳空物件 |
| `properties/route.ts:6` | 同上，`listProperties` | 同上 |
| `equipment-vocabulary/route.ts:8` | 同上，`listEquipmentVocabulary` | 同上 |
| `contracts/[id]/events/route.ts:13` | 同上，`listContractEvents` | 同上 |
| `contracts/[id]/files/route.ts:12` | 同上，`listContractFiles` | 同上 |
| `contracts/[id]/files/route.ts:26` | 同上 | 同上 |
| `contracts/[id]/route.ts:11` | 同上，`getContractRelations` | 同上 |
| `contracts/[id]/copy/route.ts:13` | `newId` 傳入 `Response.json` | 新 id 變空物件 |
| `contracts/route.ts:39` | `id` 傳入 `Response.json` | 同上 |

13 + 2 + 9 = 24 處。

「回傳空物件」依 Promise 序列化行為推論，沒有啟動伺服器驗證。稽核也將這 11 處的實際回應內容列為未能核對。

建議：

- 步驟 2 動工前開 `@typescript-eslint/no-floating-promises` 與 `@typescript-eslint/no-misused-promises`。需要 type-aware lint。
- 兩條規則只涵蓋 15 處。其餘 9 處必須靠 route 層測試，驗 response body，不能只看狀態碼。
- `src/app` 下目前沒有任何測試檔。見 6.1。

這是建議。實驗腳本與結果在稽核者的 scratchpad，不在 repo，路徑見第 7 節。

### 4.6 入口清單

Next.js 版本 16.2.11。依 `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`，route handler 範例一律是 `export async function GET/POST(...)`。依同目錄 `page.md` 第 43 行，server component 的 page 可寫成 `export default async function Page`。依 `01-directives/use-server.md`，server function 也可 async。

| 入口類型 | 數量 | 已是 async | 在連鎖內 |
|---|---|---|---|
| route handler（18 個 `route.ts`） | 25 | 25 | 24 |
| server action（`'use server'`） | 0 | 不適用 | 0 |
| server component（碰 db） | 0 | 不適用 | 0 |
| middleware / proxy | 0 | 不適用 | 0 |

唯一不在連鎖內的 handler 是 `src/app/api/meta/route.ts:3`（`GET`，只讀 `isMockMode()`）。

24 個連鎖內 handler 依檔案：

- `contracts/route.ts`：GET、POST
- `contracts/[id]/route.ts`：GET、PUT、DELETE
- `contracts/[id]/{audit-trail, copy, events, pdf, resend, send, sign-link, signed-pdf, void}/route.ts`：各 1 個，其中 `files/route.ts` 有 GET 與 POST（計 2 個）
- `equipment-vocabulary/route.ts`：GET、POST
- `mock/advance/route.ts`：POST
- `properties/route.ts`：GET、POST
- `properties/[id]/route.ts`：PUT、DELETE
- `webhooks/dottedsign/route.ts`：POST

頁面不在連鎖內。6 個 `page.tsx` 都有 `'use client'` 且不 import `@/lib/db`、`transitions`、`contract-files`。`layout.tsx` 與 `design/page.tsx` 沒有 `'use client'`，依 `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` 預設是 server component，但也不 import 它們。client component 用 `fetch` 打 route handler。

結論：連鎖範圍止於 route handler，不會進到 React 渲染層。

### 4.7 呼叫圖的限制

- 只追蹤「直接呼叫已宣告函式」。函式當值傳遞（例如傳給 `.map(fn)`）不會被追到。目前 production 沒有這種用法，靠人工核對確認（`importRefs` 輸出只有 `DATA_DIR` 與型別各 1 筆）。
- 動態 `import()` 與 `require` 沒有掃。grep 確認 `src/` 沒有。

---

## 5. 同步交易的特殊風險

### 5.1 交易清單

`db.transaction(() => {...})()` 在 `db.ts` 共 7 個：

| 位置 | 函式 | 類型 | 交易內呼叫 |
|---|---|---|---|
| `db.ts:101` | `seedEquipmentVocabulary` | 初始化 | `insert.run`（迴圈） |
| `db.ts:116` | `normalizePropertyEquipment` | 初始化 | `parseStoredEquipment`、`JSON.stringify`、`update.run`、`insertName.run` |
| `db.ts:206` | `ensureEquipmentVocabulary` | runtime | `name.trim`、`insert.run`（迴圈） |
| `db.ts:272` | `commitTransition` | runtime | `db.prepare(UPDATE).run`、`appendContractEvent` |
| `db.ts:295` | `insertContractWithEvent` | runtime | `db.prepare(INSERT).run`、`Number`、`appendContractEvent` |
| `db.ts:312` | `copyContractAsDraft` | runtime | `db.prepare(INSERT).run`、`JSON.stringify`、`Number`、`appendContractEvent` 兩次 |
| `db.ts:339` | `deleteContractWithEvents` | runtime | `db.prepare(DELETE)` 兩次 |

`db.ts` 之外沒有 `db.transaction`。

### 5.2 交易內有沒有外部 API

沒有。7 個交易內只有 SQL、`JSON.stringify`、`Number`、`trim`、`parseStoredEquipment`。

外部呼叫都在交易之外，位置如下：

| 外部呼叫 | 位置 | 與 DB 呼叫的順序 |
|---|---|---|
| `createSignTask`（點點簽） | `send/route.ts:37` | `getContract`（11）→ 外部 → `commitTransition`（39） |
| `voidSignTask`（點點簽） | `void/route.ts:18` | `getContract`（11）→ 外部 → `applyDsEvent`（22） |
| `dsGetJson`、`fetch` | `contract-files.ts:119,135` | `isSaved`（107）→ 外部 → `upsertContractFile`（經 `writeContractFile`） |
| `generateContractPdf`（本機 PDF） | `send/route.ts:35`、`contract-files.ts:164` | 不是網路呼叫 |

這些順序符合架構 6.3「交易內不能呼叫外部 API」。交易內無外部呼叫。是否走 outbox 依架構 6.4 另議。該段寫對外呼叫一律走 outbox（`architecture.md` 1830 行）。本筆記只量測交易內有無外部呼叫，不判斷 outbox 要不要做。
`contracts/[id]/send` 的外部呼叫成功後 `commitTransition` 失敗，點點簽任務會留下孤兒。這是現況行為，與 async 化無關。

### 5.3 非同步化後必須重寫的交易邊界

| 項目 | 現況 | 重寫內容 |
|---|---|---|
| 5 個 runtime 交易 | 同步 callback，`better-sqlite3` 保證原子 | 改成 `withTx(async (tx) => ...)`。SQLite 版必須加序列化佇列（見 5.4）。內部 `appendContractEvent` 必須接 `tx`，不能再用預設的 `getDb()` |
| `appendContractEvent` 的 `db` 參數（239） | 可選參數，預設 `getDb()` | 改為必填的 `tx` 或 `Queryable`，避免交易內誤走另一條連線 |
| 2 個初始化交易 | `ensureSchema` 路徑 | 由 migration 工具取代（步驟 3），不需寫 async 版 |
| `lastInsertRowid`（`db.ts:199,299,316`、`properties/route.ts:34`） | SQLite 專有。`db.ts:199` 在 `addCustomEquipmentItem` | 改為 `RETURNING id` |
| `ensureEquipmentVocabulary` 加物件 INSERT/UPDATE | 兩步各自獨立，沒有共用交易 | 現況已非原子。建議在 `withTx` 內合併，這是可選項 |

### 5.4 SQLite 暫時實作的陷阱（步驟 1）

步驟 1 要求仍以 SQLite 實作，且介面一律回傳 Promise。這有一個陷阱：

- `better-sqlite3` 只有一條連線。`withTx` 內若 `await` 到真正的非同步 I/O，另一個請求的語句會插進同一個 BEGIN 與 COMMIT 之間。這是推論。
- 原筆記說只 `await` 同步完成的方法時不會被插隊。這只對不同 macrotask 成立。
- 稽核實測（量測）：同一 tick 內兩個續行會交錯。第二個 `BEGIN` 被拒。實驗中 C 提交成功，D 被拒。
- 限制：稽核只實測同一 tick 內的兩個續行。正式環境多常出現這種情況，沒有量測。
- 結論：SQLite 版 `withTx` 必須加序列化佇列，讓交易一個接一個執行。這項工作已寫入步驟 1，見 6.2。
- 另外 `withTx` 的 callback 內禁止放 `fetch`、`fs` 非同步操作與計時器。目前 7 個交易符合。必須在 `withTx` 的文件與 code review 清單寫明。

實驗腳本在稽核者的 scratchpad，路徑見第 7 節。

### 5.5 測試中的交易回滾案例

`transitions.test.ts` 用 `CREATE TRIGGER ... RAISE(ABORT, ...)` 製造寫入失敗，驗證狀態與事件一起回滾（`:123,134`）。這 2 個測試依賴 SQLite 方言與同步 throw。步驟 1 要改成 `rejects.toThrow()`。步驟 4 要用 PostgreSQL 的 trigger 或約束違反重寫。

---

## 6. 架構 6.2 步驟 1、2 的工時估算

這是估算，不是量測。

### 6.1 假設

1. 一位熟悉本 repo 的工程師獨立作業。
2. 不含 code review 等待與產品討論。
3. 「人日」= 6 小時有效編碼。
4. 測試維持 vitest 加 in-memory SQLite。不在這兩步引入 PostgreSQL。注意 `src/app` 下沒有任何測試檔。「vitest 全數通過」無法發現 route 層的靜默錯誤。
5. 範圍只含現況呼叫點。M1 內新增的模組不計。
6. 手動冒煙：mock 模式下走過 24 個連鎖內 handler。冒煙測試必須檢查 response body，不能只看狀態碼（稽核後修正，見 4.5）。
7. 新增假設：SQLite 版 `withTx` 要有序列化佇列（5.4）。人日數是估算，沒有實測依據。
8. 新增假設：lint 加 response body 測試處理 24 處漏 `await`（4.5）。人日數是估算，沒有實測依據。

### 6.2 分項

| 工作項 | 量測依據 | 估算（人日） |
|---|---|---|
| 設計 repository 介面與 `withTx()`，含 SQLite 版交易語意與序列化佇列（5.4） | 5 個 runtime 交易 | 1.5 至 2 |
| 改寫 19 個 db 函式為 async 並接 `tx` | `db.ts` 376 行、26 個 `prepare` | 1 至 1.5 |
| 新增 4 個 repository 方法取代直接 SQL | 2.1 的 4 處 | 0.5 |
| 改寫 6 個測試檔 | 140 個點、58 個案例、24 個 SQL 方言點 | 1 至 1.5 |
| 步驟 1 小計 | | 4 至 5.5 |
| 17 個 route 檔補 `await` | 39 個點（36 個 route 檔內的 db 與直接 SQL 點，加 3 個 `applyDsEvent`） | 1 至 1.5 |
| `contract-files.ts` 與 `transitions.ts` 的 5 個函式變 async，含 3 個 callback 改寫 | 4.2 與 4.4 | 0.5 至 1 |
| 開 `no-floating-promises` 與 `no-misused-promises`，清可抓到的 15 處 | 4.5 甲、乙 | 0.5 至 1 |
| 冒煙測試 24 個 handler，檢查 response body，補 9 處 lint 抓不到的點 | 4.5 丙、4.6 | 0.5 至 1 |
| 步驟 2 小計 | | 2.5 至 4.5 |
| 合計 | | 6.5 至 10 |

54 個總點數不變：37 個 db 函式呼叫加 4 個直接 SQL，加 13 個連鎖函式呼叫點。其中 route 檔內共 39 點，見上表。

與原估算 6 至 8.5 的差異：

- `withTx` 一列從 1 至 1.5 改為 1.5 至 2。原因是加序列化佇列。這是新增假設。
- lint 一列從 0.5 改為 0.5 至 1，冒煙一列從 0.5 改為 0.5 至 1。原因是點數從 13 增為 24，且須驗 response body。這是新增假設。
- 這些加項沒有實測依據。總區間 6.5 至 10 是估算，不是量測。
- 排程用區間 6.5 至 10 人日。原筆記「8 人日加 0.5 緩衝」的寫法取消，因為 8 低於原上限 8.5。

### 6.3 對照架構 6.2 的 M1

- 步驟 1、2 在 M1 完成需要 6.5 至 10 人日。以每週 5 人日換算約 1.5 至 2 週。M1 其餘時間給步驟 3。
- 估算最不確定的項目是 `withTx` 設計（5.4）與測試改寫（SQL 方言點）。這兩項各可能再多 1 人日，極端情況合計到 12 人日。
- 風險 6.4「連鎖修改超出估算」：現況入口只有 18 個 `route.ts`，沒有 server component 與 server action 的連鎖，風險較低。這個判斷依據是估算。待步驟 1 實作後更新。

### 6.4 估算未涵蓋

- 步驟 4 的 PostgreSQL repository 與雙實作測試。
- 步驟 7 的搬資料。
- PGlite 或 testcontainers 的測試基礎建設。
- 連線池在 Next.js dev 熱重載的行為（需要另外讀 `node_modules/next/dist/docs/` 的 route handler 與 runtime 章節）。

---

## 7. 量測方法（可重跑）

基準：commit `2f39b875`，Next.js 16.2.11，TypeScript 取自 `node_modules/typescript`。

### 7.1 AST 量測

腳本全文在附錄。放在 scratchpad，不在 repo：

`/private/tmp/claude-501/-Users-miles-jian-Side-project-GitHub-rent-poc--claude-worktrees-adoring-easley-4d77af/1c9208a4-cdf0-449f-b735-3137576cb146/scratchpad/q13-callsites.cjs`

```bash
cd <repo root>   # 必須在 commit 2f39b875
git rev-parse --short HEAD
node q13-callsites.cjs q13-result.json
```

預期輸出：

```
exports 27 fn 23 touch 19
rows 221 prod 81 test 140
chain 36 entries 25 entriesNeed 24
awaitSites 230 prod 86 tx 7
```

`rows prod 81` 含 `db.ts` 內部 36 個 DB 呼叫。扣掉後 production 為 45。

### 7.2 grep 交叉檢查（用 bash，zsh 的 `--include` 會被 glob 擋）

```bash
N="listProperties|getProperty|listEquipmentVocabulary|addCustomEquipmentItem|ensureEquipmentVocabulary|listContracts|getContract|findContractByTaskId|appendContractEvent|listContractEvents|commitTransition|insertContractWithEvent|copyContractAsDraft|getContractRelations|deleteContractWithEvents|upsertContractFile|getContractFile|listContractFiles"
grep -rnE "\b($N)\(" src | grep -v "\.test\.ts" | grep -v "^src/lib/db.ts" | wc -l    # 37
grep -rn "getDb()" src | grep -v "\.test\.ts\|^src/lib/db.ts" | wc -l                    # 4
grep -rn "\.prepare(" src | grep -v "\.test\.ts\|^src/lib/db.ts" | wc -l                  # 4
grep -rn "\.prepare(" src --include="*.test.ts" | wc -l                                    # 19
grep -rn "\.exec(" src --include="*.test.ts" | wc -l                                       # 5
grep -rn "ensureSchema(" src --include="*.test.ts" | wc -l                                 # 15
grep -rn "setDb(" src --include="*.test.ts" | wc -l                                        # 10
grep -c "\.prepare(" src/lib/db.ts                                                         # 26
grep -c "\.transaction(" src/lib/db.ts                                                     # 7
grep -L "use client" $(git ls-files src/app | grep -E "(page|layout)\.tsx$")           # 只列出 design/page.tsx 與 layout.tsx
grep -rn "use server" src | wc -l                                                          # 0
```

### 7.3 誤差來源

1. 呼叫圖不追蹤「函式當值傳遞」與動態呼叫。現況沒有，靠人工核對。稽核用語法樹與 import 繫結獨立重算，計數全部相同。
2. 「必須補 `await`」的 54 個點是機器計數加人工歸類。`inAnonCallback` 欄位的判斷在測試檔會把每個 `it()` 內的呼叫都標成 callback，所以 4.4 只採計 production 的 3 個點。
3. AST 計「呼叫次數」，grep 計「行數」。測試檔差 91 對 84。
4. 原筆記 13 處語句位置漏 `await` 是人工歸類。稽核已用 `tsc` 與 type-aware ESLint 實驗，擴為 24 處，見 4.5。
5. 工時是估算，見第 6 節。
6. 沒有執行 vitest。這次只量測，不確認測試現況通過。

### 7.4 稽核者的實驗檔

實驗腳本與結果都在稽核者的 scratchpad，不在 repo：

- `/private/tmp/claude-501/-Users-miles-jian-Side-project-GitHub-rent-poc--claude-worktrees-adoring-easley-4d77af/1c9208a4-cdf0-449f-b735-3137576cb146/scratchpad/audit-q13.cjs`
- `/private/tmp/claude-501/-Users-miles-jian-Side-project-GitHub-rent-poc--claude-worktrees-adoring-easley-4d77af/1c9208a4-cdf0-449f-b735-3137576cb146/scratchpad/mkasync.cjs`
- `/private/tmp/claude-501/-Users-miles-jian-Side-project-GitHub-rent-poc--claude-worktrees-adoring-easley-4d77af/1c9208a4-cdf0-449f-b735-3137576cb146/scratchpad/microtask.cjs`
- `/private/tmp/claude-501/-Users-miles-jian-Side-project-GitHub-rent-poc--claude-worktrees-adoring-easley-4d77af/1c9208a4-cdf0-449f-b735-3137576cb146/scratchpad/tsc-stage2.txt`

---

## Inferences

- 連鎖範圍小，因為 6 個 `page.tsx` 是 client component，另有 2 個 server component（`layout.tsx`、`design/page.tsx`）都不碰 db。db 只被 route handler 碰到。這是從 `'use client'` 檢查與 import 檢查推得的。
- 5.4 的「不同 macrotask 時不會插隊」來自事件迴圈語意，是推論。同一 tick 內的交錯已由稽核實測。
- 4.5 的「回傳空物件」依 Promise 序列化行為推論，沒有啟動伺服器驗證。

## Gaps

- 沒有實測 `withTx` 加序列化佇列後在並行請求下的行為。稽核只實測同一 tick 內兩個續行，正式環境多常出現沒有量測。
- 沒有量測 PGlite 或 testcontainers 的測試時間。
- 沒有核對 `node_modules/next/dist/docs/` 中連線池與熱重載的章節。
- 工時沒有對照歷史速度資料。新增的兩項假設沒有實測依據。

---

## 附錄：量測腳本

```js
// 用法：cd <repo root> && node q13-callsites.cjs
// 以 TypeScript compiler API 解析符號，量測 db.ts 的呼叫點與同步->非同步連鎖範圍。
const path = require('path');
const { execSync } = require('child_process');
const ts = require(path.join(process.cwd(), 'node_modules/typescript'));
const root = process.cwd();
const files = execSync('git ls-files src', { cwd: root }).toString().split('\n')
  .filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => path.join(root, f));
const cfg = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const opts = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root).options;
const program = ts.createProgram(files, opts);
const checker = program.getTypeChecker();
const rel = (f) => path.relative(root, f);
const isTest = (f) => /\.test\.tsx?$/.test(f);
const dbFile = path.join(root, 'src/lib/db.ts');
const sources = files.map((f) => program.getSourceFile(f));
const line = (sf, n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;

function resolve(sym) {
  if (sym && sym.flags & ts.SymbolFlags.Alias) return checker.getAliasedSymbol(sym);
  return sym;
}
function declOf(sym) { return sym && sym.declarations && sym.declarations[0]; }

// 1. db.ts 匯出
const dbSf = program.getSourceFile(dbFile);
const dbExports = checker.getExportsOfModule(checker.getSymbolAtLocation(dbSf)).map((s) => {
  const d = declOf(s);
  const kind = ts.SyntaxKind[d.kind];
  const isFn = ts.isFunctionDeclaration(d);
  return { name: s.name, kind, isFn, line: line(dbSf, d), sym: s };
});
const dbFnSyms = new Map(dbExports.filter((e) => e.isFn).map((e) => [e.sym, e.name]));

// db.ts 內哪些匯出函式碰 DB（含 getDb / prepare / transaction / exec / pragma，或呼叫另一個碰 DB 的函式）
function bodyOf(d) { return d.body; }
const touchSet = new Set();
const touchesDirect = (d) => {
  let hit = false;
  (function w(n) {
    if (hit) return;
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isIdentifier(e) && e.text === 'getDb') hit = true;
      if (ts.isPropertyAccessExpression(e) && ['prepare', 'transaction', 'exec', 'pragma'].includes(e.name.text)) hit = true;
    }
    ts.forEachChild(n, w);
  })(d.body);
  return hit;
};
const dbFnDecls = new Map();
for (const e of dbExports.filter((x) => x.isFn)) dbFnDecls.set(e.name, declOf(e.sym));
let changed = true;
for (const [n, d] of dbFnDecls) if (touchesDirect(d)) touchSet.add(n);
while (changed) {
  changed = false;
  for (const [n, d] of dbFnDecls) {
    if (touchSet.has(n)) continue;
    let hit = false;
    (function w(x) {
      if (hit) return;
      if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && touchSet.has(x.expression.text)) hit = true;
      ts.forEachChild(x, w);
    })(d.body);
    if (hit) { touchSet.add(n); changed = true; }
  }
}

// 2. 呼叫點
const rows = []; // {file, line, kind, name, enclosing}
const dbReceiverCalls = ['prepare', 'transaction', 'exec', 'pragma'];
function enclosingFn(n) {
  let p = n.parent;
  while (p) {
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) return p;
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p))) {
      if (ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p;
    }
    p = p.parent;
  }
  return null;
}
function fnName(f) {
  if (!f) return '(top-level)';
  if (f.name && ts.isIdentifier(f.name)) return f.name.text;
  if (ts.isVariableDeclaration(f.parent)) return f.parent.name.getText();
  return '(anon)';
}
const edges = []; // caller decl -> callee decl
const importRefs = []; // 非呼叫的引用（函式當值傳遞、型別、常數）
for (const sf of sources) {
  const f = sf.fileName;
  (function w(n) {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e);
      sym = resolve(sym);
      const d = declOf(sym);
      if (d && d.getSourceFile() === dbSf && dbFnSyms.has(sym) && f !== dbFile) {
        rows.push({ file: rel(f), line: line(sf, n), kind: 'db.ts 函式', name: dbFnSyms.get(sym), encl: fnName(enclosingFn(n)), test: isTest(f), touch: touchSet.has(dbFnSyms.get(sym)) });
      }
      // better-sqlite3 接收者
      if (ts.isPropertyAccessExpression(e) && dbReceiverCalls.includes(e.name.text)) {
        const t = checker.getTypeAtLocation(e.expression);
        const tn = checker.typeToString(t);
        if (/Database/.test(tn)) {
          rows.push({ file: rel(f), line: line(sf, n), kind: 'db.' + e.name.text, name: e.name.text, encl: fnName(enclosingFn(n)), test: isTest(f), inDb: f === dbFile });
        }
      }
      if (ts.isIdentifier(e) && e.text === 'getDb' && f !== dbFile) { /* 已在上面計入 */ }
      // 呼叫圖
      const callerFn = enclosingFn(n);
      if (d && callerFn && (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) || ts.isArrowFunction(d.initializer || d) || (ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))))) {
        edges.push({ caller: callerFn, callee: ts.isVariableDeclaration(d) ? d.initializer : d, site: { file: rel(f), line: line(sf, n) } });
      }
    }
    // 非呼叫引用 db.ts 匯出
    if (ts.isIdentifier(n) && f !== dbFile && !ts.isImportSpecifier(n.parent)) {
      const s = resolve(checker.getSymbolAtLocation(n));
      const d = declOf(s);
      if (d && d.getSourceFile() === dbSf && !(ts.isCallExpression(n.parent) && n.parent.expression === n)) {
        importRefs.push({ file: rel(f), line: line(sf, n), name: n.text, test: isTest(f) });
      }
    }
    ts.forEachChild(n, w);
  })(sf);
}
// db.ts 內部的 prepare/transaction 計數
const dbInternal = [];
(function w(n) {
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && dbReceiverCalls.includes(n.expression.name.text)) {
    dbInternal.push({ line: line(dbSf, n), kind: n.expression.name.text, encl: fnName(enclosingFn(n)) });
  }
  ts.forEachChild(n, w);
})(dbSf);

// 3. 連鎖：從碰 DB 的 db.ts 函式往外推
const key = (d) => d.getSourceFile().fileName + ':' + d.pos;
const meta = new Map();
for (const sf of sources) {
  (function w(n) {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent))) {
      meta.set(key(n), { node: n, file: rel(sf.fileName), line: line(sf, n), name: fnName(n), async: !!(ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Async) || (n.modifiers || []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword), test: isTest(sf.fileName) });
    }
    ts.forEachChild(n, w);
  })(sf);
}
const rev = new Map();
for (const e of edges) {
  if (!meta.has(key(e.callee)) || !meta.has(key(e.caller))) continue;
  const k = key(e.callee);
  if (!rev.has(k)) rev.set(k, []);
  rev.get(k).push(e);
}
const seeds = [...dbFnDecls].filter(([n]) => touchSet.has(n)).map(([, d]) => key(d));
// 注意：不從 getDb 內部起算；seed 是匯出函式本身
const need = new Map(); // key -> {via}
const q = [...seeds];
seeds.forEach((s) => need.set(s, { via: 'seed' }));
while (q.length) {
  const k = q.shift();
  for (const e of rev.get(k) || []) {
    const ck = key(e.caller);
    if (!need.has(ck)) { need.set(ck, { via: meta.get(k).name }); q.push(ck); }
  }
}
// 以 test 與 production 分開
const chain = [...need.keys()].map((k) => ({ ...meta.get(k), via: need.get(k).via })).filter((m) => m.file !== 'src/lib/db.ts');

// 入口
const entries = [];
for (const sf of sources) {
  const f = rel(sf.fileName);
  if (/route\.ts$/.test(f)) {
    for (const [n, m] of meta) {
      if (m.file === f && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(m.name)) {
        entries.push({ type: 'route handler', ...m, needs: need.has(n) });
      }
    }
  }
}
// 呼叫端取自 transitions
const out = {
  head: execSync('git rev-parse --short HEAD').toString().trim(),
  dbExports: dbExports.map((e) => ({ name: e.name, kind: e.kind, line: e.line, touchesDb: touchSet.has(e.name) })),
  dbInternal,
  rows,
  importRefs,
  chain: chain.map(({ node, ...r }) => r),
  entries: entries.map(({ node, ...r }) => r),
};
require('fs').writeFileSync(process.argv[2] || 'q13-result.json', JSON.stringify(out, null, 1));
console.log('exports', dbExports.length, 'fn', dbFnSyms.size, 'touch', touchSet.size);
console.log('rows', rows.length, 'prod', rows.filter((r) => !r.test).length, 'test', rows.filter((r) => r.test).length);
console.log('chain', chain.length, 'entries', entries.length, 'entriesNeed', entries.filter((e) => e.needs).length);

// 4. 需加 await 的呼叫點：呼叫 need 集合內函式（含 db.ts 函式）
const needKeys = new Set(need.keys());
function nearestFnLike(n) {
  let p = n.parent;
  while (p) { if (ts.isFunctionLike(p)) return p; p = p.parent; }
  return null;
}
const awaitSites = [];
for (const sf of sources) {
  (function w(n) {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const sym = resolve(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e));
      let d = declOf(sym);
      if (d && ts.isVariableDeclaration(d) && d.initializer) d = d.initializer;
      if (d && (ts.isFunctionDeclaration(d) || ts.isArrowFunction(d) || ts.isFunctionExpression(d)) && needKeys.has(key(d))) {
        const callee = meta.get(key(d));
        const fl = nearestFnLike(n);
        const anon = fl && !(meta.has(key(fl)));
        awaitSites.push({ file: rel(sf.fileName), line: line(sf, n), callee: callee.name, calleeFile: callee.file, test: isTest(sf.fileName), awaited: n.parent.kind === ts.SyntaxKind.AwaitExpression, inAnonCallback: !!anon, encl: fnName(enclosingFn(n)) });
      }
    }
    ts.forEachChild(n, w);
  })(sf);
}
// 5. 交易內呼叫
const txs = [];
for (const sf of sources) {
  (function w(n) {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'transaction' && /Database/.test(checker.typeToString(checker.getTypeAtLocation(n.expression.expression)))) {
      const cb = n.arguments[0];
      const inner = [];
      (function v(x) {
        if (ts.isCallExpression(x)) inner.push(x.expression.getText().replace(/\s+/g, ' ').slice(0, 60) + '@' + line(sf, x));
        ts.forEachChild(x, v);
      })(cb);
      txs.push({ file: rel(sf.fileName), line: line(sf, n), encl: fnName(enclosingFn(n)), inner });
    }
    ts.forEachChild(n, w);
  })(sf);
}
out.awaitSites = awaitSites;
out.txs = txs;
require('fs').writeFileSync(process.argv[2] || 'q13-result.json', JSON.stringify(out, null, 1));
console.log('awaitSites', awaitSites.length, 'prod', awaitSites.filter((x) => !x.test).length, 'tx', txs.length);
```

## 稽核修正紀錄

依 [稽核報告](../audit/audit-phase1-map-research.md) 第三節。11 條發現全部套用，計數部分經稽核獨立重算，無需更動。

| 發現 | 處理方式 |
|---|---|
| 1 | 4.5 改寫為 24 處清單，分甲（`no-floating-promises`）13 處、乙（`no-misused-promises`）2 處、丙（兩者都抓不到）9 處。「回傳空物件」標為推論，未啟動伺服器驗證 |
| 2 | 建議補 `no-misused-promises`，並要求 route 層測試驗 response body。6.2 對應列改寫 |
| 3 | 5.4 改寫：不插隊只限不同 macrotask，同一 tick 會交錯。SQLite 版 `withTx` 加序列化佇列，寫入步驟 1。限制：正式環境頻率未量測 |
| 4 | 5.2 改為交易內無外部呼叫，是否走 outbox 依架構 6.4 另議 |
| 5 | Inferences 與結論改為 2 個 server component，都不碰 db |
| 6 | 6.2 改為 39 點，54 點總數不變 |
| 7 | 5.3 補 `db.ts:199` |
| 8 | 6.2 改為明確區間 6.5 至 10 人日，取消 0.5 人日緩衝的寫法 |
| 9 | 6.3 風險句改為現況入口少、風險較低，待步驟 1 實作後更新 |
| 10 | 測試案例改 58，註明 `transitions.test.ts` 含 `it.each` 展開 4 列 |
| 11 | 6.1 假設 4 與 6 補充：`src/app` 無測試檔，冒煙須檢查 response body |

工時區間變動：原 6 至 8.5 人日，現 6.5 至 10 人日。上調來自兩項新增假設（`withTx` 序列化佇列，以及 24 處漏 `await` 的處理）。新增部分的人日數是估算，沒有實測依據。

信心標示：本筆記以「量測」與「推論」區分。發現 3、4 的相關段落已逐句標明量測或推論。
