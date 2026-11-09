<!-- ste-lint: off -->
<!-- 給 agent 讀的模組說明，句長規則不適用 -->
# 簽署中失效（MIL-75）

依據：ADR-0018 決議 11 情況 B，ADR-0021 決議 6、7。執業人員的簽署事件到達時，用事件時間判定可簽章，結果已由 MIL-70 寫進 `signature_records.snapshot_at_sign.result`。這個模組處理「判定為不可簽章」之後的事。

## 行為

| 情況 | 簽署進度 | 合約 | 失效紀錄狀態 | 歷程 |
|---|---|---|---|---|
| 任務未結束 | 照常推進 | 交易提交後自動撤回，成功後變已撤回 | `void_pending` → `voided` | `credential_lapsed`、`voided`（行為者系統） |
| 任務未結束，自動撤回失敗 | 照常推進 | 維持簽署中，詳情頁顯示警示與撤回按鈕 | `void_failed` | `credential_lapsed`、`auto_void_failed` |
| 任務已全員完成 | 照常推進 | 維持已完成，詳情頁顯示警示 | `completed_lapsed` | `completed`、`credential_lapsed` |
| 自動撤回失敗後才收到完成事件 | 照常推進 | 維持已完成 | `void_failed` → `completed_lapsed` | 再寫一筆 `credential_lapsed` |
| 失敗後使用者手動撤回 | 照常推進 | 已撤回 | `void_failed` → `voided` | `voided`（行為者出租方） |
| 其他原因結束（拒簽） | 照常推進 | 已拒簽 | → `task_ended` | 無 |

查不到登錄資料的快照（`unavailable`）無法判定，不當作失效。

## 流程

1. 簽署模組的 `prepareOutcome`（MIL-70）在交易前用事件時間重新判定，結果進快照。
2. `onOutcome` 在交易內補快照後，讀這次新補的快照。結果不可簽章就呼叫 `recordLapse` 寫失效紀錄與歷程。沿用快照的判定，不重查登錄。
3. 任務結束的事件（完成、撤回、拒簽）在同一個交易內結清先前沒處理完的紀錄。
4. 交易提交後，簽署模組呼叫選填的 `afterOutcome`。合約訂閱者在這裡自動撤回，外部 API 不在交易內。撤回走 `tools.voidTask()`，與手動撤回同一條路徑。
5. 撤回失敗只記 log 與狀態，不往外拋，webhook 仍回 2xx。

## 重複事件

簽署模組的 email 守門（ADR-0010 決議 9）拒絕重複的 `signed`，所以 `onOutcome` 不會再被呼叫。資料層另有兩道保險：`snapshot_at_sign` 只能補一次，`UNIQUE (contract_id, rule_id)` 讓同一席位只有一列。

## 簽署模組介面的改動

`SigningSubscriber` 新增一個選填方法，既有訂閱者與測試不受影響：

```ts
afterOutcome?(subject: SigningSubject, outcome: ProgressOutcome, tools: { voidTask(): Promise<void> }): Promise<void>;
```

A 線 MIL-85 同步時：模組在每個被接受的事件提交後呼叫它（全員完成時在 `afterCompleted` 之後），例外只記 log。`voidTask` 與 `module.voidTask` 是同一個函式。

## 檔案

| 檔案 | 內容 |
|---|---|
| `tables.ts` | `signing_lapses` 表，`ensureSigningLapseTables` |
| `types.ts` | `SigningLapseState`、`SigningLapseDetail` |
| `repository.ts` | 同步（交易內）：`recordLapse`、`hasVoidPendingLapse`、`markVoidFailed`、`settleOpenLapses`。非同步：`listSigningLapses` |
| `view.ts` | `lapseAlerts`：詳情頁警示，純函式 |
| `lapse.integration.test.ts` | 走簽署模組介面，配 Mock adapter |

## A 線遷移 PostgreSQL 時

- `signing_lapses` 的欄位與 UNIQUE 約束不變。`signer_id` 參照 `signers.id`，與 `signature_records` 一起搬。
- 四個同步函式改成吃 `tx`。
- `recordLapse` 的 `INSERT OR IGNORE ... SELECT` 改成 `INSERT ... ON CONFLICT DO NOTHING`。
- `reasons` 存 JSON 文字，可換成 jsonb。

## 過渡做法（上線前必須替換）

ADR-0021 決議 6：A 線稽核紀錄完成前，失效事實寫合約歷程並在詳情頁警示。合約歷程沒有防竄改保護，上線前必須改寫稽核事件並通知平台營運者與執業主體（P0-23）。
