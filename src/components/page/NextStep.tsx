'use client';

import { Badge, Card, Flex, Typography } from 'antd';
import type { ReactNode } from 'react';
import type { StatusTone } from '@/lib/status-presentation';

// 「下一步」區塊（MIL-175、ADR-0090）：詳情頁頂端寫出現在卡在哪一步、下一步誰要做什麼。
// 只組合 antd 的 Card、Badge、Flex、Typography。色調沿用狀態呈現表的 5 種，對應 Badge 的狀態點。
// 標記為 client component，server component 仍然能渲染它。用法見 docs/ui/composite-components.md。

export interface NextStepProps {
  /** 下一步要做的事，一句話。 */
  headline: string;
  /** 負責人。 */
  owner: string;
  /** 補充說明，例如拒簽原因。 */
  detail?: string | null;
  tone: StatusTone;
  /** 這個區塊的處理動作，例如撤回、複製為新草稿。每個畫面至多一顆 primary Button，頁首已有時這裡不放。 */
  actions?: ReactNode;
  /** 動作下方的補充內容，例如簽署連結與模擬 webhook 按鈕。 */
  children?: ReactNode;
}

const BADGE_STATUS = {
  neutral: 'default',
  progress: 'processing',
  success: 'success',
  warning: 'warning',
  error: 'error',
} as const satisfies Record<StatusTone, 'default' | 'processing' | 'success' | 'warning' | 'error'>;

export default function NextStep({ headline, owner, detail, tone, actions, children }: NextStepProps) {
  return (
    <Card size="small" aria-label="下一步">
      <Flex vertical gap="small">
        <Flex justify="space-between" align="flex-start" gap="middle" wrap="wrap">
          <Flex vertical gap="var(--space-xxs)">
            <Typography.Text type="secondary" className="type-caption">
              下一步
            </Typography.Text>
            <Flex align="center" gap="small">
              <Badge status={BADGE_STATUS[tone]} />
              <h2 className="type-section-title">{headline}</h2>
            </Flex>
            <Typography.Text type="secondary">負責人：{owner}</Typography.Text>
            {detail && <Typography.Text type="secondary">{detail}</Typography.Text>}
          </Flex>
          {actions && (
            <Flex align="center" gap="small">
              {actions}
            </Flex>
          )}
        </Flex>
        {children}
      </Flex>
    </Card>
  );
}
