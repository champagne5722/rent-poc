'use client';

import { useState, useTransition } from 'react';
import { Alert, App as AntApp, Button, Card, Empty, Flex, Radio, Tag, Typography } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import Link from 'next/link';
import { PRACTICE_ENTITY_STATUS_COLORS, PRACTICE_ENTITY_STATUS_LABELS } from '@/lib/handover/labels';
import type { InitiatableMandate } from '@/lib/handover/service';
import { startHandoversAction } from '../actions';
import styles from '../handovers.module.css';

function MandateOption({ item }: { item: InitiatableMandate }) {
  const { mandate, openHandoverByUnit } = item;
  return (
    <Flex vertical gap={8 /* xs */} className={styles.wrap}>
      <Flex gap={8 /* xs */} wrap align="center">
        <Typography.Text strong>{mandate.mandatary.name}</Typography.Text>
        <Tag color={PRACTICE_ENTITY_STATUS_COLORS[mandate.mandatary.status]} style={{ marginInlineEnd: 0 }}>
          {PRACTICE_ENTITY_STATUS_LABELS[mandate.mandatary.status]}
        </Tag>
      </Flex>
      <Typography.Text type="secondary">
        {mandate.mandatary.statutoryTitle}，委託標的 {mandate.units.length} 個租賃單位
      </Typography.Text>
      <Flex vertical gap={4 /* xxs */} component="ul" style={{ margin: 0, paddingInlineStart: 24 /* lg */ }}>
        {mandate.units.map((unit) => (
          <li key={unit.rentalUnitId}>
            <Typography.Text>{unit.address}</Typography.Text>
            {unit.leaseCaseId === null && <Typography.Text type="secondary">（空置）</Typography.Text>}
            {openHandoverByUnit[unit.rentalUnitId] && (
              <Typography.Text type="secondary">（已有進行中的移交，不重複產生）</Typography.Text>
            )}
          </li>
        ))}
      </Flex>
    </Flex>
  );
}

function StartHandoverFormInner({ mandates }: { mandates: InitiatableMandate[] }) {
  const { message } = AntApp.useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  const isDone = (item: InitiatableMandate) => Object.values(item.openHandoverByUnit).every((id) => id !== null);

  const submit = () => {
    if (!selected) return;
    startTransition(async () => {
      // 成功時 action 直接導回清單，只有失敗才會回到這裡
      const result = await startHandoversAction(selected);
      if (!result.ok) {
        setErrors(result.errors);
        message.error('沒有產生草稿');
      }
    });
  };

  return (
    <Flex vertical gap={24 /* lg */}>
      <Flex vertical gap={8 /* xs */}>
        <Link href="/owner/handovers">
          <ArrowLeftOutlined aria-hidden /> 移交
        </Link>
        <Typography.Title level={4} style={{ margin: 0 }}>
          發起移交
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          選擇要移交的委託管理案件。系統會為委託標的清單上的每個租賃單位各產生一份移交包草稿，你再逐案檢查缺項並確認。
        </Typography.Paragraph>
      </Flex>

      {errors.length > 0 && (
        <Alert type="error" showIcon title="沒有產生草稿" description={errors.join(' ')} />
      )}

      {mandates.length === 0 ? (
        <Card>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="你目前沒有委託中的委託管理案件，所以沒有可以移交的租賃單位。" />
        </Card>
      ) : (
        <Radio.Group value={selected} onChange={(e) => setSelected(e.target.value)} style={{ width: '100%' }}>
          <Flex vertical gap={12 /* sm */}>
            {mandates.map((item) => (
              <Card key={item.mandate.id} size="small">
                <Radio value={item.mandate.id} disabled={isDone(item)} style={{ alignItems: 'flex-start' }}>
                  <MandateOption item={item} />
                </Radio>
              </Card>
            ))}
          </Flex>
        </Radio.Group>
      )}

      <Flex gap={8 /* xs */} wrap>
        {/* TODO(MIL-108)：依 authorize() 的結果決定是否顯示「產生草稿」 */}
        <Button type="primary" disabled={!selected} loading={pending} onClick={submit}>
          產生草稿
        </Button>
        <Button href="/owner/handovers">返回</Button>
      </Flex>
    </Flex>
  );
}

export default function StartHandoverForm({ mandates }: { mandates: InitiatableMandate[] }) {
  return (
    <AntApp>
      <StartHandoverFormInner mandates={mandates} />
    </AntApp>
  );
}
