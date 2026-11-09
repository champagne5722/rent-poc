import { NextRequest } from 'next/server';
import { jsonOk } from '@/lib/http';
import { loadTenantCaseDetail } from '@/lib/tenant';
import { caseIdOf, caseNotFound, inTenantContext, type CaseRouteCtx } from '@/lib/tenant/route';

// 案件詳情（MIL-121）。別人的案件、不存在的案件、格式錯誤的 ID，回應逐位元相同（P0-09 AC1）。
export async function GET(_request: NextRequest, { params }: CaseRouteCtx) {
  const caseId = await caseIdOf(params);
  if (!caseId) return caseNotFound();
  return inTenantContext(async (rc) => jsonOk({ data: await loadTenantCaseDetail(rc, caseId) }));
}
