# Phase 1 主控對話交接：共用部分

寫於 2026-11-08。給 A 到 F 六條線的主控對話讀。各線另有一份 `line-<x>.md`。這份只寫規則與現況，細節一律指向既有文件、ADR 與 Linear 票，不重抄。

## 1. 專案與目標

rent-poc 是台灣租賃電子簽約系統，正演進為不動產資產管理平台。Phase 1 是「物件管理與租賃」，24 條 P0 在 `docs/research/asset-mgmt-platform/prd.md` 第 5.2 節。三階段路線在 `brd.md` 第 9 節。架構在 `architecture.md`，第 8 節的 ADR 編號是候選編號，正式編號以 `docs/adr/` 為準。術語以 `GLOSSARY.md` 為準，用定義欄的詞，避開 `_Avoid_` 欄。

使用者的定案，順序依重要性：

1. 進度與「完成」只算系統開發。pilot、函詢、訪談、法務是現實世界的事，不列為阻擋。
2. 目前沒有法務。法律假設依 PRD 保守版本做，標示「待法務確認」，集中在 Linear 的 MIL-62。
3. 金流與商工登記 API 的對外申請在 demo 階段跳過。Phase 1 平台不經手錢，只記鏡像帳。
4. 規劃文件（PRD、架構、BRD）與 ADR 不一致時，以 ADR 為準。文件的待改項目集中在 MIL-61，不要直接改 `docs/research/`。

## 2. 與使用者互動的規則

- 使用者只在主控對話互動，不進子對話。子對話遇到決策，用 SendMessage 送回主控對話並結束回合。
- 使用者說過「後續全部照建議」。子對話附建議的問題，主控直接照建議回覆，回報時列出採用的決定讓使用者能否決。付費方案、刪資料、對外發佈這三類先問使用者。
- 回報進度用 PRD 的模組與功能角度，例如「物件模組：能建立物件並偵測重複登錄」。不要只列票號、分支、ADR 編號。
- 全部文字台灣繁體中文，遵守 `AGENTS.md`。需求文字的義務詞固定：必須、不得、得、建議。
- Linear 用 `mcp__linear-rent-poc__*` 或 `mcp__linear-rentpoc__*`，team Miles-rent-poc，規範見 `docs/agents/issue-tracker.md`。發佈到 Linear 前有 STE lint hook：每句 40 字內、不用分號、不用非台灣用詞（例如把程式碼寫成另一種說法）、不用 GLOSSARY 的 `_Avoid_` 詞。被擋就改寫，不要繞過。

## 3. 流程：Matt Pocock 的 skill

- 寫規格：grilling 加 domain-modeling 加 codebase-design，再照 to-spec 模板發 spec，再照 to-tickets 拆 tracer-bullet tickets。`grill-with-docs`、`to-spec`、`to-tickets`、`implement`、`wayfinder` 設了 disable-model-invocation，Skill tool 不接受時直接 Read 它們的 SKILL.md 照做，路徑在 `/Users/miles_jian/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.3.1/skills/`。
- 實作：每張票一個子對話，Opus，自己的 worktree。流程是 implement：tdd、code-review、冒煙測試、Linear 留言與結案。完成條件固定：`npx vitest run` 全過、`npx tsc --noEmit` 通過、`npx eslint src --max-warnings=10` 不新增問題（MIL-34 的 5 個既有警告不算）。
- 動到前端畫面的票，必須先用 Skill tool 載入 `impeccable`，`DESIGN.md` 是 token 單一來源（ADR-0009）。
- 點點簽 API 規格一律用 `dottedsign-api` MCP 查，不憑記憶。
- 子對話的 brief 一律寫明：使用者不會進來、問題送回主控對話的 session id、附建議答案。

## 4. 分支與合併

