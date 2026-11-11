'use client';

import { Button } from 'antd';
import type { TableProps } from 'antd';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ListPage from '@/components/page/ListPage';
import StatusTag from '@/components/StatusTag';
import { formatTaipeiDateTime } from '@/lib/ownership/format';
import { draftSummaryText } from '@/lib/mandate-requests/view';
import type { OwnerMandateRequest, PracticeMandateRequest } from '@/lib/types';

// 申請列表（MIL-206 畫面段）。業者與屋主共用 /requests，依組織的種類顯示各自的欄位。
// 業者端只有種類、狀態、建立與失效的時間、代填的摘要，屋主送出後多一欄租賃單位的數量。不得有任何暗示連結有沒有被打開的欄位。
// 屋主端列出已綁定自己組織的申請。屋主沒送出就離開的申請，業者端沒有任何紀錄，屋主端仍看得到自己的。

const COUNT_UNKNOWN = '—';

const detailLink = (id: string) => (
  <Link href={`/requests/${id}`}>
    <Button type="link" size="small">
      查看
    </Button>
  </Link>
);

export function PracticeRequestList({ requests, canCreate }: { requests: PracticeMandateRequest[]; canCreate: boolean }) {
  const router = useRouter();
  const create = (
    <Button type="primary" onClick={() => router.push('/requests/new')}>
      產生申請連結
    </Button>
  );
  const columns: TableProps<PracticeMandateRequest>['columns'] = [
    { title: '申請的種類', dataIndex: 'kind_label', width: 140 },
    { title: '狀態', width: 130, render: (_, r) => <StatusTag kind="mandateRequest" value={r.status} /> },
    { title: '代填的物件資料', render: (_, r) => draftSummaryText(r.draft, r.status === 'pending_owner' ? '未代填' : COUNT_UNKNOWN) },
    { title: '租賃單位', width: 100, render: (_, r) => (r.unit_count === null ? COUNT_UNKNOWN : `${r.unit_count} 個`) },
    { title: '建立時間', width: 160, render: (_, r) => formatTaipeiDateTime(r.created_at) },
    { title: '期限', width: 160, render: (_, r) => (r.status === 'expired' ? '已失效' : r.deadline ? formatTaipeiDateTime(r.deadline) : COUNT_UNKNOWN) },
    { title: '操作', key: 'action', width: 80, fixed: 'right', render: (_, r) => detailLink(r.id) },
  ];
  return (
    <ListPage<PracticeMandateRequest>
      header={{
        title: '申請列表',
        extra: create,
      }}
      intro="產生連結後，自己把連結或 QR code 交給屋主。屋主登入、確認並送出後，申請會變成待業者接受。"
      table={{ rowKey: 'id', dataSource: requests, columns, scroll: { x: 'max-content' } }}
      empty={{
        description: canCreate ? '還沒有申請。產生申請連結，交給屋主。' : '還沒有申請。貴公司需要先通過代管業或包租業的核對，才能產生申請連結。',
        action: create,
      }}
    />
  );
}

export function OwnerRequestList({ requests }: { requests: OwnerMandateRequest[] }) {
  const columns: TableProps<OwnerMandateRequest>['columns'] = [
    { title: '業者', render: (_, r) => r.practice.name },
    { title: '申請的種類', dataIndex: 'kind_label', width: 140 },
    { title: '狀態', width: 130, render: (_, r) => <StatusTag kind="mandateRequest" value={r.status} /> },
    { title: '租賃單位', width: 100, render: (_, r) => (r.unit_ids.length > 0 ? `${r.unit_ids.length} 個` : COUNT_UNKNOWN) },
    { title: '建立時間', width: 160, render: (_, r) => formatTaipeiDateTime(r.created_at) },
    { title: '操作', key: 'action', width: 80, fixed: 'right', render: (_, r) => detailLink(r.id) },
  ];
  return (
    <ListPage<OwnerMandateRequest>
      header={{ title: '申請列表' }}
      intro="這裡列出你用業者的連結開啟過的申請。業者不會因為你打開連結而收到任何通知，送出申請後才會。"
      table={{ rowKey: 'id', dataSource: requests, columns, scroll: { x: 'max-content' } }}
      empty={{ description: '還沒有申請。業者給你連結後，用連結登入，申請會出現在這裡。' }}
    />
  );
}
