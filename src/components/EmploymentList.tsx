'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Flex, Popconfirm, Table, Tag, Typography } from 'antd';
import { practitionerTitle, type CertificateKind } from '@/lib/labels';
import type { OrgEmployment } from '@/lib/practitioners/applicant';
import { maskCertificateNumber } from '@/lib/practitioners/rules';

// 執業主體的任職清單（MIL-111）：這個執業主體有哪些執業人員在職，附證書與任職的驗證狀態與同意標示。
// 證號遮罩，只留序號最後 3 碼。結束任職是執業主體管理員的動作，權限在 /api/practitioner/employments/[id]/end 判斷。
// 只列自己組織的任職，不透露別的組織（ADR-0012 決議 8）。

const STATE_TONE = { pending: undefined, verified: 'success', lapsed: 'error' } as const;
const STATE_LABEL = { pending: '待驗證', verified: '已驗證', lapsed: '已失效' } as const;

interface Payload {
  orgEmployments: OrgEmployment[];
  isAdmin: boolean;
  canWrite: boolean;
}

function EmploymentListInner() {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<{ payload: Payload } | { error: string }> => {
    try {
      const response = await fetch('/api/practitioner/me');
      if (response.status === 403) return { error: '目前的身分不是執業主體組織。' };
      if (!response.ok) throw new Error(String(response.status));
      return { payload: ((await response.json()) as { data: Payload }).data };
    } catch {
      return { error: '任職清單載入失敗，請重新整理。' };
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().then((result) => {
      if (cancelled) return;
      if ('payload' in result) {
        setData(result.payload);
        setError(null);
      } else {
        setError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

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
      const result = await load();
      if ('payload' in result) setData(result.payload);
    } catch {
      message.error('網路發生問題，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Alert type="error" showIcon title={error} />;
  if (!data) return <Typography.Text type="secondary">載入中…</Typography.Text>;

  return (
    <Flex vertical gap="small">
      <Typography.Title level={5} style={{ margin: 0 }}>
        執業人員任職
      </Typography.Title>
      <Table<OrgEmployment>
        size="middle"
        rowKey="id"
        pagination={false}
        dataSource={data.orgEmployments}
        locale={{ emptyText: '還沒有執業人員登錄任職。成員從「我的證書」登錄。' }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '姓名', dataIndex: 'displayName' },
          { title: '證書種類', dataIndex: 'certificateKind', render: (k: CertificateKind) => practitionerTitle(k) },
          { title: '證號', key: 'number', render: (_v, e) => maskCertificateNumber(e.number) },
          {
            title: '證書',
            dataIndex: 'practitionerState',
            width: 100,
            render: (state: OrgEmployment['practitionerState']) => <Tag color={STATE_TONE[state]}>{STATE_LABEL[state]}</Tag>,
          },
          {
            title: '任職',
            key: 'state',
            width: 150,
            render: (_v, e) => (
              <Flex vertical gap={4}>
                <Tag color={STATE_TONE[e.state]} style={{ marginInlineEnd: 0, width: 'fit-content' }}>
                  {STATE_LABEL[e.state]}
                </Tag>
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
            render: (_v, e) =>
              e.state === 'verified' && (data.isAdmin || e.isSelf) ? (
                <Popconfirm title="結束這筆任職？" description="結束後，這位執業人員才能在別的執業主體建立任職。" okText="結束任職" cancelText="取消" onConfirm={() => void endEmployment(e.id)}>
                  <Button size="small" danger loading={busy}>
                    結束任職
                  </Button>
                </Popconfirm>
              ) : null,
          },
        ]}
      />
    </Flex>
  );
}

export default function EmploymentList() {
  return (
    <AntApp>
      <EmploymentListInner />
    </AntApp>
  );
}
