'use client';

import { useState } from 'react';
import { Alert, Descriptions, Flex, Tag, Typography } from 'antd';
import { LeftOutlined } from '@ant-design/icons';
import Link from 'next/link';
import type { ReviewDetail } from '@/lib/practice-entities/desk';
import { claimedKeyText, formatWaiting, queueTypeLabel, resolutionLabel } from '@/lib/practice-entities/display';

// 撞號與撞號超限項目的詳情（MIL-144）。只列出與顯示：宣稱方、宣稱的鍵、送審時間與等待時間。
// 判定（同一產權、退回補件）屬 MIL-146，這裡沒有判定按鈕，畫面明說尚未開放。
// 不顯示既有登錄方的任何資料：撞號項目只讓營運者看到宣稱方這一邊。

const formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false }) : '—');

export default function CollisionReviewPanel({ detail }: { detail: ReviewDetail }) {
  const { item, collision } = detail;
  const open = item.status === 'open';
  const isLimit = item.type === 'anchor_collision_limit';
  // 開啟畫面當下的時間：待審項目的等待時間算到現在，已結案的算到結案
  const [openedAt] = useState(() => Date.now());
  const waitingMs = Math.max(0, (item.resolvedAt ? new Date(item.resolvedAt).getTime() : openedAt) - new Date(item.createdAt).getTime());

  return (
    <Flex vertical gap="large" style={{ maxWidth: 960 }}>
      <Flex align="center" gap="middle" wrap>
        <Link href="/desk">
          <LeftOutlined aria-hidden /> 回審核台
        </Link>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {queueTypeLabel(item.type)}
        </Typography.Title>
        {!open && <Tag>已結案：{resolutionLabel(item.resolution)}</Tag>}
      </Flex>

      <Descriptions
        size="small"
        bordered
        column={1}
        items={[
          { key: 'ticket', label: '審核單號', children: <Typography.Text copyable>{item.id}</Typography.Text> },
          { key: 'claimant', label: '宣稱方', children: collision?.claimantOrgName ?? '—' },
          ...(isLimit
            ? [
                { key: 'limit', label: '24 小時內的上限', children: collision?.limit != null ? `${collision.limit} 次` : '—' },
                { key: 'hits', label: '上限用完後被擋的次數', children: collision?.hits != null ? `${collision.hits} 次` : '—' },
                { key: 'last', label: '最近一次被擋', children: formatDate(collision?.lastHitAt ?? null) },
              ]
            : [
                {
                  key: 'key',
                  label: '宣稱的鍵',
                  children: collision?.claimedKey ? claimedKeyText(collision.claimedKey, collision.claimedKeyNames) : '—',
                },
              ]),
          { key: 'created', label: '送審時間', children: formatDate(item.createdAt) },
          { key: 'waiting', label: open ? '等待時間' : '處理時間', children: formatWaiting(waitingMs) },
        ]}
      />

      {open && (
        <Alert
          type="info"
          showIcon
          title="判定功能尚未開放"
          description={
            isLimit
              ? '這個組織 24 小時內遇到已登錄產權的次數已達上限。目前只能查看，之後會提供處理方式。'
              : '撞號的判定（同一產權、退回補件）會在後續功能提供。目前只能查看。宣稱方的物件已建立，產權維持待驗證。'
          }
        />
      )}
    </Flex>
  );
}
