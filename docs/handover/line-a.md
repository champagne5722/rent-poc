<!-- ste-lint: off -->
<!-- 交接文件給 agent 讀，內容是指向既有文件的清單，句長規則不適用 -->
# A 線交接：資料層遷移 PostgreSQL、組織隔離、稽核紀錄、告知與同意

先讀 `README.md`。這條線是其他五條線的地基。

## 範圍與依據

- P0-02 組織與資料隔離、P0-23 稽核紀錄、P0-24 告知與同意紀錄。
- spec：Linear MIL-78。tickets：MIL-79 到 MIL-93，原生 blocked-by 已接好。MIL-79 blocked-by MIL-60。
- ADR：0012（PostgreSQL 加 RLS 組織隔離、五區 schema、`withTx`、`jsonOk`、ULID）、0013（產權錨點，A 線只建骨架）、0019（稽核鏈與每日錨定）、0020（worker 用 Cloud Scheduler 觸發內部 route）、0011（目前的 demo 部署）。
- 研究：`docs/research/asset-mgmt-platform/research_notes/` 的 Q13 呼叫點數量、Q21 外部錨定；`docs/research/hosting-evaluation.md`。

## 使用者 2026-11-08 的新決定：demo 直接用 Cloud SQL，不用 Neon

ADR-0012 與 MIL-92 寫 demo 用 Neon。使用者決定 demo 一開始就用 Google 的 Cloud SQL asia-east1，理由是少一家供應商、資料在台灣、之後不必再從 Neon 搬到 Cloud SQL。要做的事：

1. 第一張票開工前，在 ADR-0012 的 Consequences 加一段修訂，寫明 demo 改用 Cloud SQL 最小規格，並查價：`hosting-evaluation.md` 只估了 pilot 規格每月 US$44.86，最小的 shared core 規格要另外查，附來源與日期。GCP 新帳號有 90 天 US$300 試用額度。
2. MIL-92 改名為「demo 切到 Cloud SQL」，票內步驟改成建 Cloud SQL 執行個體、Cloud Run 用 Cloud SQL 連線器或 Unix socket 連線、secret 放連線字串。仍標 `ready-for-human`。
3. 測試仍照 ADR-0012：本機與 vitest 用 PGlite，CI 用真實 PostgreSQL 容器。

## 整合分支規則

- 分支名 `integration/line-a`，由 MIL-79 建立，從 main 分出。
- MIL-79 到 MIL-91 都併進這條分支，不併 main。原因在 MIL-78：ID 改 ULID 與同步改非同步無法分批保持 main 綠燈。
- 每張票開工前先把 main 併進 `integration/line-a`。
- MIL-91 完成後不併 main，等 MIL-92 由使用者切換資料庫當天合併並部署。
- B、C、E 三條線的實作分別等 MIL-81、MIL-82、MIL-83 併進這條分支，到時通知它們的主控對話（在各線的 Linear spec 留言即可）。

## 第一步

1. 等簽署模組 MIL-60 結案的通知，或自己查 Linear 的 MIL-60 狀態。
2. 開工前重跑呼叫點量測，把工時估算寫回 MIL-78，這是 MIL-79 的一部分。
3. 開 MIL-79 的實作子對話。

## 注意

- `clone()` 之後 `current_user` 會回到 superuser，每次都要重新 `SET ROLE app_rw`，否則 RLS 測試假通過。已寫在 ADR-0012 的 Action Items。
- 建立簽署任務不自動重試，點點簽 API 沒有冪等鍵。
- demo 期間失敗重試排程每 60 分鐘，pilot 每 5 分鐘。
- FreeTSA 的呼叫與併發寫入沒有實測，由 MIL-88、MIL-89 驗證。
