# Ant Design 後台佈局與 Dashboard 指引研究

> 本文件是 wayfinder 票「Ant Design 後台佈局與 Dashboard 指引研究」（01-antd-dashboard-guidance）的研究成果。
> 研究日期：2026-07-23。
> 全文只依第一手來源（ant.design、procomponents.ant.design、Ant Design 官方 GitHub repo、npm registry 上的官方套件 metadata），每節附來源連結。

## 版本前提

- 本 repo 使用 `antd@6.5.1`（major **v6**）、`@ant-design/nextjs-registry@^1.3.0`、Next.js 16.2.11（App Router）、React 19.2.4（見 `package.json`）。
- ant.design 官方文件站目前即以 **6.5.1** 版為準（Layout 元件頁的 changelog 連結指向 6.5.1），本文引用的元件文件皆為 v6 文件。
- v5 → v6 與本題相關的破壞性變更（來源：[v6 遷移指南](https://ant.design/docs/react/migration-v6)）：
  - `antd@6` 要求 React >= 18，預設改用 CSS variables 主題。
  - `Menu`：`children` 寫法棄用，一律用 `items` 陣列。
  - `Breadcrumb`：`routes` → `items`、`breadcrumbName` → `title`，`Breadcrumb.Item`／`Breadcrumb.Separator` 棄用。
  - 各元件樣式 props 整併為 `styles`／`classNames` 物件。

---

## 1. Side menu 佈局：官方元件組合與用法

### 結論（事實）

- 官方的後台 side menu 組合是 **`Layout` + `Layout.Sider`（`collapsible`）+ `Menu`（`mode="inline"`）**，內容區用 `Layout.Content`，官方示範中 Breadcrumb 放在 Content 頂部。收合行為由 `Sider` 內建（`collapsible` / `collapsed` / `onCollapse` / `breakpoint`）。
- 官方設計規範明確建議：**選單超過 6 項、多層級、操作密集的後台用側邊導覽；一級項目 2–7 個、層級 1–2 層的簡單產品用頂部導覽**。
- Breadcrumb 官方立場是「能少用就少用」：**層級少於 3 層時不需要顯示 breadcrumb**。

### 細節

**元件組合**（來源：[Layout 元件文件](https://ant.design/components/layout)）：

- 文件示範四種骨架：`Header-Content-Footer`（純頂部導覽）、`Sider` 兩欄式、`Header + Sider` 混合（兩種變體）、以及經典的 `Sider + Header + Content + Footer`。
- 官方 "side" demo（[components/layout/demo/side.tsx](https://github.com/ant-design/ant-design/blob/master/components/layout/demo/side.tsx)）的完整結構：
  - 外層 `Layout` 設 `minHeight: '100vh'`。
  - `Sider` 設 `collapsible`，以 `useState` 控制 `collapsed`／`onCollapse`。
  - `Menu` 用 `theme="dark"`、`mode="inline"`、`items` 陣列（含巢狀 submenu）。
  - 右側 `Layout` 內依序放 `Header`、`Content`（內含 `Breadcrumb` + 主要內容面板）、`Footer`。
  - 用 `theme.useToken()` 取 `colorBgContainer`、`borderRadiusLG` 做內容面板底色與圓角（v6 token 化樣式的建議寫法）。

**Sider 收合相關 props**（來源：[Layout 元件文件](https://ant.design/components/layout)）：

| prop | 說明 | 預設 |
|---|---|---|
| `collapsible` | 是否可收合 | `false` |
| `collapsed` / `onCollapse` | 受控收合狀態／點 trigger 或觸發響應式時回呼 | - |
| `collapsedWidth` | 收合後寬度；設 `0` 時會出現特殊的 zero-width trigger | `80` |
| `breakpoint` | 響應式斷點（`xs`–`xxxl`），視窗小於斷點自動收合 | `xxxl` |
| `trigger` | 自訂收合把手；設 `null` 隱藏 | - |
| `zeroWidthTriggerStyle` | `collapsedWidth=0` 時特殊 trigger 的樣式 | - |

**側邊 vs 頂部導覽的選擇**（來源：[設計規範 Navigation](https://ant.design/docs/spec/navigation)、[設計模式 導航](https://ant.design/docs/spec/research-navigation)）：

- 側邊導覽：「選單多於 6 項時建議使用」，支援 1–3 層，適合 "multi-level, operation intensive and dashboard-like web apps"，項目可擴充、可容納較長字樣。
- 頂部導覽：適合一級內容 2–7 項、層級 1–2 層；一級項目字數建議 15 字元內；適合 landing page 與消費者端產品。
- 通用原則：資訊架構「盡量淺、平、寬」（shallow, flat, wide）。

**Breadcrumb 搭配**（來源：同上兩份規範）：

- 「層級少於三層時，不需要顯示 breadcrumb，全域導覽已足以呈現位置」。
- 「盡量避免使用 breadcrumb，特別是當頁面已有其他導覽元件足以說明位置時」；若層級深，顯示深度最好低於 3 層、不超過 5 層。

**佈局尺寸規範**（來源：[設計規範 Layout](https://ant.design/docs/spec/layout)）：

- 後台常見兩種自適應：左右佈局「固定左側導覽、右側工作區動態縮放」；上下佈局則定義左右最小邊距、中央內容區動態縮放。
- 柵格：24 欄、以 8px 為基本單位，所有尺寸建議為 8 的倍數。

---

## 2. ProLayout（@ant-design/pro-components）：功能與引入成本

### 結論（事實）

- ProLayout 提供完整的中後台骨架：**side／top／mix 三種佈局模式、由 route 設定自動產生選單、依 `location.pathname` 自動選中選單並產生 breadcrumb**，搭配 `PageContainer` 自動生成頁面標題與麵包屑。
- **相容性是目前最大的門檻**：npm 上 `@ant-design/pro-components` 的 `latest` 是 **2.8.10（2025-07-17 發布），peerDependencies 是 `antd: ^4.24.15 || ^5.11.2`，不含 v6**。支援 antd v6 的 **v3 系列（peer `antd: ^6.0.0`）至今（2026-07-22 發布的 3.1.14-4）仍掛在 `beta` dist-tag**，尚無 v3 stable。
- ProLayout 官方文件明說「**與 Umi 配合使用會有最好的效果**」；`route`／`location` 這兩個關鍵 props 是 Umi 自動注入的，非 Umi 環境（含 Next.js）需自行傳入。**官方沒有任何 Next.js（含 App Router）使用文件**；pro-components repo 內搜不到 Next.js 整合文件，只有社群回報的 Next.js 相關 bug issues。

### 細節

**ProLayout 提供的東西**（來源：[ProLayout 文件](https://procomponents.ant.design/components/layout)，原始檔 [site/components/layout.md](https://github.com/ant-design/pro-components/blob/master/site/components/layout.md)）：

- `layout: 'side' | 'top' | 'mix'`（預設 `side`）；`contentWidth: 'Fluid' | 'Fixed'`（Fixed 定寬 1200px）。
- 自動選單：傳入 `route`（巢狀路由設定，節點含 `path`/`name`/`icon`/`hideInMenu`/`hideChildrenInMenu` 等 `MenuDataItem` 欄位），ProLayout 依 `location.pathname` 自動選中選單、自動產生 breadcrumb；也可用 `menuDataRender`/`postMenuData` 動態改資料、`menu.request` 從伺服器載入選單。
- 收合：內建 `collapsed`/`onCollapse`/`defaultCollapsed`，且內建 `breakpoint`（預設 `lg`）觸發自動收合——FAQ 明講「設定預設收起不生效，是因為內建 breakpoint 機制，可設 `breakpoint={false}` 關掉」。
- 尺寸 token：`siderWidth` 預設 256（mix 模式 215）、header 高度 token `heightLayoutHeader` 預設 56；收合寬度不可自訂（官方 FAQ 明講）。
- 客製點：所有 `xxxRender` props（`headerRender`、`footerRender`、`menuRender`、`menuItemRender`、`breadcrumbRender`、`actionsRender`、`avatarProps` 等）皆可傳 `false` 關閉渲染。
- 附屬能力：`mix` 模式專屬的 `splitMenus`（一級選單放頂欄）、水印 `waterMarkProps`、`SettingDrawer`（主題／佈局切換面板）、`RouteContext`（取得 `isMobile`/`collapsed` 等佈局狀態，`PageContainer` 與 `FooterToolbar` 都靠它）、`DefaultFooter`、`getMenuData`/`getPageTitle` 工具函式。

**PageContainer**（來源：[PageContainer 文件原始檔](https://github.com/ant-design/pro-components/blob/master/site/components/page-container.md)）：

- 頁面容器：統一提供頁面標題（`title`/`subTitle`）、麵包屑（`breadcrumb`/`breadcrumbRender`）、頁面操作區（`extra`）、頁級 loading、水印；`header` 支援 `tags`/`avatar`/`onBack` 等 PageHeader 設定。與 ProLayout 搭配時自動推算 breadcrumb 與頁面標題。

**非 Umi 環境的接法**（來源：[site/components/layout.md](https://github.com/ant-design/pro-components/blob/master/site/components/layout.md)、[guidelines/components/pro-layout.md](https://github.com/ant-design/pro-components/blob/master/guidelines/components/pro-layout.md)）：

- 文件明載：「ProLayout 其實會讀取 props 中的 `route` 和 `location`。這兩個屬性是 Umi 預設注入的」——非 Umi 環境要自己傳（Next.js 下即 `usePathname()` 組出 `location`）。
- 官方 guideline 將「沒傳 `location` 導致選單無法高亮」「用 router 時忘記在 `menuItemRender` 裡改用 `Link` 而非 `<a>`」列為 common mistakes——亦即在 Next.js 需以 `menuItemRender` 包 `next/link`。

**版本相容性事實**（來源：npm registry `@ant-design/pro-components` metadata；[pro-components repo](https://github.com/ant-design/pro-components)）：

| 版本線 | dist-tag | 最新版（查詢日） | peerDependencies | 備註 |
|---|---|---|---|---|
| v2 | `latest` | 2.8.10（2025-07-17） | `antd: ^4.24.15 \|\| ^5.11.2`、react >= 17 | **不支援 antd v6** |
| v3 | `beta` | 3.1.14-4（2026-07-22） | `antd: ^6.0.0`、react >= 18 | `engines.node >= 22.12`；master 分支即 v3 |

**Ant Design Pro（scaffold）與 Next.js**（來源：[Ant Design Pro v6.0.0 release issue #11735](https://github.com/ant-design/ant-design-pro/issues/11735)）：

- Ant Design Pro v6.0.0（2026-04-30 發布）：React 19 + antd 6（CSS variables）+ **Umi Max 4** + `@ant-design/pro-components` v3 + Tailwind CSS v4 等。整個 scaffold 綁定 Umi，release 公告**未提及任何 Next.js 支援**；官方建議升級方式是「開新 v6 專案、逐步搬業務碼」。
- pro-components repo 的文件樹中沒有任何 Next.js/SSR 使用指南；GitHub 上 Next.js 相關內容皆為使用者 bug 回報（如 [#7623](https://github.com/ant-design/pro-components/issues/7623)、[#8080](https://github.com/ant-design/pro-components/issues/8080)、[#8753](https://github.com/ant-design/pro-components/issues/8753)）。

**antd 本體的 Next.js App Router 官方支援**（來源：[Use with Next.js](https://ant.design/docs/react/use-with-next)）：

- 官方建議 App Router 專案用 `@ant-design/nextjs-registry` 的 `<AntdRegistry>` 包住 `app/layout.tsx` 的 children（抽取首屏樣式、避免閃爍）。
- 明確警告：App Router（RSC）**不支援點語法子元件**（如 `<Select.Option />`、`<Typography.Text />`），需改由路徑直接 import；此限制針對 Server Component，`'use client'` 元件不受影響。

---

## 3. Dashboard／總覽頁的官方設計指引

### 結論（事實）

- 官方把後台首頁定調為「**工作台（Workbench）**」模式：hub-and-spoke 的導航樞紐，讓使用者不離開頁面就能完成高頻任務。**模組數建議 5–9 個、最常用內容盡量放首屏、依日常使用頻率排序、可按角色給差異化視圖**。
- 工作台 ≠ 數據分析 dashboard：前者以「可用性與任務完成」為先，後者以視覺化分析為主。Ant Design Pro 因此提供三個 dashboard 模板：**Analysis（分析頁）、Monitor（監控頁）、Workplace（工作台）**，且預設路由 redirect 到 `dashboard/analysis`。

### 細節

**工作台設計模式**（來源：[設計模式 工作台](https://ant.design/docs/spec/research-workbench)）：

- 建議內容模組：說明／幫助、核心資料、快捷入口（shortcuts）、待辦（to-do）、關注焦點、營運類模組。
- 佈局原則（官方原句意譯）：「展示與日常工作相關的模組，總數保持在 5–9 個」「最常用的內容盡可能呈現在首屏」「提供以角色為基礎的差異化視圖」；模組排序「依日常工作中的使用頻率」。
- 導航兩型：熟手直接進功能；生手靠工作台的任務式引導探索。

**Pro 模板**（來源：[ant-design-pro config/routes.ts](https://github.com/ant-design/ant-design-pro/blob/master/config/routes.ts)）：

- `/dashboard` 下有 `analysis`、`monitor`、`workplace` 三個頁面模板；root `/` redirect 至 dashboard analysis。實際樣板可在 [preview.pro.ant.design](https://preview.pro.ant.design) 檢視。

---

## 4. 列表頁、詳情頁、表單頁的官方頁面模板慣例

### 結論（事實）

- 官方（設計模式文件 + Ant Design Pro 模板）對三類頁面都有成對的「設計指引 + 現成模板」：
  - **列表頁**：五種模板——查詢表格（table list）、標準列表（basic list）、卡片列表（card list）、搜尋列表（search list）、成員管理。
  - **詳情頁**：基礎詳情（單卡片 + Descriptions）與複雜詳情（卡片分組／Tabs／Steps）。
  - **表單頁**：基礎表單、**分步表單（Step Form，用 Steps + 提交前確認 + 完成回饋）**、分組（advanced）表單。

### 細節

**列表頁**（來源：[設計模式 列表頁](https://ant.design/docs/spec/research-list)；模板見 [Pro routes](https://github.com/ant-design/ant-design-pro/blob/master/config/routes.ts) 的 `/list`：`table-list`、`basic-list`、`card-list`、`search`）：

- 五種模板的適用情境：查詢表格「每筆資料要露出多欄位、使用者有明確查詢範圍」；標準列表「條目概覽 + 進詳情，也可當簡化版工作台」；卡片列表「瀏覽順序不重要、重視展示」；搜尋列表「跨主題以關鍵字搜尋」；成員管理「成員與權限管理」。
- 結構：單欄式「由上而下堆疊，篩選模組在頂部」；篩選條件多且空間允許時可用雙欄（篩選在側欄）。
- 原則：可掃描性（一致格式凸顯關鍵欄位）、可查找性（合理排序 + 合適的搜尋元件）；影響整頁的批次操作放底部。

**詳情頁**（來源：[設計規範 詳情頁](https://ant.design/docs/spec/detail-page)；模板見 Pro routes 的 `/profile`：`basic`、`advanced`）：

- 基礎詳情：內容少、複雜度低時用單卡片，區塊間用非通欄分隔線。
- 複雜詳情：資訊複雜、關聯弱時以卡片、Tabs、Steps 分組。
- 三原則（官方原句意譯）：「直接了當——盡量平鋪，不必要就不摺疊」「層次清晰——用親密性原則降低每頁資訊複雜度」「簡潔一致——相似的佈局與模組，減少結構差異的干擾」。
- 建議元件：Descriptions（描述列表）承載 metadata、Collapse、Table 承載複雜資料、Timeline／Steps 呈現流程與狀態。

**表單頁**（來源：[設計模式 表單頁](https://ant.design/docs/spec/research-form)；模板見 Pro routes 的 `/form`：`basic-form`、`step-form`、`advanced-form`）：

- 三種模板：基礎表單（輸入量少）、分步表單（多階段線性流程）、分組表單（大型複雜表單按相關性分組）。
- 分步表單適用時機（官方原句意譯）：「把大而複雜的任務拆解成多個部分，按相關性分組，降低輸入負擔」，適合「線性邏輯明確」的任務；建議結構＝步驟指示器（Steps）＋線性填寫＋**提交前確認步驟**＋完成後明確回饋（Result）。
- 其他原則：效率（快速完成）、清晰（標題與提示準確）、安全（提供儲存機制與「返回、重設、取消、清除、撤銷」等挽回手段）；一致性——「同類內容不要用不同的元件或呈現形式」。

---

## 對本專案的含意

以本 repo 現況（Next.js 16 App Router + antd 6.5.1、`src/components/AppShell.tsx` 目前是 **Header 內水平 Menu 的 top nav**，一級項目只有「物件」「合約」兩項）陳述事實與選項，不做決定：

1. **top nav vs side menu**：官方指引是「一級項目 2–7 個、層級 1–2 層 → 頂部導覽；選單多於 6 項 → 側邊導覽」。目前僅 2 個一級項目，現行 top nav 落在官方 top nav 的適用區間；若預期選單會長到 6 項以上或出現二層選單，官方 side demo（`Layout` + `collapsible Sider` + `Menu mode="inline"` + `theme.useToken()`）是可直接沿用的組合，不需新增任何依賴。AppShell 已用 `items` API，符合 v6 慣例。
2. **ProLayout 的引入成本**：本 repo 是 antd 6.5.1，pro-components 的 stable（2.8.10）peer 不含 antd v6，**要用 ProLayout 就得裝 v3 beta（3.1.14-x）**；且官方無 Next.js App Router 支援文件，需自行以 `usePathname()` 傳 `location`、以 `menuItemRender` 包 `next/link`，並承擔 beta 版與 App Router 整合的風險。取捨在於：ProLayout 換到的自動選單／自動 breadcrumb／PageContainer 骨架，本專案選單極小，同樣效果用純 antd 組合的程式量不大。
3. **Breadcrumb**：目前資訊架構約兩層（列表 → 詳情），官方明確說「少於三層不需 breadcrumb」。
4. **Dashboard／總覽頁**：若加總覽頁，官方工作台模式對應到本專案的自然素材是：待辦（如待簽署／簽署中的合約）、核心數據（物件數、合約狀態統計）、快捷入口（建立合約）；官方建議模組 5–9 個、最常用放首屏。分析型圖表頁（Analysis/Monitor 模板）與工作台是兩種不同定位。
5. **頁面模板**：合約列表對應「查詢表格／標準列表」模式（篩選在上、批次操作在下）；合約詳情對應「基礎詳情」（Descriptions + 必要時 Steps 呈現簽署進度）；建立合約若流程多步（選物件 → 條款 → 簽署設定 → 確認），官方分步表單模式（Steps + 提交前確認 + Result 回饋）是現成慣例。
6. **App Router 注意事項**：RSC 中不能用點語法子元件（`Layout.Sider`、`Typography.Text` 等）；`AppShell.tsx` 是 `'use client'` 所以現行寫法可用。`@ant-design/nextjs-registry` 已安裝，符合官方 App Router 建議。

## 來源總表

- antd Layout 元件文件（v6.5.1）：https://ant.design/components/layout
- antd 官方 side demo 原始碼：https://github.com/ant-design/ant-design/blob/master/components/layout/demo/side.tsx
- 設計規範 Layout：https://ant.design/docs/spec/layout
- 設計規範 Navigation：https://ant.design/docs/spec/navigation
- 設計模式 導航：https://ant.design/docs/spec/research-navigation
- 設計模式 工作台：https://ant.design/docs/spec/research-workbench
- 設計模式 列表頁：https://ant.design/docs/spec/research-list
- 設計規範 詳情頁：https://ant.design/docs/spec/detail-page
- 設計模式 表單頁：https://ant.design/docs/spec/research-form
- antd Use with Next.js：https://ant.design/docs/react/use-with-next
- antd v6 遷移指南：https://ant.design/docs/react/migration-v6
- ProLayout 文件：https://procomponents.ant.design/components/layout （原始檔 https://github.com/ant-design/pro-components/blob/master/site/components/layout.md ）
- ProLayout 官方 guideline：https://github.com/ant-design/pro-components/blob/master/guidelines/components/pro-layout.md
- PageContainer 文件原始檔：https://github.com/ant-design/pro-components/blob/master/site/components/page-container.md
- `@ant-design/pro-components` npm metadata（dist-tags／peerDependencies，2026-07-23 以 `npm view` 查詢）：https://www.npmjs.com/package/@ant-design/pro-components
- Ant Design Pro v6.0.0 release：https://github.com/ant-design/ant-design-pro/issues/11735
- Ant Design Pro 路由（頁面模板清單）：https://github.com/ant-design/ant-design-pro/blob/master/config/routes.ts
