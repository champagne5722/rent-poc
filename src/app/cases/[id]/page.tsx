import CaseDetail from '@/components/CaseDetail';

// 案件詳情（MIL-115）：主辦組織的成員看得到全部，管理員與業務人員能加入共同承租人。
export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CaseDetail caseId={id} backHref="/cases" />;
}
