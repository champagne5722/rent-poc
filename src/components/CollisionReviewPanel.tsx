'use client';

import { Card, Descriptions, Typography } from 'antd';
import DetailPage from '@/components/page/DetailPage';
import NextStep from '@/components/page/NextStep';
import StatusTag from '@/components/StatusTag';
import { formatTaipeiDateTime } from '@/lib/ownership/format';
import type { ReviewDetail } from '@/lib/practice-entities/desk';
import { deskNextStep } from '@/lib/practice-entities/desk-next-step';
import { claimedKeyText, formatWaiting, queueTypeLabel, resolutionLabel } from '@/lib/practice-entities/display';

// 撞號與撞號超限項目的詳情（MIL-144、MIL-180）。只列出與顯示：宣稱方、宣稱的鍵、送審時間與等待時間。
// 判定（同一產權、退回補件）屬 MIL-146，這裡沒有判定按鈕，「下一步」明說尚未開放。
// 不顯示既有登錄方的任何資料：撞號項目只讓營運者看到宣稱方這一邊。
// nowIso 是 server component 載入當下的時間：待審項目的等待時間算到這一刻，已結案的算到結案。

export default function CollisionReviewPanel({ detail, nowIso }: { detail: ReviewDetail; nowIso: string }) {
  const { item, collision } = detail;
  const open = item.status === 'open';
  const isLimit = item.type === 'anchor_collision_limit';
  const waitingMs = Math.max(0, (item.resolvedAt ? new Date(item.resolvedAt).getTime() : new Date(nowIso).getTime()) - new Date(item.createdAt).getTime());
  const step = deskNextStep(item);

  return (
    <DetailPage
      header={{ title: queueTypeLabel(item.type), tag: <StatusTag kind="reviewItem" value={item.status} />, back: { href: '/desk', label: '返回審核台' } }}
      nextStep={<NextStep headline={step.headline} owner={step.owner} detail={step.detail} tone={step.tone} />}
      aside={
        <Card size="small" title="項目屬性">
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'type', label: '類型', children: queueTypeLabel(item.type) },
              { key: 'ticket', label: '審核單號', children: <Typography.Text copyable>{item.id}</Typography.Text> },
              { key: 'created', label: '送審時間', children: formatTaipeiDateTime(item.createdAt) },
              { key: 'waiting', label: open ? '等待時間' : '處理時間', children: formatWaiting(waitingMs) },
              ...(item.resolvedAt ? [{ key: 'result', label: '結果', children: resolutionLabel(item.resolution) }] : []),
            ]}
          />
        </Card>
      }
    >
      <Card size="small" title="宣稱資料">
        <Descriptions
          size="small"
          column={1}
          items={[
            { key: 'claimant', label: '宣稱方', children: collision?.claimantOrgName ?? '—' },
            ...(isLimit
              ? [
                  { key: 'limit', label: '24 小時內的上限', children: collision?.limit != null ? `${collision.limit} 次` : '—' },
                  { key: 'hits', label: '上限用完後被擋的次數', children: collision?.hits != null ? `${collision.hits} 次` : '—' },
                  { key: 'last', label: '最近一次被擋', children: formatTaipeiDateTime(collision?.lastHitAt) },
                ]
              : [
                  {
                    key: 'key',
                    label: '宣稱的鍵',
                    children: collision?.claimedKey ? claimedKeyText(collision.claimedKey, collision.claimedKeyNames) : '—',
                  },
                ]),
          ]}
        />
      </Card>
    </DetailPage>
  );
}
