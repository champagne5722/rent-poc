'use client';

import { Layout } from 'antd';
import AccountBar from './AccountBar';
import styles from './ShellHeader.module.css';

// 後台與屋主端共用的頂部列（MIL-173）。只組合 antd 的 Layout.Header，外觀來自 DESIGN.md 的 Layout 與 Menu token。
// 左側 start 放品牌或頁面標題，中間 nav 放屋主端的頂部選單，右側固定是帳號列（名稱、身分切換器、成員、登出）。
// accountName 有值時直接顯示（屋主端已在 server 端讀到）；省略時由帳號列自己向 /api/auth/me 取（後台）。
export default function ShellHeader({
  start,
  nav,
  accountName,
}: {
  start: React.ReactNode;
  nav?: React.ReactNode;
  accountName?: string;
}) {
  return (
    <Layout.Header className={styles.bar}>
      <div className={styles.start}>{start}</div>
      {nav && <div className={styles.nav}>{nav}</div>}
      <div className={styles.account}>
        <AccountBar knownName={accountName} />
      </div>
    </Layout.Header>
  );
}
