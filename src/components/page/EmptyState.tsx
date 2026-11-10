'use client';

import { Empty } from 'antd';
import type { ReactNode } from 'react';

// 空狀態（MIL-174、ADR-0090）：說明文字加至多一個主要動作。只組合 antd 的 Empty。
// 標記為 client component：Empty.PRESENTED_IMAGE_SIMPLE 這類 antd 的靜態成員在 server component 取不到；server component 仍然能渲染它。
// 完全沒有資料時，動作是「建立」。篩選後沒有結果時，動作是「清除篩選」（ListPage 自動切換）。

export interface EmptyStateProps {
  /** 說明目前為什麼是空的，以及下一步。 */
  description: ReactNode;
  /** 唯一的主要動作，通常是一顆 Button。 */
  action?: ReactNode;
}

export default function EmptyState({ description, action }: EmptyStateProps) {
  return (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description}>
      {action}
    </Empty>
  );
}
