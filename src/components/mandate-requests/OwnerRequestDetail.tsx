'use client';

import { useState } from 'react';
import { Descriptions } from 'antd';
import { useRouter } from 'next/navigation';
import DetailPage from '@/components/page/DetailPage';
import NextStep from '@/components/page/NextStep';
import SettingsSection from '@/components/page/SettingsSection';
import StatusTag from '@/components/StatusTag';
import { formatTaipeiDateTime } from '@/lib/ownership/format';
import { licenseKindTitles, ownerNextStep } from '@/lib/mandate-requests/view';
import type { OwnerMandateRequest, PropertyGroup } from '@/lib/types';
import OwnerRequestFlow from './OwnerRequestFlow';

// 屋主的申請詳情（MIL-206 畫面段）。頁首寫明是哪一家業者的哪一種申請。內容與操作在 OwnerRequestFlow，與登入前連結頁登入後的畫面相同。
// 資料由 server component 載入。確認、送出、收回之後，這裡更新畫面並請 server component 重新載入。

export default function OwnerRequestDetail({ initial, groups, canEnd = true }: { initial: OwnerMandateRequest; groups: PropertyGroup[]; canEnd?: boolean }) {
  const router = useRouter();
  const [request, setRequest] = useState(initial);
  const [lastInitial, setLastInitial] = useState(initial);
  if (lastInitial !== initial) {
    setLastInitial(initial);
    setRequest(initial);
  }
  const step = ownerNextStep(request);

  return (
    <DetailPage
      header={{
        title: `${request.practice.name} 的${request.kind_label}`,
        tag: <StatusTag kind="mandateRequest" value={request.status} />,
        back: { href: '/requests', label: '返回申請列表' },
      }}
      nextStep={<NextStep headline={step.headline} owner={step.owner} detail={step.detail} tone={step.tone} />}
      aside={
        <SettingsSection title="業者與申請">
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'practice', label: '業者', children: request.practice.name },
              { key: 'tax', label: '統編', children: request.practice.tax_id },
              { key: 'kinds', label: '已驗證的業別', children: licenseKindTitles(request.practice.verified_kinds).join('、') || '—' },
              { key: 'kind', label: '申請的種類', children: request.kind_label },
              { key: 'created', label: '建立時間', children: formatTaipeiDateTime(request.created_at) },
              ...(request.status === 'pending_owner' && request.deadline ? [{ key: 'deadline', label: '連結失效時間', children: formatTaipeiDateTime(request.deadline) }] : []),
            ]}
          />
        </SettingsSection>
      }
    >
      <OwnerRequestFlow
        request={request}
        groups={groups}
        showPractice={false}
        canEnd={canEnd}
        onChange={(next) => {
          setRequest(next);
          router.refresh();
        }}
      />
    </DetailPage>
  );
}
