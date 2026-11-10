# 組合元件用法

本文說明後台列表頁的組合元件（MIL-174，ADR-0090）。新的列表頁必須用這些元件，不另寫頁首、篩選列、空狀態與骨架畫面。

組合元件只組合 antd 元件，不覆寫外觀。顏色、字級、列高來自 `DESIGN.md`。元件放在 `src/components/page/`。

`src/components/page/` 的每個元件都標記為 client component。原因是 antd 的靜態成員（`Skeleton.Input`、`Empty.PRESENTED_IMAGE_SIMPLE`）與 `@ant-design/icons` 在 server component 取不到。server component 照常 import 並渲染它們，只是不能傳事件處理函式當 prop。

## 一頁怎麼組成

列表頁分成三個檔案。

| 檔案 | 類型 | 負責 |
|---|---|---|
| `page.tsx` | server component | 載入資料，處理未登入與沒有權限 |
| `loading.tsx` | server component | 載入中顯示 `ListPageSkeleton` |
| 列表元件，例如 `src/components/ContractList.tsx` | client component | 篩選狀態、欄位定義、列上操作 |

合約列表是第一個範例：

- `src/app/contracts/(list)/page.tsx`
- `src/app/contracts/(list)/loading.tsx`
- `src/components/ContractList.tsx`
- 資料載入函式在 `src/lib/contract-list-load.ts`

### 為什麼放在路由群組

`loading.tsx` 會套用到同資料夾底下的所有路由。合約列表放進 `(list)` 群組，骨架畫面就只出現在列表，不會出現在 `/contracts/[id]` 與 `/contracts/new`。`(list)` 不會出現在網址。

### 頂部列與頁首不重複

- 頂部列左側顯示區域名稱，例如「合約」。它來自 `resolvePageTitle()`，用次要文字色。
- 頁首顯示這一頁自己的標題。列表頁寫「X列表」，詳情頁寫物件的識別，例如「合約 #A1B2C3」。
- 兩處不寫同一個詞。

### 資料載入

- server component 載入資料，用 `redirect()` 處理 `Unauthenticated`。
- 載入函式不丟 `Forbidden`。它回傳 `{ kind: 'forbidden' }`，由頁面決定畫面。
- 列上操作成功後，client component 呼叫 `router.refresh()`，server component 重新載入。
- 不在 client component 用 `useEffect` 加 `fetch` 載入首屏資料。

## PageHeader

頁首。檔案：`src/components/page/PageHeader.tsx`。標記為 client component，server component 仍然能渲染它。傳入的 `tag` 與 `extra` 若含事件處理函式，必須來自 client component。

| prop | 型別 | 說明 |
|---|---|---|
| `title` | `string` | 這一頁自己的標題，必填 |
| `tag` | `ReactNode` | 標題右側的狀態標籤，用 `StatusTag` |
| `extra` | `ReactNode` | 右側的動作。每個畫面至多一顆 primary Button |
| `back` | `{ href: string; label?: string }` | 返回連結。`label` 預設「返回列表」 |

```tsx
<PageHeader
  title="合約 #A1B2C3"
  tag={<StatusTag kind="contract" value="signing" />}
  extra={<Button type="primary">送簽</Button>}
  back={{ href: '/contracts' }}
/>
```

何時不用：登入頁、建約精靈這類沒有「標題加動作」結構的畫面。

## FilterBar

篩選列。檔案：`src/components/page/FilterBar.tsx`。client component。

| prop | 型別 | 說明 |
|---|---|---|
| `status` | `{ value, options, onChange }` | 狀態分段選單。`options` 的每項有 `value`、`label`、`count` |
| `children` | `ReactNode` | 其他篩選控制項，例如 `Select`、`DatePicker.RangePicker` |
| `active` | `boolean` | 有任何篩選條件時為 `true`，顯示「清除篩選」 |
| `onClear` | `() => void` | 按下「清除篩選」時呼叫，必須把所有條件還原 |

篩選的狀態由頁面持有。`FilterBar` 只畫畫面。

```tsx
<FilterBar
  status={{ value: status, onChange: setStatus, options: [{ value: 'all', label: '全部', count: 12 }] }}
  active={status !== 'all'}
  onClear={() => setStatus('all')}
>
  <Select placeholder="物件" options={propertyOptions} />
</FilterBar>
```

何時不用：只有一個搜尋框的頁面，直接用 antd `Input.Search`。通常不需要單獨用 `FilterBar`，用 `ListPage` 即可。

