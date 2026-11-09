import TenantCaseList from '@/components/TenantCaseList';
import { listTenantCases } from '@/lib/tenant';
import { partyContextOrResponse } from '@/lib/tenant/route';

// 我的案件（MIL-121）：承租人在所有組織的案件。沒有承租人身分時，layout 已顯示空狀態，這裡不渲染。
export default async function TenantHomePage() {
  const context = await partyContextOrResponse();
  if (!context.ok) return null;
  return <TenantCaseList cases={await listTenantCases(context.rc)} />;
}
