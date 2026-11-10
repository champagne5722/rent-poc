---
version: alpha
name: rent-cloud-admin-design
description: "亮色後台介面：淺灰畫布（#f7f8f8）、純白面板（#ffffff）、深灰文字（#232529），以 Linear 式薰衣草藍（#5e6ad2）作為唯一彩色強調。視覺基調取自 Linear 的設計語言（亮色版），改寫為本後台（antd 元件）的使用慣例。"

colors:
  primary: "#5e6ad2"
  on-primary: "#ffffff"
  primary-hover: "#6e79e0"
  primary-subtle: "#eff0fa"
  ink: "#232529"
  ink-muted: "#5d606b"
  ink-subtle: "#8a8f98"
  canvas: "#f7f8f8"
  surface-1: "#ffffff"
  surface-2: "#ffffff"
  hairline: "#e4e5e8"
  hairline-strong: "#d0d3d8"
  semantic-success: "#1f9e3e"
  semantic-error: "#d93843"
  semantic-warning: "#e08a2e"
  semantic-info: "#5e6ad2"

typography:
  page-title:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
  section-title:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5

rounded:
  sm: 4px
  md: 6px
  lg: 8px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px

components:
  Layout:
    bodyBg: "{colors.canvas}"
    headerBg: "{colors.surface-1}"
    headerColor: "{colors.ink}"
    headerHeight: 48px
    headerPadding: 0 24px
    lightSiderBg: "{colors.surface-1}"
    lightTriggerBg: "{colors.surface-1}"
    lightTriggerColor: "{colors.ink-muted}"
  Menu:
    itemHeight: 32px
    itemBorderRadius: "{rounded.md}"
    itemMarginInline: "{spacing.xs}"
    itemMarginBlock: "{spacing.xxs}"
    itemPaddingInline: "{spacing.xs}"
    iconSize: 16px
    groupTitleFontSize: 12px
    groupTitleColor: "{colors.ink-subtle}"
    itemColor: "{colors.ink-muted}"
    itemHoverColor: "{colors.ink}"
    itemHoverBg: "{colors.canvas}"
    itemSelectedColor: "{colors.ink}"
    itemSelectedBg: "{colors.hairline}"
    activeBarBorderWidth: 0
  Table:
    headerBg: "{colors.canvas}"
    headerColor: "{colors.ink-muted}"
    headerSplitColor: "{colors.canvas}"
    borderColor: "{colors.hairline}"
    cellPaddingBlock: 12px
    cellPaddingInline: "{spacing.md}"
    cellPaddingBlockMD: "{spacing.xs}"
    cellPaddingInlineMD: "{spacing.sm}"
    cellPaddingBlockSM: 6px
    cellPaddingInlineSM: "{spacing.sm}"
    rowHoverBg: "{colors.canvas}"
    rowSelectedBg: "{colors.primary-subtle}"
    rowSelectedHoverBg: "{colors.primary-subtle}"
    headerBorderRadius: "{rounded.md}"
  Card:
    headerBg: "{colors.surface-1}"
    headerFontSize: 16px
    headerHeight: 48px
    headerPadding: "{spacing.md}"
    headerHeightSM: 40px
    headerPaddingSM: "{spacing.sm}"
    bodyPadding: "{spacing.md}"
    bodyPaddingSM: "{spacing.sm}"
  Button:
    fontWeight: 500
    paddingInline: "{spacing.sm}"
    paddingInlineSM: "{spacing.xs}"
    defaultShadow: none
    primaryShadow: none
    dangerShadow: none
    defaultBorderColor: "{colors.hairline-strong}"
    defaultHoverBg: "{colors.canvas}"
    defaultHoverColor: "{colors.ink}"
    defaultHoverBorderColor: "{colors.hairline-strong}"
    defaultActiveBg: "{colors.hairline}"
    defaultActiveColor: "{colors.ink}"
    defaultActiveBorderColor: "{colors.hairline-strong}"
    textHoverBg: "{colors.canvas}"
  Tag:
    defaultBg: "{colors.canvas}"
    defaultColor: "{colors.ink-muted}"
  Descriptions:
    labelColor: "{colors.ink-muted}"
    contentColor: "{colors.ink}"
    titleColor: "{colors.ink}"
    labelBg: "{colors.canvas}"
    titleMarginBottom: "{spacing.sm}"
    itemPaddingBottom: "{spacing.xs}"
  Form:
    labelColor: "{colors.ink}"
    labelFontSize: 14px
    labelHeight: 32px
    labelRequiredMarkColor: "{colors.semantic-error}"
    itemMarginBottom: 20px
    verticalLabelPadding: 0 0 6px
  Alert:
    defaultPadding: 8px 12px
    withDescriptionPadding: 12px 16px
    withDescriptionIconSize: 20px
  Steps:
    iconSize: 24px
    iconSizeSM: 20px
    iconFontSize: 12px
    dotSize: 6px
    dotCurrentSize: 8px