## EmptyState

空狀態。檔案：`src/components/page/EmptyState.tsx`。標記為 client component，server component 仍然能渲染它。

| prop | 型別 | 說明 |
|---|---|---|
| `description` | `ReactNode` | 說明為什麼是空的，以及下一步 |
| `action` | `ReactNode` | 唯一的主要動作，通常是一顆 Button |

```tsx
<EmptyState
  description="尚無合約。建立第一份合約，開始電子簽約。"
  action={<Button type="primary">建立合約</Button>}
/>
```

規則：

- 完全沒有資料時，動作是「建立」。
- 篩選後沒有結果時，動作是「清除篩選」。`ListPage` 會自動切換，頁面不必處理。
- 沒有權限時，不給動作，說明寫下一步。

何時不用：表格內載入失敗。失敗用 `Alert` 或 `Result`，並寫出下一步。

## ListPageSkeleton

列表頁的骨架畫面。檔案：`src/components/page/ListPageSkeleton.tsx`。標記為 client component，server component 與 `loading.tsx` 仍然能渲染它。

```tsx
// src/app/<區域>/(list)/loading.tsx
import ListPageSkeleton from '@/components/page/ListPageSkeleton';

export default function Loading() {
  return <ListPageSkeleton />;
}
```

| prop | 型別 | 說明 |
|---|---|---|
| `withAction` | `boolean` | 頁首右側有沒有主要動作。預設 `true`。沒有動作的頁面傳 `false` |

規則：

- 載入中必須顯示骨架畫面，不整頁轉圈。
- 骨架的版面與 `ListPage` 對齊：頁首、篩選列、八列表格。

何時不用：詳情頁。詳情頁的版型與骨架在階段 2 另建。

## ListPage

列表頁版型。檔案：`src/components/page/ListPage.tsx`。client component。

| prop | 型別 | 說明 |
|---|---|---|
| `header` | `PageHeaderProps` | 傳給 `PageHeader` |
| `filter` | `FilterBarProps` | 傳給 `FilterBar`。省略時沒有篩選列 |
| `table` | antd `TableProps` | 欄位、資料、`rowKey`。`size`、`pagination`、`locale`、`title`、`footer` 由版型決定，不接受 |
| `empty` | `EmptyStateProps` | 完全沒有資料時的空狀態 |

版型固定的行為：

- 表格 `size="middle"`。
- 分頁每頁 `LIST_PAGE_SIZE` 筆（20），不顯示筆數切換，只有一頁時隱藏，並顯示「共 N 筆」。
- 表格沒有資料時：`filter.active` 為 `true` 顯示「沒有符合篩選條件的資料」加「清除篩選」，否則顯示 `empty`。

```tsx
<ListPage<Contract, ContractStatus | 'all'>
  header={{ title: '合約列表' }}
  filter={{ status, active, onClear, children }}
  empty={{ description: '尚無合約。', action: <Button type="primary">建立合約</Button> }}
  table={{ rowKey: 'id', dataSource: rows, columns }}
/>
```

何時不用：

- 詳情頁或表單頁。
- 資料不是「一列一筆」的畫面，例如工作台的摘要卡。

## 不寫 inline style

lint 規則 `rent/no-inline-style` 擋下所有 JSX 的 `style` 屬性（規則在 `eslint-rules/no-inline-style.mjs`）。

替代做法：

| 需求 | 做法 |
|---|---|
| 版面間距、對齊 | antd 的 `Flex`、`Space`、`Row`，用 `gap` 屬性 |
| 字級與字重 | class `type-page-title`、`type-section-title`、`type-caption`，或 antd 元件的 `size` |
| 顏色 | antd 元件的 `type`、`color` 屬性，或 CSS Modules 引用 `var(--color-*)` |
| 寬度、尺寸 | CSS Modules，數值引用 `var(--space-*)` |
| 動態的值 | 用 class 名稱切換狀態，不在 `style` 內計算 |

既有檔案的違規記在 `eslint-rules/inline-style-baseline.json`：

- 數量只降不升。新增 inline style 會讓 lint 失敗。
- 重構一個檔案時，必須清掉它的 inline style，並從基準刪除該條目。違規少於基準時，lint 也會失敗，提醒更新基準。
- 執行 `npm run lint:inline-style`，把基準內的違規逐處列成警告，用來看還剩多少。平常的 `npm run lint` 不列這些警告，因為 `--max-warnings=10` 會被擠爆。
