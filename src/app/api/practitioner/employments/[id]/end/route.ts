import { jsonError, jsonOk, readJson } from '@/lib/http';
import { endEmploymentFlow } from '@/lib/practitioners';
import { defaultFlowDeps } from '@/lib/practice-entities/deps';
import { requirePracticeActor } from '@/lib/practitioners/route';

type Ctx = { params: Promise<{ id: string }> };

// 結束已驗證的任職（MIL-111，P0-05 規則 3）。執業主體的 admin 或任職本人。
// 結束後，同一個人才能在別的執業主體建立任職。

export async function POST(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  const body = ((await readJson(request)) as { endedOn?: unknown } | undefined) ?? {};
  const gate = await requirePracticeActor('employment.end');
  if (!gate.ok) return gate.response;

  const result = await endEmploymentFlow(gate.actor, id, body, defaultFlowDeps());
  switch (result.status) {
    case 'ended':
      return jsonOk({ data: { ended: true } });
    case 'invalid':
      return jsonError(400, result.message, { extra: { field: result.field } });
    case 'not_found':
      return jsonError(404, '找不到這個任職');
    case 'not_verified':
      return jsonError(409, '只有已驗證的任職能結束');
    case 'forbidden':
      return jsonError(403, '只有執業主體的管理員與任職本人能結束任職');
    case 'conflict':
      return jsonError(409, '任職的狀態剛被改動，請重新整理後再操作');
  }
}
