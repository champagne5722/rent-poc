'use client';

// 移交清單與詳情共用的小元件。屋主端與後台（src/app/handovers）都用。
import { Button, Flex, Tag, Typography, theme } from 'antd';
import { CheckCircleFilled, ClockCircleOutlined, DownloadOutlined } from '@ant-design/icons';
import { HANDOVER_STATE_COLORS, HANDOVER_STATE_LABELS, formatSnapshotValue } from '@/lib/handover/labels';
import { missingKey, type HandoverSnapshot } from '@/lib/handover/snapshot';
import type { HandoverState, HandoverSides } from '@/lib/handover/transitions';
import styles from './handovers.module.css';

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

/** 六類內容。屋主端與後台共用。 */
export function SnapshotContent({
  snapshot,
  acknowledged = [],
}: {
  snapshot: HandoverSnapshot;
  /** 屋主確認時勾選知悉的缺項，確認後在缺項旁標示。 */
  acknowledged?: string[];
}) {
  const { token } = theme.useToken();
  return (
    <div className={styles.categories} style={{ ['--handover-hairline' as string]: token.colorSplit }}>
      {snapshot.categories.map((category) => (
        <section key={category.key} aria-labelledby={`cat-${category.key}`}>
          <Typography.Title level={5} id={`cat-${category.key}`} style={{ marginTop: 0 }}>
            {category.label}
          </Typography.Title>
          {category.items.map((item) => (
            <div key={item.key} className={styles.itemRow}>
              <Typography.Text type="secondary">{item.label}</Typography.Text>
              <span className={styles.wrap}>
                {item.status === 'present' && <Typography.Text>{formatSnapshotValue(category.key, item)}</Typography.Text>}
                {item.status === 'missing' && (
                  <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                    {acknowledged.includes(missingKey(category.key, item.key)) ? '缺項，屋主已知悉' : '缺項'}
                  </Tag>
                )}
                {item.status === 'not_applicable' && <Typography.Text type="secondary">不適用（沒有租賃案件）</Typography.Text>}
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** 移交完成後才出現。檔案由 route handler 產生，交出方、接收方、屋主各有自己的路徑。 */
export function ExportPackageButton({ href }: { href: string }) {
  return (
    <Button icon={<DownloadOutlined aria-hidden />} href={href} download>
      匯出移交包 ZIP
    </Button>
  );
}
