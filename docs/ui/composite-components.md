# 組合元件用法

本文說明後台列表頁與詳情頁的組合元件（MIL-174、MIL-175，ADR-0090）。新的列表頁與詳情頁必須用這些元件，不另寫頁首、篩選列、空狀態、骨架畫面與「下一步」區塊。

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
- 操作欄放最右並固定，用文字連結（`Button type="link" size="small"`），不用有邊框的按鈕群。最常用的動作放第一個，危險動作加 `danger`。
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

何時不用：詳情頁。詳情頁用 `DetailPageSkeleton`。

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
- 操作欄放最右，用文字連結（`Button type="link" size="small"`），不用有邊框的按鈕群。1440 寬、側欄展開時，欄位不必橫向捲動；窄於表格最小寬度時，操作欄固定在右側。
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

## 詳情頁

詳情頁分成四個檔案，結構與列表頁相同。合約詳情是第一個範例。

| 檔案 | 類型 | 負責 |
|---|---|---|
| `(detail)/page.tsx` | server component | 載入資料，處理未登入、找不到與沒有權限 |
| `(detail)/loading.tsx` | server component | 載入中顯示 `DetailPageSkeleton` |
| `(detail)/not-found.tsx` | server component | 找不到時的畫面，含返回列表的連結 |
| 詳情元件，例如 `src/components/ContractDetail.tsx` | client component | 版面、操作、optimistic update |

- `src/app/contracts/[id]/(detail)/`
- 資料載入函式在 `src/lib/contract-detail-load.ts`
- 「下一步」的文字在 `src/lib/contract-next-step.ts`

路由群組 `(detail)` 的用意與列表相同：骨架只套用在詳情，不套用到 `/contracts/[id]/edit` 的建約精靈。

### 資料載入與操作

- 載入函式回傳 `{ kind: 'not_found' }` 與 `{ kind: 'forbidden' }`。格式錯誤的 ID、別的組織的 ID、不存在的 ID 與沒有查看權限，必須是同一個畫面（P0-02 AC1）。
- 時間與金額在 server component 先渲染一次，必須與瀏覽器一致。時間固定換成台灣時間，金額固定用 `en-US` 分組。不用本機時區與語系。
- 狀態變更用 optimistic update：按下就先顯示新狀態，失敗時還原，並顯示原因與下一步。送出期間，會改變狀態的按鈕必須停用。
- 狀態變更成功後呼叫 `router.refresh()`。資料會變動的頁面，例如簽署中，用計時器定期呼叫 `router.refresh()`，不在 client component 重打 API。

## DetailPage

詳情頁版型。檔案：`src/components/page/DetailPage.tsx`。標記為 client component，server component 仍然能渲染它。

版面由上而下：返回連結與頁首、提醒、「下一步」區塊。其下左側是主要內容，右側是屬性側欄。窄於 xl 時側欄排到主要內容下方。

| prop | 型別 | 說明 |
|---|---|---|
| `header` | `PageHeaderProps` | 傳給 `PageHeader`。必須給 `back` |
| `nextStep` | `ReactNode` | 「下一步」區塊，用 `NextStep` |
| `notices` | `ReactNode` | 「下一步」上方的提醒，例如失敗說明或警示 |
| `children` | `ReactNode` | 主要內容，由上而下依重要性排列的區段 |
| `aside` | `ReactNode` | 屬性側欄，例如屬性與歷程 |
| `wide` | `ReactNode` | 兩欄下方、橫跨全寬的區段，放本身很高的內容，例如合約 PDF 預覽 |

```tsx
<DetailPage
  header={{ title: '合約 #A1B2C3', tag: <StatusTag kind="contract" value="draft" />, back: { href: '/contracts', label: '返回合約列表' } }}
  nextStep={<NextStep headline="等待乙方簽署" owner="乙方 王租客" tone="progress" />}
  aside={<Card size="small" title="合約屬性">…</Card>}
>
  <Card size="small" title="簽署進度">…</Card>
</DetailPage>
```

規則：

- 區段用 `Card size="small"` 加標題。卡片裡不再放卡片。
- 主要內容放這份資料自己的內容，屬性側欄放識別、對象與歷程。
- 頁首的動作放進入編輯與下載。處理異常的動作放在「下一步」區塊。每個畫面至多一顆 primary Button。
- 沒有內容的區段不顯示，不放空狀態。
- 本身很高的內容放 `wide`。放進主要內容欄會讓它比側欄高出一截，impeccable 會報 `first-viewport-column-overflow`。

