'use client';

import { Button, Empty, Flex } from 'antd';
import { OWNER_ROOT_HREF } from '@/lib/nav';
import styles from './not-found.module.css';

export default function OwnerNotFound() {
  return (
    <Flex justify="center" className={styles.page}>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="找不到這個頁面">
        <Button href={OWNER_ROOT_HREF}>回到資產總覽</Button>
      </Empty>
    </Flex>
  );
}
