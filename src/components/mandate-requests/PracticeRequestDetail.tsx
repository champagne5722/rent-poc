'use client';

import { Descriptions } from 'antd';
import DetailPage from '@/components/page/DetailPage';
import NextStep from '@/components/page/NextStep';
import SettingsSection from '@/components/page/SettingsSection';
import StatusTag from '@/components/StatusTag';
import { formatTaipeiDateTime } from '@/lib/ownership/format';
import { draftBuildingNo, practiceNextStep } from '@/lib/mandate-requests/view';
import type { PracticeMandateRequest } from '@/lib/types';

// 業者的申請詳情（MIL-206 畫面段，驗收 13）。只顯示種類、狀態、建立與失效的時間、代填的摘要。
// 屋主送出後，多顯示租賃單位的數量。
// 不得顯示或暗示連結有沒有被打開：資料段的回應在「沒人打開」「有人打開」「已綁定但沒送出」三種情況逐位元相同，
// 這裡也沒有任何依這些情況而變的欄位或文字。
// 給 MIL-210：「接受」「不接受」的按鈕放在下面 NextStep 的 actions（業者的處理動作，狀態是待業者接受時才出現）。

export default function PracticeRequestDetail({ request }: { request: PracticeMandateRequest }) {
  const step = practiceNextStep(request);
  const draft = request.draft;
  const building = draftBuildingNo(draft);

  return (
    <DetailPage
      header={{
        title: request.kind_label,
        tag: <StatusTag kind="mandateRequest" value={request.status} />,
        back: { href: '/requests', label: '返回申請列表' },
      }}
      nextStep={<NextStep headline={step.headline} owner={step.owner} detail={step.detail} tone={step.tone} />}
      aside={
        <SettingsSection title="申請資訊">
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'kind', label: '申請的種類', children: request.kind_label },
              { key: 'created', label: '建立時間', children: formatTaipeiDateTime(request.created_at) },
              {
                key: 'deadline',
                label: request.status === 'pending_practice' ? '業者接受的期限' : '連結失效時間',
                children: request.status === 'expired' ? '已失效' : request.deadline ? formatTaipeiDateTime(request.deadline) : '—',
              },
              ...(request.submitted_at ? [{ key: 'submitted', label: '屋主送出時間', children: formatTaipeiDateTime(request.submitted_at) }] : []),
              ...(request.withdrawn_at ? [{ key: 'withdrawn', label: '屋主收回時間', children: formatTaipeiDateTime(request.withdrawn_at) }] : []),
              ...(request.unit_count !== null ? [{ key: 'units', label: '租賃單位', children: `${request.unit_count} 個` }] : []),
            ]}
          />
        </SettingsSection>
      }
    >
      <SettingsSection
        title="代填的物件資料"
        description="這是你替屋主填的資料。屋主確認前，不算登錄，不佔建號。連結失效、屋主送出或收回後，資料會刪除。"
      >
        {draft ? (
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'name', label: '物件名稱', children: draft.name },
              { key: 'address', label: '地址', children: draft.address },
              ...(building ? [{ key: 'building', label: '建號', children: building }] : []),
              { key: 'transcript', label: '代傳的謄本', children: request.transcript_file_name ?? '沒有代傳' },
            ]}
          />
        ) : (
          <span>{request.status === 'pending_owner' ? '沒有代填資料。屋主會從自己已登錄的租賃單位選。' : '沒有代填資料，或資料已刪除。'}</span>
        )}
      </SettingsSection>
    </DetailPage>
  );
}
