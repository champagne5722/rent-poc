import { jsonOk } from '@/lib/http';
import { listTenantCases } from '@/lib/tenant';
import { inTenantContext } from '@/lib/tenant/route';

// 我的案件（MIL-121）：承租人在所有組織的案件。只接受 party 脈絡。
// 沒有案件時是空陣列，回應形狀與有案件時相同（P0-21 AC6）。
export async function GET() {
  return inTenantContext(async (rc) => jsonOk({ data: await listTenantCases(rc) }));
}
