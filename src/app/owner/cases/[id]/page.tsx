import { notFound } from 'next/navigation';
import CaseDetail from '@/components/CaseDetail';
import { loadCaseDetail } from '@/lib/case-detail-load';
import { currentOwnerSession } from '@/lib/current-owner-session';

// 案件詳情的唯讀版本（MIL-115）：屋主從資產總覽點選一列進入（MIL-94）。屋主以案件成員的身分讀取，不必加入主辦組織。
// 資料在 server component 載入（MIL-184）。載入中的骨架畫面在同資料夾的 loading.tsx。
export default async function OwnerCaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentOwnerSession();
  if (!session) return null;
  const { id } = await params;
  const result = await loadCaseDetail(id);
  if (result.kind !== 'ok') notFound();
  const { kind: _kind, ...detail } = result;
  void _kind;
  return <CaseDetail caseId={id} detail={detail} readOnly backHref="/owner" backLabel="返回資產總覽" />;
}
