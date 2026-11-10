'use client';

import { ArrowLeftOutlined } from '@ant-design/icons';
import { Flex } from 'antd';
import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './PageHeader.module.css';

// 頁首（MIL-174、ADR-0090）：標題、狀態標籤（選用）、主要動作、返回連結（選用）。
// 只組合 antd 的 Flex，字階用 DESIGN.md 的 type-page-title class。
// 標記為 client component，因為 @ant-design/icons 的圖示不能在 server component 載入；server component 仍然能渲染它。
// 頂部列（ShellHeader）左側放區域名稱，頁首放這一頁自己的標題，兩處不寫同一個詞（用法見 docs/ui/composite-components.md）。

export interface PageHeaderProps {
  /** 這一頁自己的標題。列表頁寫「X列表」，詳情頁寫物件的識別，例如「合約 #A1B2C3」。 */
  title: string;
  /** 標題右側的狀態標籤，用 StatusTag。 */
  tag?: ReactNode;
  /** 右側的動作。每個畫面至多一顆 primary Button。 */
  extra?: ReactNode;
  /** 返回上一層列表的連結。詳情頁必須給。 */
  back?: { href: string; label?: string };
}

export default function PageHeader({ title, tag, extra, back }: PageHeaderProps) {
  return (
    <Flex vertical gap="small">
      {back && (
        <Link href={back.href} className={styles.back}>
          <Flex component="span" gap="small" align="center">
            <ArrowLeftOutlined aria-hidden />
            {back.label ?? '返回列表'}
          </Flex>
        </Link>
      )}
      <Flex justify="space-between" align="center" gap="middle" wrap="wrap">
        <Flex align="center" gap="small" className={styles.title}>
          <h1 className="type-page-title">{title}</h1>
          {tag}
        </Flex>
        {extra && (
          <Flex align="center" gap="small">
            {extra}
          </Flex>
        )}
      </Flex>
    </Flex>
  );
}
