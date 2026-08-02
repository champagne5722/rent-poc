# 評估：antd 後台介面能否用 design.md / design token 控制

研究日期：2026-08-02。全部依 primary sources（官方文件、GitHub repo、原始檔案）查證，每個 claim 附來源 URL。

## 1. getdesign.md 產出的 design.md 格式與用途

### 1.1 這是什麼服務

- getdesign.md 是 VoltAgent 團隊維護的 DESIGN.md 集合網站，自稱「The #1 DESIGN.md collection in the ecosystem」，收錄 300+ 個知名網站的 design system 分析（Apple、Figma、Stripe、Linear 等）。用途說明是給 AI coding agent 一份可重複使用的設計參考，讓新頁面「遵循特定的視覺語言，而不是相同的通用 AI 版面配置」。來源：<https://getdesign.md>、<https://getdesign.md/what-is-design-md>
- 檔案取得方式有兩種：網站上的 `npx getdesign@latest add linear.app` 指令，或直接從開源 repo 複製。來源：<https://getdesign.md/linear.app/design-md>
- 開源 repo 是 `VoltAgent/awesome-design-md`（MIT license），實際檔案放在 `design-md/<site>/DESIGN.md`，含 `design-md/linear.app/DESIGN.md`。來源：<https://github.com/VoltAgent/awesome-design-md>

### 1.2 格式有官方規格，來自 Google

DESIGN.md 有正式的格式規格 repo：`google-labs-code/design.md`（Apache-2.0，版本 alpha，規格與 CLI 仍在演進）。規格文件另掛在 Google Stitch：`stitch.withgoogle.com/docs/design-md/specification`。來源：<https://github.com/google-labs-code/design.md>

規格重點：

- 兩層結構：YAML front matter 放機器可讀的 token，markdown 本文放給 agent 讀的設計理由。README 原句：「Tokens give agents exact values. Prose tells them why those values exist and how to apply them.」
- Token 類別：`colors`（CSS 色值，hex / rgb() / oklch()）、`typography`（fontFamily、fontSize、fontWeight、lineHeight、letterSpacing）、`rounded`、`spacing`、`components`（用 `{colors.primary}` 這種 bracket notation 引用其他 token）。
- 章節有固定順序：Overview、Colors、Typography、Layout、Elevation & Depth、Shapes、Components、Do's and Don'ts。
- 附 CLI：`lint`（結構與 WCAG 對比檢查）、`diff`（token 回歸比對）、`export`（可輸出成 Tailwind v3/v4 JSON 與 **W3C DTCG 格式**）。

來源：<https://github.com/google-labs-code/design.md>

### 1.3 實際檔案結構（以 Linear 為例）

直接讀 raw 檔驗證（548 行）：<https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/linear.app/DESIGN.md>

YAML front matter 節錄：

```yaml
---
version: alpha
name: Linear-design-analysis
colors:
  primary: "#5e6ad2"
  primary-hover: "#828fff"
  ink: "#f7f8f8"
  canvas: "#010102"
  surface-1: "#0f1011"
  hairline: "#23252a"
  semantic-success: "#27a644"
typography:
  body:
    fontFamily: Linear Text
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.50
rounded:
  md: 8px
spacing:
  md: 16px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    padding: 8px 14px
---
```

Markdown 本文章節（實際 grep 標題）：Overview、Colors、Typography、Layout（Spacing System / Grid & Container）、Elevation & Depth、Shapes、Components（Buttons / Cards / Inputs / Navigation / Footer）、Do's and Don'ts、Responsive Behavior、Iteration Guide、Known Gaps。全部是 prose 加少量表格，不是 CSS variables。

一個重要限制：這些檔案分析的是各品牌的**行銷網站**視覺語言（Linear 檔案自述是 "product-focused marketing canvas"），component token 也是 pricing-card、cta-banner、testimonial-card 這類 landing page 元件，不是後台 UI 元件。來源：同上 raw 檔。

## 2. antd v5 Design Token 系統

