'use client';

// 屋主端選單「移交」的暫時頁面，避免選單連到 404。移交畫面由 F 線後續的票提供。
import { Flex, Typography } from 'antd';

export default function OwnerHandoversPage() {
  return (
    <Flex vertical gap={12}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        移交
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        之後會在這裡發起移交，並查看每個案件的移交包。畫面準備中。
      </Typography.Paragraph>
    </Flex>
  );
}
