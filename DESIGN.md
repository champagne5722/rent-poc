---
version: alpha
name: rent-poc-admin-design
description: "深色後台介面：近黑畫布（#010102）、炭黑面板（#0f1011）、淺灰文字（#f7f8f8），以 Linear 式薰衣草藍（#5e6ad2）作為唯一彩色強調。視覺基調取自 Linear 的設計語言，改寫為本專案後台（antd 元件）的使用慣例。"

colors:
  primary: "#5e6ad2"
  on-primary: "#ffffff"
  primary-hover: "#828fff"
  ink: "#f7f8f8"
  ink-muted: "#d0d6e0"
  ink-subtle: "#8a8f98"
  canvas: "#010102"
  surface-1: "#0f1011"
  surface-2: "#141516"
  hairline: "#23252a"
  hairline-strong: "#34343a"
  semantic-success: "#27a644"
  semantic-error: "#e5484d"
  semantic-warning: "#f2994a"

typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5

rounded:
  md: 8px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
---

# Rent 後台設計語言

## Overview

這份檔案是後台視覺語言的唯一 source of truth（ADR-0009）。兩層各有用途：

- **YAML front matter**：機器可讀的 design token。由 `src/lib/design-theme.ts` 解析、映射為 antd Seed Token 注入 `ConfigProvider`。改 token 存檔即生效，不改程式。
- **本文（以下章節）**：給寫 UI 的人與 coding agent 讀的使用慣例。token 給精確值，本文說怎麼用。

元件原則：**一律優先用 antd 元件，非不得已不自訂元件**。視覺客製透過 token 派生完成，不覆寫元件內部樣式。

## Colors

- `primary` 是整個後台唯一的彩色強調，只用於主要動作（primary Button、連結、focus、選中態）。不要拿它做裝飾、圖示上色或大面積填色。
- 頁面底是 `canvas`，卡片與容器是 `surface-1`，浮層（Dropdown、Modal）是 `surface-2`。層級靠亮度差與 `hairline` 邊線表達，不用陰影堆疊。
- 文字三級：`ink` 主文、`ink-muted` 次要說明、`ink-subtle` 佔位與停用。不要自創第四級灰。
- 狀態色只用 `semantic-*`：成功綠、錯誤紅、警告橙。合約狀態 Tag 也從這三色與 `primary` 取，不引入新色。

## Typography

- 正文 14px、行高 1.5，跟隨 antd 派生的字階（標題用 `Typography.Title` 的 level，不手寫 font-size）。
- 中文為主的介面，字體交給 antd 預設字體堆疊，不引入自訂字體。
- 數字對齊的欄位（金額、日期）在 Table 內靠右對齊。

## Layout

- 版面留白引用 spacing scale，不寫魔術數字：頁面區塊之間 `lg`（24px）、同群組欄位之間 `sm`（12px）、行內元素間 `xs`（8px）、頁面外框 padding `xl`（32px）。
- 排版容器優先用 antd 的 `Flex`、`Space`、`Row/Col`，以 `gap` 屬性吃 spacing 值，不用 margin 串接。
- 一頁一個主題：列表頁就是列表，詳情頁用分頁（Tabs）分區，不做長捲動混排。

## Components

antd 元件使用慣例：

- **Table**：`size="middle"`，一定給 `rowKey`；操作欄放最右、用文字連結不用按鈕群；狀態欄用 `Tag`。
- **Form**：`layout="vertical"`；必填靠 rules 標示；送出鈕在表單底部靠左，primary 一顆。
- **Button**：每個畫面至多一顆 primary（當前主要動作）；危險動作（撤回、刪除）用 `danger` 並掛 `Popconfirm`；次要動作用 default。
- **回饋**：操作結果用 `message`，需要打斷的確認用 `Modal.confirm`，頁面級空態用 `Empty`。
- **資訊呈現**：唯讀欄位群用 `Descriptions`，可互動列表用 `Table`，摘要卡用 `Card`。

## Do's and Don'ts

- Do：新頁面先找既有頁面的相同 pattern 沿用，維持一致性優先於局部最佳。
- Do：色彩、圓角、間距一律引用 token 名稱思考，需要新值先回這份檔案加 token。
- Don't：不要 inline style 寫死色碼與 px 間距（版面 gap 引用 spacing 值除外）。
- Don't：不要為了觀感自訂元件或覆寫 antd 內部 class；覺得醜先回報，評估加 token 或元件級覆寫（走 ADR-0009 的重評程序）。
- 注意：`colors.*` 一律用 hex 色值；深淺色判斷只認 hex，rgb()/oklch() 會被當成淺色。