- 每條線一條整合分支 `integration/line-<x>`，由主控在自己的 worktree 建立並管理。子對話從整合分支開 worktree，做完後主控驗證再併進整合分支。
- 驗證方式：在暫存 worktree 合併後跑 tsc、vitest、eslint，全過且無衝突才併。文件類分支（ADR、GLOSSARY、筆記）驗過只動文件就直接併。
- 併進 main 走 PR：主控把整合分支或文件分支 push 到 origin，開 PR 到 main，CI（`.github/workflows/ci-deploy.yml`）綠就自己 merge。使用者已同意「測試過的程式碼直接併」。每次 merge 到 main 會自動部署 demo。
- A 線例外：整合分支 `integration/line-a` 做到 MIL-91 都不併 main，由 MIL-92 在資料庫切換當天併，見 `line-a.md`。
- 其他線的整合分支要定期併入 main 的變更。B、C、E 的實作要等 A 線的指定票併進 `integration/line-a` 後，從那條分支開工。
- commit 訊息繁體中文，結尾加 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`（子對話的模型不同時用其實際模型名）。
- ADR 編號每條線用固定區段，避免撞號。A 線 0070 起（0019、0020 已用）。B 線 0030 起。C 線 0040 起（0022、0023 已用，保留）。D 線 0080 起（0021 已用）。E 線 0050 起（原 0022、0023 已改為 0050、0051）。F 線 0060 起（0024 已用，保留）。

## 5. 現況，2026-11-08

- main 最新含：ADR-0010 到 0021、新版 GLOSSARY、Phase 1 研究筆記、簽署模組 MIL-53、MIL-55、MIL-56 的程式碼、Cloud Run 部署設定。vitest 456 個。
- demo 已部署：Cloud Run asia-east1，網址在 `docs/deployment.md` 與 `.env.deploy`（不進版控）。Basic Auth 保護，點點簽 demo Application 已設定。資料庫仍是 SQLite 加 Litestream（ADR-0011）。
- Phase 1 決策地圖 MIL-35 已結案，決議摘要在它的 Decisions so far。
- 簽署模組（spec MIL-52，票 MIL-53 到 MIL-60）由 D 線主控接管，2026-11-08 起。這四張票直接開 PR 併 main，不走 D 線整合分支。MIL-60 結案後 D 線主控在票上留言並通知 A 線主控。原主控對話已封存。
- 已有 spec 與 tickets 的線：A（MIL-78，票 MIL-79 到 MIL-93）、D（MIL-64，票 MIL-65 到 MIL-77）。B、C、E、F 還沒有 spec。
- 使用者的待辦在 `docs/research/asset-mgmt-platform/TASKS.md`。
- 既有票：MIL-34 eslint 既有錯誤、MIL-61 規劃文件對齊、MIL-62 法務清單。MIL-48 與 MIL-49 是上線閘門。MIL-54 sandbox 實測併入 MIL-57。

## 6. 線之間的依賴

| 線 | P0 | spec | 實作開工條件 |
|---|---|---|---|
| A 資料層與組織隔離 | 02、23、24 | MIL-78 | MIL-60 完成 |
| B 產權錨點與出租權源 | 06、07、08 | 待寫 | A 線 MIL-81 併進 `integration/line-a` |
| C 三種身分與經理人驗證 | 01、03、04、05、09 加介面換字 | 待寫 | A 線 MIL-82 併進 `integration/line-a` |
| D 簽章分流與委託管理合約 | 10、11、12 | MIL-64 | MIL-60 完成，用現有 SQLite 先做 |
| E 鏡像帳、押金、提醒、報表、承租人端 | 13 到 19、21 | 待寫 | A 線 MIL-83 併進 `integration/line-a` |
| F 資產總覽與移交包 | 20、22 | 待寫 | 畫面可先做，資料接線等 E 線 |

## 7. 建議載入的 skill

- `mattpocock-skills:grilling`、`domain-modeling`、`codebase-design`：寫規格時。
- `mattpocock-skills:tdd`、`code-review`：子對話實作時。
- `impeccable`：任何前端畫面。
- `mattpocock-skills:research`：需要查外部事實時派 Sonnet 子代理。
- `mattpocock-skills:wizard`：需要使用者親自操作雲端或第三方後台時。
