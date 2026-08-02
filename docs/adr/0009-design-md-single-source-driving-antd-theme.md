# 設計語言以 DESIGN.md 為單一來源，runtime 直讀驅動 antd theme

後台的設計語言收斂在 repo 根目錄一份 `DESIGN.md`（Google design.md 規格：YAML front matter 放 token、markdown 本文放設計慣例），它是唯一 source of truth。目的以「管 agent」為主：prose 給 coding agent 當設計 context，讓每次產出的頁面遵循同一套視覺語言；讓 antd 換上目標外觀是附帶效果。可行性評估見 [docs/research/design-md-antd-token-feasibility.md](../research/design-md-antd-token-feasibility.md)。

決議內容：

- **antd 元件優先**：非不得已不自訂元件。因此視覺控制幾乎全走 antd token 派生，`DESIGN.md` 的 components 與 prose 章節寫的是 antd 使用慣例（留白原則、元件選用時機、Do's and Don'ts），不描述自訂元件。
- **Seed-only 映射**：front matter 只映射到 antd 全域 token（色彩、字體、`borderRadius`，並由 `spacing.md` 推算 `sizeUnit`/`sizeStep`）。不預建 `theme.components` override 表，等實測出視覺落差再逐條加。spacing 具名 scale 不進 theme，由 agent 寫版面時引用。註：映射目標除 Seed Token 外含少數 Map/Alias Token（文字階、背景、邊線、浮層），刻意直接覆寫以取 DESIGN.md 的精確色，其餘仍交 algorithm 派生。
- **runtime 直讀**：`layout.tsx`（server component）直接讀 `DESIGN.md`、parse front matter 組 theme object 傳給 `ConfigProvider`。放棄 codegen（要記得重跑 script）與人肉同步（必然漂移），兩者都會讓 source of truth 名存實亡。parse 失敗 fallback 回 antd 預設 theme 並記 error，不擋啟動。
- **深淺色由檔案決定**：parser 依 `colors.canvas` 亮度自動決定是否掛 `darkAlgorithm`，程式不寫死深淺色。

## Consequences

- 新增 `DESIGN.md`（以 getdesign.md 的 Linear 檔為起點改寫，砍行銷元件章節）與一支 front matter → theme object 的 parser；`ConfigProvider` 從此吃 parser 產出。
- 改視覺只編輯 `DESIGN.md`，不改程式；深色觀感不合時調 token 即可。
- coding agent 產 UI 前應讀 `DESIGN.md` 本文章節；這是它與 token 層互補的另一半價值。
- `letterSpacing`、多級字階、精細 spacing 超出 antd Seed Token 體系，本決議接受此限制；未來若要求該精緻度，需重評（`theme.components` 表或全域 CSS）。
- parser 只在 server 端跑一次，YAML parse 成本忽略不計；換用 codegen 屬新決議。