主要來源：<https://ant.design/docs/react/customize-theme>（`https://ant.design/docs/react/theme` 已 404，token 設計說明現在併在 customize-theme 頁）。

### 2.1 三層 token

透過 `ConfigProvider` 的 `theme` prop 注入：

```tsx
<ConfigProvider theme={{ token: {...}, algorithm: [...], components: {...} }}>
```

- **Seed Token**：設計意圖的源頭，改一個會自動衍生一串。例：`colorPrimary`、`borderRadius`、`fontSize`、`fontFamily`。
- **Map Token**：由 Seed 經 algorithm 衍生的梯度變數。例：`colorPrimaryBg`、`borderRadiusLG`。
- **Alias Token**：批量控制常見元件樣式的別名。例：`colorLink`、`colorTextHeading`。

三層都寫在同一個 `theme.token` object 裡，直接指定值即可覆寫。來源：<https://ant.design/docs/react/customize-theme>

### 2.2 元件級 token 與 algorithm

- `theme.components` 可對單一元件覆寫 token，互不影響：`components: { Button: { colorPrimary: '#ff0000' }, Input: { borderRadius: 2 } }`。
- `theme.algorithm` 有 `defaultAlgorithm`、`darkAlgorithm`、`compactAlgorithm`，可陣列組合（例如 dark + compact）。algorithm 負責從 Seed 算出 Map token，所以改 `colorPrimary` 一個值就能派生整組色階。

來源：<https://ant.design/docs/react/customize-theme>

### 2.3 純 JS object，可由外部資料注入

- `theme` 是純 JavaScript object，文件明示可「dynamically switch themes at any time through the `theme` property of `ConfigProvider`」。也就是說任何來源（JSON 檔、markdown front matter 解析結果、API 回傳）只要組出這個 object 就能注入，沒有格式限制。來源：<https://ant.design/docs/react/customize-theme>
- 官方 Theme Editor 本身就是「編輯 token、輸出 theme config」的工具，佐證 theme config 可序列化、可搬運。來源：<https://ant.design/theme-editor>
- CSS variables 模式：v5.8.0+ 支援 `theme.cssVar`（可設 `prefix` 與 `key`），token 會輸出成 CSS custom properties，降低 runtime 開銷、方便主題切換。customize-theme 頁另提到 v6 的 zero runtime 模式（`zeroRuntime`，禁用 runtime 樣式生成、改手動引入 CSS）。來源：<https://ant.design/docs/react/customize-theme>

## 3. 兩者映射可行性與先例

### 3.1 現有工具與先例

- **沒有找到現成的 design.md → antd theme 轉換工具**。搜尋 Style Dictionary、Tokens Studio、W3C DTCG 相關結果都沒有直接產 antd `ConfigProvider` theme 的公開專案。
- 但有一條可組裝的 pipeline：
  1. Google 的 design.md CLI 可 `export` 成 **W3C DTCG 格式**。來源：<https://github.com/google-labs-code/design.md>
  2. Style Dictionary v4 對 DTCG 格式有 first-class 支援（「As of version 4, Style Dictionary has first-class support for the DTCG format」），且支援 custom format hook，可輸出任意 JS/JSON。來源：<https://styledictionary.com/info/dtcg/>
  3. 所以理論路徑是 DESIGN.md → DTCG → Style Dictionary custom format → antd theme object。mapping 表要自己寫。
- Figma 生態的先例：第三方付費產品 Ant Design System for Figma 早期用 Tokens Studio 做 token 同步，5.11 之後改用 Figma 原生 variables，證明「外部 token 檔 → antd theme」這條路有人走過，但都是商業產品、非 design.md 格式。來源：<https://www.antforfigma.com/docs/introduction-to-figma-tokens>
- W3C DTCG 規格本身：<https://design-tokens.github.io/community-group/format/>（Design Tokens Community Group 的 format spec），只定義 token 交換格式，不含 antd mapping。

### 3.2 映射策略評估

以 Linear DESIGN.md 的實際欄位對照 antd token：

**能直接映射到 Seed / Alias Token（自動派生整組樣式，效益最高）**

