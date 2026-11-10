'use client';

import { Table, type TableProps } from 'antd';
import type { ReactNode } from 'react';

// 列表的表格（MIL-174、MIL-181、ADR-0090）：ListPage 與設定類頁面的區段共用同一份表格設定。
// 表格 size="middle"，每頁 LIST_PAGE_SIZE 筆，不顯示筆數切換，只有一頁時隱藏，並顯示「共 N 筆」。

/** 每頁筆數。全站一致（規格 41）。 */
export const LIST_PAGE_SIZE = 20;

export interface ListTableProps<T> {
  /** 傳給 antd Table 的屬性。size、pagination、locale、title、footer 由版型決定，不接受。 */
  table: Omit<TableProps<T>, 'size' | 'pagination' | 'locale' | 'title' | 'footer'>;
  /** 表格沒有資料時顯示的內容，通常是 EmptyState。 */
  emptyNode: ReactNode;
}

export default function ListTable<T extends object>({ table, emptyNode }: ListTableProps<T>) {
  return (
    <Table<T>
      size="middle"
      {...table}
      pagination={{
        pageSize: LIST_PAGE_SIZE,
        showSizeChanger: false,
        hideOnSinglePage: true,
        showTotal: (total) => `共 ${total} 筆`,
      }}
      locale={{ emptyText: emptyNode }}
    />
  );
}
