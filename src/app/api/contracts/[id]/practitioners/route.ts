import { NextRequest } from 'next/server';
import { getContract } from '@/lib/db';
import { getPracticeRegistry } from '@/lib/practice-registry';
import { getAssignments, replaceAssignments } from '@/lib/practitioner-assignment/repository';
import type { PractitionerAssignmentInput } from '@/lib/practitioner-assignment/seats';
import { evaluateSend, loadPrintedPractitioners, loadSeatOptions, validateAssignments } from '@/lib/practitioner-assignment/service';
import { loadContractRoutingFacts } from '@/lib/signature-routing/repository';

type Ctx = { params: Promise<{ id: string }> };

// 執業人員的指派（MIL-69）。人選一律來自 practiceRegistry，不接受手動輸入（ADR-0018 決議 10 第 6 項）。
// GET 回指派選項、目前的指派與送簽前檢查的結果，wizard 的指派欄位與確認頁共用。
// GET ?only=printed 只回簽署欄要印的執業人員，詳情頁用。
export async function GET(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });

  const routing = await loadContractRoutingFacts(contract.id);
  if (!routing.ok) return Response.json({ error: routing.reason }, { status: 400 });

  const resolution = getPracticeRegistry();
  const at = new Date().toISOString();
  const assignments = (await getAssignments(contract.id)).map(({ slot, entityId, practitionerId, partySignerId }) => ({
    slot,
    entityId,
    practitionerId,
    partySignerId,
  }));
  // 詳情頁只要已指派的人，不必算選項與檢查
  if (request.nextUrl.searchParams.get('only') === 'printed') {
    return Response.json({ data: { printed: await loadPrintedPractitioners(routing.facts, assignments, resolution) } });
  }
  const [options, printed, evaluation] = await Promise.all([
    loadSeatOptions(routing.facts, resolution, at),
    loadPrintedPractitioners(routing.facts, assignments, resolution),
    evaluateSend({ routing: routing.facts, contractType: contract.contract_type, fields: contract.fields, assignments, at }, resolution),
  ]);
  return Response.json({
    data: {
      options,
      assignments,
      printed,
      evaluation: { ok: evaluation.ok, reasons: evaluation.reasons, notices: evaluation.notices },
    },
  });
}

function parseAssignments(body: unknown): PractitionerAssignmentInput[] | null {
  const list = (body as { assignments?: unknown } | null)?.assignments;
  if (!Array.isArray(list)) return null;
  const parsed: PractitionerAssignmentInput[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return null;
    const { slot, entityId, practitionerId, partySignerId } = item as Record<string, unknown>;
    if (typeof slot !== 'string' || typeof entityId !== 'string' || typeof practitionerId !== 'string') return null;
    if (partySignerId !== null && partySignerId !== undefined && typeof partySignerId !== 'string') return null;
    parsed.push({ slot, entityId, practitionerId, partySignerId: partySignerId ?? null });
  }
  return parsed;
}

// 整批取代草稿的指派。只有草稿可改派；送簽後改派一律是撤回後衍生新草稿（ADR-0018 決議 11）。
export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  if (contract.status !== 'draft') {
    return Response.json({ error: '僅草稿可改派；已送簽的合約請先撤回' }, { status: 409 });
  }
  const assignments = parseAssignments(await request.json().catch(() => null));
  if (!assignments) return Response.json({ error: '指派資料的格式不正確' }, { status: 400 });

  const routing = await loadContractRoutingFacts(contract.id);
  if (!routing.ok) return Response.json({ error: routing.reason }, { status: 400 });
  const stored = await getAssignments(contract.id);
  const error = await validateAssignments(routing.facts, assignments, getPracticeRegistry(), stored);
  if (error) return Response.json({ error }, { status: 400 });

  await replaceAssignments(contract.id, assignments);
  return Response.json({ data: { assignments } });
}
