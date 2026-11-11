'use client';

import { Flex, Skeleton } from 'antd';
import styles from './WizardFrame.module.css';

// 建約精靈載入中的骨架畫面（MIL-176）：標題、步驟條、內容、按鈕列，版面與 WizardFrame 對齊。
// 放進 loading.tsx，取代整頁轉圈。標記為 client component：Skeleton.Input 在 server component 取不到。
export default function WizardSkeleton() {
  return (
    <div className={styles.root} aria-busy="true" aria-label="載入中">
      <div className={styles.top}>
        <Skeleton.Input active />
        <Skeleton.Input active block />
      </div>
      <div className={styles.body}>
        <Skeleton active paragraph={{ rows: 4 }} />
        <Skeleton active paragraph={{ rows: 4 }} />
      </div>
      <Flex justify="space-between" className={styles.footer}>
        <Skeleton.Button active />
        <Skeleton.Button active />
      </Flex>
    </div>
  );
}
