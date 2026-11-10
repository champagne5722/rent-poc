'use client';

import { Card, Typography } from 'antd';
import EmptyState from '@/components/page/EmptyState';
import ListTable from '@/components/page/ListTable';
import { formatFileSize, formatTaipeiDateTime } from '@/lib/ownership/format';
import type { EvidenceMeta } from '@/lib/practice-entities/evidence';

// 審核台的證據檔清單（MIL-180）。業別核對、統編認領、證書與同意書共用。
// 開啟證據檔仍走 /api/desk/evidence/[id]，每次開啟都寫稽核事件。

export default function EvidenceCard({ title, evidence, emptyText }: { title: string; evidence: EvidenceMeta[]; emptyText: string }) {
  return (
    <Card size="small" title={title}>
      <ListTable<EvidenceMeta>
        table={{
          rowKey: 'id',
          dataSource: evidence,
          columns: [
            { title: '檔名', dataIndex: 'fileName' },
            { title: '大小', dataIndex: 'byteSize', width: 90, align: 'right', render: formatFileSize },
            { title: '上傳時間', dataIndex: 'uploadedAt', width: 160, render: formatTaipeiDateTime },
            {
              title: '操作',
              key: 'action',
              width: 80,
              fixed: 'right',
              render: (_v, file) =>
                file.state === 'stored' ? (
                  // 開啟會寫稽核事件。新分頁開，不離開核對畫面
                  <a href={`/api/desk/evidence/${file.id}`} target="_blank" rel="noreferrer">
                    開啟
                  </a>
                ) : (
                  <Typography.Text type="secondary">已刪除</Typography.Text>
                ),
            },
          ],
        }}
        emptyNode={<EmptyState description={emptyText} />}
      />
    </Card>
  );
}