---

# 租房雲端管理平台 後台設計語言

## Overview

這份檔案是後台視覺語言的唯一 source of truth（ADR-0009、ADR-0090）。兩層各有用途：

- **YAML front matter**：機器可讀的 design token。由 `src/lib/design-theme.ts` 解析成三種輸出，注入畫面。改 token 存檔即生效，不改程式。
- **本文（以下章節）**：給寫 UI 的人與 coding agent 讀的使用慣例。token 給精確值，本文說怎麼用。

解析後的三種輸出：

| front matter 欄位 | 輸出 | 用在哪裡 |
|---|---|---|
| `colors`、`rounded`、`spacing`、`typography` | antd Seed Token 與字級 token | `ConfigProvider` 的 `theme.token` |
| `components` | antd 元件層 token | `ConfigProvider` 的 `theme.components` |
| 以上全部 | CSS 變數（`--color-*`、`--space-*`、`--radius-*`、`--type-*`） | `src/app/globals.css`、`src/app/design-system.css` |

元件原則：**一律優先用 antd 元件，非不得已不自訂元件**。視覺客製透過 token 派生完成，不覆寫元件內部樣式。允許組合元件：只組合 antd 元件、不改外觀，例如頁首、狀態標籤、空狀態（ADR-0090）。

解析失敗時（檔案缺少、YAML 壞掉、沒有 front matter），畫面退回 antd 預設 theme，伺服器記錄 error，不擋啟動。單一欄位無法解析時（例如參照不存在），只略過該欄位並記錄 error。

## Colors

- `primary` 是整個後台唯一的彩色強調，只用於主要動作（primary Button）、連結、focus 與控制項選中態（Checkbox、Radio、Tabs）。不要拿它做裝飾、圖示上色或大面積填色。
- `primary-subtle` 是 `primary` 的淡色底，只用於「被選取的列」這類需要輕量強調的底色。它不是第二個強調色。
- `semantic-info` 與 `primary` 同值。antd 的資訊色與連結色因此跟隨強調色，畫面上沒有 antd 預設藍。
- 頁面底是 `canvas`，卡片與容器是 `surface-1`，浮層（Dropdown、Modal）是 `surface-2`。層級靠亮度差與 `hairline` 邊線表達，不用陰影堆疊。
- 導覽（側欄、頂部選單）的選中態用灰階：底色 `hairline`，文字 `ink`。導覽不用強調色。
- 文字三級：`ink` 主文、`ink-muted` 次要說明、`ink-subtle` 佔位與停用。不要自創第四級灰。
- 狀態色只用 `semantic-*`：成功綠、錯誤紅、警告橙。合約狀態 Tag 也從這三色與 `primary` 取，不引入新色。

## Typography

字階有四級。每級有字級、字重、行高，定義在 front matter 的 `typography`。

| 級別 | token 名稱 | 字級／字重／行高 | 用在哪裡 | 頁面怎麼用 |
|---|---|---|---|---|
| 頁面標題 | `page-title` | 20px／600／1.4 | 每頁一個標題 | `Typography.Title level={4}` 或 class `type-page-title` |
| 區段標題 | `section-title` | 16px／600／1.5 | Card 標題、頁面內的區段 | `Typography.Title level={5}` 或 class `type-section-title` |
| 內文 | `body` | 14px／400／1.5 | 表格、表單、一般文字 | 不寫，預設就是 |
| 輔助文字 | `caption` | 12px／400／1.5 | 說明、時間戳、欄位提示 | `Typography.Text` 搭 `type-caption`，或 antd 的 `size="small"` 元件 |

規則：

- 頁面程式碼只用上表的「頁面怎麼用」。不手寫 `font-size`、`font-weight`、`line-height`，也不寫 inline style。
- 四級以外的字級一律不用。Typography.Title 的 level 1 到 3 不在後台使用。
- antd 的標題字重只有一個 token（`fontWeightStrong`），取 `page-title` 的字重。改區段標題的字重時，要同時確認 antd 元件的標題是否受影響。
- 字體是 `body.fontFamily`，與 antd 預設字體堆疊相同。中文為主的介面，不引入自訂字體。
- 全站數字等寬（`font-variant-numeric: tabular-nums`）。數字對齊的欄位（金額、日期）在 Table 內靠右對齊。

## Layout

- 版面留白引用 spacing scale，不寫魔術數字：頁面區塊之間 `lg`（24px）、同群組欄位之間 `sm`（12px）、行內元素間 `xs`（8px）、頁面外框 padding `xl`（32px）。
- 排版容器優先用 antd 的 `Flex`、`Space`、`Row/Col`，以 `gap` 屬性吃 spacing 值，不用 margin 串接。
- 一頁一個主題：列表頁就是列表，詳情頁用分頁（Tabs）分區，不做長捲動混排。

