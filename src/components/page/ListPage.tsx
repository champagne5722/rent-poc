'use client';

import { Button, Flex, Table, type TableProps } from 'antd';
import EmptyState, { type EmptyStateProps } from './EmptyState';
import FilterBar, { type FilterBarProps } from './FilterBar';
import PageHeader, { type PageHeaderProps } from './PageHeader';

// 列表頁版型（MIL-174、ADR-0090）：頁首、篩選列、表格、空狀態、分頁。全站的列表頁都用它，版型只有這一種。
// 只組合 antd 的 Table 與 Flex，不覆寫外觀。表格密度、列高與標頭顏色來自 DESIGN.md 的 Table token。
// 要用 render 函式的欄位定義，所以頁面端必須是 client component；資料由 server component 載入後傳進來。

/** 每頁筆數。全站一致（規格 41）。 */
export const LIST_PAGE_SIZE = 20;

export interface ListPageProps<T, V extends string = string> {
  header: PageHeaderProps;
  filter?: FilterBarProps<V>;
  /** 傳給 antd Table 的屬性。size、pagination、locale 由版型決定，不接受。 */
  table: Omit<TableProps<T>, 'size' | 'pagination' | 'locale' | 'title' | 'footer'>;
  /** 完全沒有資料時的空狀態。篩選後沒有結果時，版型自己顯示「清除篩選」。 */
  empty: EmptyStateProps;
}

export default function ListPage<T extends object, V extends string = string>({
  header,
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
      {filter && <FilterBar {...filter} />}
      <Table<T>
        size="middle"
        {...table}
        pagination={{
          pageSize: LIST_PAGE_SIZE,
          showSizeChanger: false,
          hideOnSinglePage: true,
          showTotal: (total) => `共 ${total} 筆`,
        }}
        locale={{ emptyText: filteredEmpty }}
      />
    </Flex>
  );
}
