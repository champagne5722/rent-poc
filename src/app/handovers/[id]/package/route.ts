// 後台匯出移交包 ZIP（MIL-98）。交出方與接收方都能匯出，只在移交完成後。
import { currentPracticeOrgSession } from '@/lib/current-practice-org-session';
import { handoverStore } from '@/lib/handover/demo-store';
import { exportHandoverPackage } from '@/lib/handover/org-service';
import { handoverPackageResponse } from '@/lib/handover/package-response';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await currentPracticeOrgSession();
  if (!session) return Response.json({ error: '目前的帳號不屬於任何執業主體。' }, { status: 403 });
  const { id } = await params;
  const result = await exportHandoverPackage(handoverStore(), { kind: 'org', orgId: session.orgId }, id);
  return handoverPackageResponse(result);
}
