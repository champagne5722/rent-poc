'use client';

// 屋主端的暫時首頁。MIL-96 會換成資產總覽（需要注意清單加全部租賃單位）。
import { Flex, Typography } from 'antd';

export default function OwnerHomePage() {
  return (
    <Flex vertical gap={12}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        資產總覽
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        這裡會列出你的全部租賃單位，包含自管、代管與空置的單位。畫面準備中。
      </Typography.Paragraph>
    </Flex>
  );
}
