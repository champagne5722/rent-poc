# Domain 文件

工程類 skill 在探索程式碼時，應如何使用此 repo 的領域文件。

## 探索前先讀這些

- repo 根目錄的 **`CONTEXT.md`**，或
- repo 根目錄的 **`CONTEXT-MAP.md`**（若存在）——它會指向每個 context 各自的 `CONTEXT.md`，讀取與主題相關的那幾份。
- **`docs/adr/`**——閱讀與即將處理的範圍相關的 ADR。多 context 的 repo 還要檢查 `src/<context>/docs/adr/` 裡限定該 context 的決策。

若這些檔案不存在，**安靜地繼續**。不要特別指出它們缺席，也不要建議先建立它們。`/domain-modeling` skill（經由 `/grill-with-docs` 與 `/improve-codebase-architecture` 觸發）會在術語或決策真正確定時才惰性建立。

## 檔案結構

單一 context 的 repo（絕大多數）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多 context 的 repo（根目錄存在 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 全系統層級的決策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 限定該 context 的決策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用詞彙表的用語

當輸出中出現領域概念（issue 標題、重構提案、假設、測試名稱），使用 `CONTEXT.md` 中定義的術語，不要漂移到詞彙表明確避免的同義詞。

若需要的概念還不在詞彙表中，那是一個訊號——要嘛您在發明專案沒有使用的語言（請重新考慮），要嘛存在真正的缺口（記下來交給 `/domain-modeling`）。

## 標記 ADR 衝突

若輸出與既有 ADR 矛盾，明確指出而非默默推翻：

> _與 ADR-0007（event-sourced orders）矛盾——但值得重新討論，因為……_
