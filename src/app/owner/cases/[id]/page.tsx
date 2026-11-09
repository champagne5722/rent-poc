import CaseDetail from '@/components/CaseDetail';
import { currentOwnerSession } from '@/lib/current-owner-session';

// 案件詳情的唯讀版本（MIL-115）：屋主從資產總覽點選一列進入（MIL-94）。屋主以案件成員的身分讀取，不必加入主辦組織。
export default async function OwnerCaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentOwnerSession();
  if (!session) return null;
  const { id } = await params;
  return <CaseDetail caseId={id} readOnly backHref="/owner" />;
}