何時不用：列表頁、表單頁、建約精靈。

## NextStep

「下一步」區塊。檔案：`src/components/page/NextStep.tsx`。標記為 client component。

| prop | 型別 | 說明 |
|---|---|---|
| `headline` | `string` | 下一步要做的事，一句話 |
| `owner` | `string` | 負責人。簽署中寫角色加姓名 |
| `detail` | `string \| null` | 補充說明，例如拒簽原因 |
| `tone` | `StatusTone` | 狀態呈現表的 5 種色調，顯示成狀態點 |
| `actions` | `ReactNode` | 處理動作，例如撤回、複製為新草稿 |
| `children` | `ReactNode` | 動作下方的補充內容，例如簽署連結 |

規則：

- 每個狀態都必須有 `headline` 與 `owner`。合約的對照在 `contractNextStep()`，`contract-next-step.test.ts` 會檢查每個合約狀態。
- 文案不得暗示平台歷程具法律效力（ADR-0007）。
- 稱謂來自標籤對照表與 `SIGNER_ROLE_LABELS`，不另寫字串。

## DetailPageSkeleton

詳情頁的骨架畫面。檔案：`src/components/page/DetailPageSkeleton.tsx`。標記為 client component，server component 與 `loading.tsx` 仍然能渲染它。

```tsx
// src/app/<區域>/[id]/(detail)/loading.tsx
import DetailPageSkeleton from '@/components/page/DetailPageSkeleton';

export default function Loading() {
  return <DetailPageSkeleton />;
}
```

| prop | 型別 | 說明 |
|---|---|---|
| `withAction` | `boolean` | 頁首右側有沒有動作。預設 `true` |

骨架的版面與 `DetailPage` 對齊：返回連結與頁首、「下一步」區塊、主要內容、屬性側欄。

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

範圍內的 inline style 已清到 0（MIL-185），規則是錯誤等級：

- 任何 `style` 屬性都讓 `npm run lint` 失敗，沒有基準額度。
- 承租人端（`src/app/tenant/**`、`src/components/Tenant*.tsx`）與 demo 頁（`src/app/demo/**`、`src/components/DemoOtpList.tsx`）不在重構範圍，例外清單在 `eslint.config.mjs` 的 `inlineStyleExempt`。
- 新增頁面不得加入例外清單。

## 設定類頁面（MIL-181）

組織成員、執業主體、我的證書這類「幾個區段各管一件事」的頁面，用 `SettingsPage` 加 `SettingsSection`。收款帳戶只有一張表，用 `ListPage`。

| 元件 | 檔案 | 用途 |
|---|---|---|
| `SettingsPage` | `src/components/page/SettingsPage.tsx` | 頁首、提醒（`notices`）、由上而下的區段 |
| `SettingsSection` | `src/components/page/SettingsSection.tsx` | 一張 `Card size="small"`：標題、說明（`description`）、右側動作（`extra`） |
| `SettingsPageSkeleton` | `src/components/page/SettingsPageSkeleton.tsx` | `loading.tsx` 用的骨架畫面，頁首加兩個區段 |
| `ListTable` | `src/components/page/ListTable.tsx` | 區段內的表格。分頁與空狀態與 `ListPage` 相同 |
| `NoAccess` | `src/components/page/NoAccess.tsx` | 目前的身分看不到這一頁時的畫面。頁首加空狀態，沒有動作 |

規則：

- 頁首標題寫這一頁自己的名稱，不與頂部列的區域名稱重複。
- 區段內的清單用 `ListTable`，沒有資料時用 `EmptyState`，說明寫下一步。
- 操作欄放最右並固定，用文字連結。
- 資料在 server component 載入。載入函式回傳 `{ kind: 'forbidden' }`，頁面顯示 `NoAccess`。
- `ListPage` 的 `intro` 放頁首下方的一句說明，例如清單的範圍或限制。
- 執業主體端與證書端的送件進度共用「尚未送件」這個詞，定義在 `src/lib/status-presentation.ts` 的 `licensePhase` 與 `practitionerPhase`。