| DESIGN.md | antd token |
|---|---|
| `colors.primary` | `token.colorPrimary`（algorithm 自動派生 hover、bg、border 等 10 級色階） |
| `colors.semantic-success` | `token.colorSuccess`（同理 error / warning / info） |
| `colors.canvas` / `surface-1` | `token.colorBgLayout` / `token.colorBgContainer` |
| `colors.ink` / `ink-muted` / `ink-subtle` | `token.colorText` / `colorTextSecondary` / `colorTextTertiary` |
| `colors.hairline` / `hairline-strong` | `token.colorSplit` / `token.colorBorder` |
| `typography.body.fontFamily` / `fontSize` | `token.fontFamily` / `token.fontSize` |
| `rounded.md` | `token.borderRadius`（派生 borderRadiusSM/LG） |
| 深色整體氛圍（Linear 的近黑背景） | `theme.algorithm: darkAlgorithm` 加上述 seed 覆寫 |

**只能靠元件級 override 或全域 CSS**

- `components.button-primary` 的 padding、每個 state 的顏色 → `theme.components.Button` 的元件 token（`primaryColor`、`defaultBg`、`paddingInline` 等），要逐項對照 antd 元件 token 表手寫 mapping。
- `typography` 的多級 display scale → antd 只有 `fontSizeHeading1`~`fontSizeHeading5` 可對應部分；`letterSpacing` 完全沒有對應 token，只能全域 CSS。
- `spacing` scale → antd 用 `sizeUnit`/`sizeStep` 派生，和 design.md 的 named scale（xxs~section）不是一對一，只能取近似值或在 layout 層用自己的 CSS variables。
- 自訂字體（Linear Display / Linear Text）→ `token.fontFamily` 可指定，但 `@font-face` 載入要自己做。

**做不到（antd 元件內部結構固定）**

- design.md 的行銷元件（pricing-card、cta-banner、testimonial-card、customer-logo-tile）沒有對應的 antd 元件，token 映射無意義。
- markdown 本文的 prose 規則（Do's and Don'ts、Whitespace Philosophy、Responsive Behavior、Iteration Guide）不是 token，無法注入 theme；它們的正確用途是給 coding agent 當 context 讀，由 agent 在寫版面與自訂元件時遵循。這正是 DESIGN.md 規格設計的初衷（token 給精確值、prose 給應用方式）。來源：<https://github.com/google-labs-code/design.md>
- antd 元件的 DOM 結構、內建互動行為（Table 的排版密度邏輯、Modal 結構等）不受任何 token 控制，design.md 再詳細也改不了。

## 可行性結論

**部分可行。**

- YAML front matter 那層（colors / typography 基準 / rounded）映射到 antd Seed Token 完全可行，而且槓桿很大：5~10 個 seed 值就能讓整個後台換上目標視覺語言，theme 是純 JS object，parse front matter 後直接組給 `ConfigProvider` 即可。
- spacing scale、多級字階、letterSpacing、行銷型元件屬於 antd token 體系外，要靠 `theme.components`、全域 CSS 或放棄。
- prose 章節不進 theme，價值在給 coding agent 當設計 context，兩條路互補而非互斥。
- 沒有現成轉換工具，mapping 表（約 15~20 條規則）要自己寫；若想走標準化路線，可用 Google CLI 的 DTCG export 接 Style Dictionary custom format。

**建議下一步（prototype 要驗證的三件事）**

1. 寫一個 50 行內的 script：parse DESIGN.md front matter → 產出 antd theme object（含 `darkAlgorithm` 判斷），套在本專案的 `ConfigProvider` 上，用 Linear 檔實測後台頁面觀感。
2. 驗證 `theme.cssVar` 模式下切換兩份 design.md 的成本與正確性（例如 Linear 與另一個亮色系檔案互切）。
3. 挑 Table、Form、Button 三個最常用元件，確認 seed 映射後哪些視覺落差必須補 `theme.components` 覆寫，估算 mapping 表的實際維護量。
