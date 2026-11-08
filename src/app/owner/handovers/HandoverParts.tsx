'use client';

// 移交清單與詳情共用的小元件。
import { Flex, Tag, Typography, theme } from 'antd';
import { CheckCircleFilled, ClockCircleOutlined } from '@ant-design/icons';
import { HANDOVER_STATE_COLORS, HANDOVER_STATE_LABELS } from '@/lib/handover/labels';
import type { HandoverState, HandoverSides } from '@/lib/handover/transitions';

export function HandoverStateTag({ state }: { state: HandoverState }) {
  return (
    <Tag color={HANDOVER_STATE_COLORS[state]} style={{ marginInlineEnd: 0 }}>
      {HANDOVER_STATE_LABELS[state]}
    </Tag>
  );
}

/** 一側是否完成（ADR-0015 後果段、ADR-0024 決議 8：中間狀態要顯示完成與否）。 */
export function SideStatus({ label, done }: { label: string; done: boolean }) {
  const { token } = theme.useToken();
  return (
    <Flex gap={4 /* xxs */} align="center" style={{ whiteSpace: 'nowrap' }}>
      {done ? (
        <CheckCircleFilled style={{ color: token.colorSuccess }} aria-hidden />
      ) : (
        <ClockCircleOutlined style={{ color: token.colorTextTertiary }} aria-hidden />
      )}
      <Typography.Text type={done ? undefined : 'secondary'}>
        {label}
        {done ? '已完成' : '未完成'}
      </Typography.Text>
    </Flex>
  );
}

export function SidesStatus({ sides }: { sides: HandoverSides }) {
  return (
    <Flex gap={12 /* sm */} wrap>
      <SideStatus label="交出側" done={sides.released} />
      <SideStatus label="接收側" done={sides.received} />
    </Flex>
  );
}
