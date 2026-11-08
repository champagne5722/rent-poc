// 屋主匯出移交包 ZIP（MIL-98）。只在移交完成後，service 檢查移交屬於這位屋主。
import { currentOwnerSession } from '@/lib/current-owner-session';
import { handoverStore } from '@/lib/handover/demo-store';
import { exportHandoverPackage } from '@/lib/handover/org-service';
import { handoverPackageResponse } from '@/lib/handover/package-response';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await currentOwnerSession();
  if (!session) return Response.json({ error: '目前的帳號沒有屋主身分。' }, { status: 403 });
  const { id } = await params;
  const result = await exportHandoverPackage(handoverStore(), { kind: 'owner', partyId: session.partyId }, id);
  return handoverPackageResponse(result);
}