## Components

### 元件層 token 怎麼用

`components` 欄位的結構是 `元件名稱：token 名稱：值`。元件名稱與 token 名稱必須與 antd 的 `theme.components` 相同，可用 `antd token <元件>` 查詢。值有三種寫法：

- 數字或 px：`headerHeight: 48px` 解析成數字 48。
- 多值字串：`headerPadding: 0 24px` 原樣輸出。
- 參照：`headerBg: "{colors.canvas}"`。花括號內是 front matter 的路徑，可指向 `colors`、`spacing`、`rounded`、`typography`。參照找不到時，該欄位被略過並記錄 error。

優先用參照，不重複寫色碼與間距。改 `colors.canvas` 時，所有參照它的元件跟著變。

### 現有的元件層 token 與設計意圖

| 元件 | 意圖 |
|---|---|
| Table | 密度接近 Linear。`size="middle"` 列高約 37px，`small` 約 33px。標頭是畫布色、文字 `ink-muted`。hover 列是畫布色，選取列是 `primary-subtle`。 |
| Card | 白底、`hairline` 邊線、無陰影。標題列 48px，內距 16px。`size="small"` 用於側欄屬性與摘要。 |
| Button | 無陰影，字重 500，左右內距 12px。default 按鈕的邊線是 `hairline-strong`，hover 只換底色。 |
| Tag | 預設底是畫布色，文字 `ink-muted`。狀態色用 antd 的 `color` 屬性。 |
| Menu | 亮色側欄。項目高 32px，圓角 6px，左右留 8px。選中態是灰階。 |
| Layout | 頂部列高 48px，白底。亮色側欄（`Sider theme="light"`）白底，內容區是畫布色。現有的深色殼層側欄不受影響，由殼層票改為亮色。 |
| Descriptions | 標籤 `ink-muted`、內容 `ink`。項目間距 8px。 |
| Form | `layout="vertical"`。項目間距 20px，標籤與欄位間距 6px。 |
| Alert | 緊湊內距。有 description 的 Alert 內距 12px 16px。 |
| Steps | 圖示 24px，字級 12px。 |

### 使用慣例

- **Table**：`size="middle"`，一定給 `rowKey`；操作欄放最右、用文字連結不用按鈕群；狀態欄用 `Tag`。
- **Form**：`layout="vertical"`；必填靠 rules 標示；送出鈕在表單底部靠左，primary 一顆。
- **Button**：每個畫面至多一顆 primary（當前主要動作）；危險動作（撤回、刪除）用 `danger` 並掛 `Popconfirm`；次要動作用 default。
- **回饋**：操作結果用 `message`，需要打斷的確認用 `Modal.confirm`，頁面級空態用 `Empty`。
- **資訊呈現**：唯讀欄位群用 `Descriptions`，可互動列表用 `Table`，摘要卡用 `Card`。

### 什麼時候加新 token

1. 先用既有 token 與 antd 預設。畫面看起來對，就不加。
2. 同一個外觀需求在兩個以上的畫面出現，才加。
3. antd 的元件層 token 做得到，加到 `components`。做不到，才寫進 `src/app/design-system.css`。
4. 新的顏色必須先有語意。不為單一畫面加色，也不加第二個強調色。
5. 新值寫在 front matter，並用參照指向既有的色彩、間距與圓角。
6. 加完後開 `/design` 對照，並確認 `design-theme.test.ts` 通過。

### 全域 CSS 的規則

`src/app/design-system.css` 只放 antd token 做不到的視覺，例如字階 class、數字等寬、捲軸。規則：

- 數值只能是 `var(--...)`。不寫色碼、px 或數字。
- 不選取 antd 的內部 class（`.ant-*`）。
- CSS 變數由 `designCssText()` 輸出成 `<style>`，在 `src/app/layout.tsx` 的 `<head>`。

## Do's and Don'ts

- Do：新頁面先找既有頁面的相同 pattern 沿用，維持一致性優先於局部最佳。
- Do：色彩、圓角、間距一律引用 token 名稱思考，需要新值先回這份檔案加 token。
- Do：需要版面或資訊結構的重複 pattern 時，用組合元件。組合元件只組合 antd 元件，不改外觀（ADR-0090）。
- Don't：不要 inline style 寫死色碼與 px 間距（版面 gap 引用 spacing 值除外）。
- Don't：不要自訂元件，也不要覆寫 antd 內部 class。自訂元件指自己畫外觀的元件。覺得醜先回報，評估加 token 或元件級覆寫（走 ADR-0009 的重評程序）。
- 注意：`colors.*` 一律用 hex 色值；深淺色判斷只認 hex，rgb()/oklch() 會被當成淺色。
