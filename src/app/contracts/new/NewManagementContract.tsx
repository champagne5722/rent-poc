'use client';

// 委託管理合約的暫時入口（MIL-209 決定 6，給 MIL-212）。委託管理合約不綁單一物件，租賃單位在草稿的委託標的清單加入，
// 所以不走「從物件建立案件」。在 MIL-212 做完從物件建立之前，保留原本的建立方式：按「下一步」建立草稿，不帶 case_kind，走舊路徑。
// 入口：物件列表頁的次要動作，網址 `/contracts/new?kind=management`（沒有 property 參數）。
// 版型與租賃類的入口相同，用 WizardFrame（MIL-176）。

import { useState } from 'react';
import { Alert, Button, Card, Flex } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { TemplateNotice, WizardFrame } from '@/components/contract-wizard';
import { contractTypeDefinition } from '@/lib/contract-types';
import { STEP_PROPERTY } from '@/lib/contract-wizard';
import { PROPERTY_LIST_HREF } from '@/lib/property-case-entry';

export default function NewManagementContract() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const definition = contractTypeDefinition('management');

  const createDraft = async () => {
    setCreating(true);
    setError(null);
    const res = await fetch('/api/contracts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract_type: 'management' }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setCreating(false);
      setError(json.error ?? '建立草稿失敗');
      return;
    }
    // replace：草稿已建立，回上一頁不該再回到空白的建約起點
    router.replace(`/contracts/${json.data.id}/edit`);
  };

  return (
    <WizardFrame
      title="建立合約"
      current={STEP_PROPERTY}
      draft={creating ? 'saving' : 'none'}
      error={error}
      prev={
        <Link href={PROPERTY_LIST_HREF}>
          <Button icon={<LeftOutlined />} disabled={creating}>
            返回物件列表
          </Button>
        </Link>
      }
      next={
        <Button type="primary" loading={creating} onClick={() => void createDraft()}>
          下一步 <RightOutlined />
        </Button>
      }
    >
      <Card size="small" title={definition.documentName}>
        <Flex vertical gap="middle">
          <Alert type="info" showIcon title={definition.draftNotice?.title} description={definition.draftNotice?.description} />
          <TemplateNotice contractType="management" />
        </Flex>
      </Card>
    </WizardFrame>
  );
}
