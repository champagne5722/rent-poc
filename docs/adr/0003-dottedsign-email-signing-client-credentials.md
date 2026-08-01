# 點點簽整合：Client Credentials ＋ email 簽署，不做 embedded signing

認證採 **OAuth2 Client Credentials flow**（伺服器對伺服器，最單純）。簽署體驗採點點簽預設的 **email 通知＋點點簽頁面簽署**：租客與房東各自收信、點連結到點點簽完成簽名；狀態由 webhook 回報。**不做 Embedded Signing**——它需要商業／企業方案帳戶開 `embedded_signing` scope（sandbox 帳號未確認具備），且對「驗證流程可行」這個 PoC 目標沒有增量；列為日後加分項。

## Consequences

- 簽署當下使用者會離開本系統，demo 時需說明這是 PoC 取捨而非產品終態。
- 若日後補 embedded signing，token 交換已在伺服器端，前端只需加 SDK 容器。
