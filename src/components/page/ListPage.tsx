'use client';

import { Button, Flex, Typography, type TableProps } from 'antd';
import type { ReactNode } from 'react';
import EmptyState, { type EmptyStateProps } from './EmptyState';
import FilterBar, { type FilterBarProps } from './FilterBar';
import ListTable, { LIST_PAGE_SIZE } from './ListTable';
import PageHeader, { type PageHeaderProps } from './PageHeader';

// 列表頁版型（MIL-174、ADR-0090）：頁首、篩選列、表格、空狀態、分頁。全站的列表頁都用它，版型只有這一種。
// 只組合 antd 的 Table 與 Flex，不覆寫外觀。表格密度、列高與標頭顏色來自 DESIGN.md 的 Table token。
// 要用 render 函式的欄位定義，所以頁面端必須是 client component；資料由 server component 載入後傳進來。
// 表格本身在 ListTable，設定頁的區段共用它（MIL-181）。

export { LIST_PAGE_SIZE };

export interface ListPageProps<T, V extends string = string> {
  header: PageHeaderProps;
  /** 頁首下方的一句說明，寫這份清單的範圍或限制。 */
  intro?: ReactNode;
  filter?: FilterBarProps<V>;
  /** 傳給 antd Table 的屬性。size、pagination、locale 由版型決定，不接受。 */
  table: Omit<TableProps<T>, 'size' | 'pagination' | 'locale' | 'title' | 'footer'>;
  /** 完全沒有資料時的空狀態。篩選後沒有結果時，版型自己顯示「清除篩選」。 */
  empty: EmptyStateProps;
}

export default function ListPage<T extends object, V extends string = string>({
  header,
  intro,
  filter,
  table,
  empty,
}: ListPageProps<T, V>) {
  const filteredEmpty = filter?.active ? (
    <EmptyState
      description="沒有符合篩選條件的資料"
      action={
        <Button type="primary" onClick={filter.onClear}>
          清除篩選
        </Button>
      }
    />
  ) : (
    <EmptyState {...empty} />
  );

  return (
    <Flex vertical gap="large">
      <PageHeader {...header} />
      {intro && <Typography.Text type="secondary">{intro}</Typography.Text>}
      {filter && <FilterBar {...filter} />}
      <ListTable<T> table={table} emptyNode={filteredEmpty} />
    </Flex>
  );
}
