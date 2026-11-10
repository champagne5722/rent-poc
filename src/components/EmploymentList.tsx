'use client';

import { useState, useTransition } from 'react';
import { App as AntApp, Button, Flex, Popconfirm, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import EmptyState from '@/components/page/EmptyState';
import ListTable from '@/components/page/ListTable';
import SettingsSection from '@/components/page/SettingsSection';
import StatusTag from '@/components/StatusTag';
import { practitionerTitle, type CertificateKind } from '@/lib/labels';
import type { OrgEmployment } from '@/lib/practitioners/applicant';
import { maskCertificateNumber } from '@/lib/practitioners/rules';

// 執業主體的任職清單（MIL-111、MIL-181）：這個執業主體有哪些執業人員在職，附證書與任職的驗證狀態與同意標示。
// 證號遮罩，只留序號最後 3 碼。結束任職是執業主體管理員的動作，權限在 /api/practitioner/employments/[id]/end 判斷。
// 只列自己組織的任職，不透露別的組織（ADR-0012 決議 8）。資料由執業主體頁的 server component 載入後傳進來。
// 必須放在 AntApp 內（執業主體頁的 PracticePanel 已經包了）。

export interface EmploymentListProps {
  orgEmployments: OrgEmployment[];
  isAdmin: boolean;
}

export default function EmploymentList({ orgEmployments, isAdmin }: EmploymentListProps) {
  const { message } = AntApp.useApp();
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [busy, setBusy] = useState(false);

  async function endEmployment(id: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/practitioner/employments/${id}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (response.ok) message.success('任職已結束。');
      else message.error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? '操作失敗，請稍後再試');
      startRefresh(() => router.refresh());
    } catch {
      message.error('網路發生問題，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection title="執業人員任職">
      <ListTable<OrgEmployment>
        emptyNode={<EmptyState description="還沒有執業人員登錄任職。成員從「我的證書」登錄。" />}
        table={{
          rowKey: 'id',
          dataSource: orgEmployments,
          scroll: { x: 'max-content' },
          columns: [
            { title: '姓名', dataIndex: 'displayName' },
            { title: '證書種類', dataIndex: 'certificateKind', render: (k: CertificateKind) => practitionerTitle(k) },
            { title: '證號', key: 'number', render: (_v, e) => maskCertificateNumber(e.number) },
            {
              title: '證書',
              dataIndex: 'practitionerState',
              width: 100,
              render: (state: OrgEmployment['practitionerState']) => <StatusTag kind="credentialState" value={state} />,
            },
            {
              title: '任職',
              key: 'state',
              width: 150,
              render: (_v, e) => (
                <Flex vertical gap={4} align="flex-start">
                  <StatusTag kind="credentialState" value={e.state} />
                  {e.consentedByEntity && <Typography.Text type="secondary">經所屬業者同意</Typography.Text>}
                </Flex>
              ),
            },
            { title: '到職日', dataIndex: 'startedOn', width: 120 },
            { title: '離職日', dataIndex: 'endedOn', width: 120, render: (v: string | null) => v ?? '—' },
            {
              title: '操作',
              key: 'action',
              width: 110,
              fixed: 'right',
              render: (_v, e) =>
                e.state === 'verified' && (isAdmin || e.isSelf) ? (
                  <Popconfirm
                    title="結束這筆任職？"
                    description="結束後，這位執業人員才能在別的執業主體建立任職。"
                    okText="結束任職"
                    cancelText="取消"
                    onConfirm={() => void endEmployment(e.id)}
                  >
                    <Button type="link" size="small" danger loading={busy}>
                      結束任職
                    </Button>
                  </Popconfirm>
                ) : null,
            },
          ],
        }}
      />
    </SettingsSection>
  );
}
