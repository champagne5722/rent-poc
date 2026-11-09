import { NextRequest } from 'next/server';
import { handleJobRequest } from '@/lib/jobs/handler';
import { productionJobDeps } from '@/lib/jobs';

// 內部 job 的唯一入口（ADR-0020）：Cloud Scheduler 帶 OIDC token 呼叫。
// Basic Auth 放行這個路徑（src/lib/demo-access.ts），呼叫者驗證在 handleJobRequest。
export async function POST(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return handleJobRequest(request, name, productionJobDeps());
}
