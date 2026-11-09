import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { getContract } from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { jsonError, jsonOk } from '@/lib/http';
import { inOrgTx, readInOrgTx, readJson } from '@/lib/org-route';
import type { OrgTx } from '@/lib/pg/with-tx';
import { getPracticeRegistry } from '@/lib/practice-registry';
import { getAssignments, replaceAssignments } from '@/lib/practitioner-assignment/repository';
import type { PractitionerAssignmentInput } from '@/lib/practitioner-assignment/seats';
import { evaluateSend, loadPrintedPractitioners, loadSeatOptions, validateAssignments } from '@/lib/practitioner-assignment/service';
import { loadContractRoutingFacts } from '@/lib/signature-routing/repository';
import { statusAnnexSendReasons } from '@/lib/status-annex/server';

// 執業人員的指派（MIL-69）。人選一律來自 practiceRegistry，不接受手動輸入（ADR-0018 決議 10 第 6 項）。
// 登錄查詢在交易外（ADR-0012 決議 10）：先在交易內讀合約、分流條件與指派，再算選項與檢查。
// GET 回指派選項、目前的指派與送簽前檢查的結果，wizard 的指派欄位與確認頁共用。
// GET ?only=printed 只回簽署欄要印的執業人員，詳情頁用。

async function loadForAssignment(tx: OrgTx, id: string, action: 'contract.read' | 'contract.draft_send') {
  await authorize(tx, action, { type: 'contract', id });
  const contract = await getContract(tx, id);
  if (!contract) return null;
  return { contract, routing: await loadContractRoutingFacts(tx, id), stored: await getAssignments(tx, id) };
}

export async function GET(request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  const read = await readInOrgTx((tx) => loadForAssignment(tx, id, 'contract.read'));
  if (!read.ok) return read.response;
  if (!read.value) return contractNotFound();
  const { contract, routing, stored } = read.value;
  if (!routing.ok) return jsonError(400, routing.reason);

  const resolution = getPracticeRegistry();
  const at = new Date().toISOString();
  const assignments = stored.map(({ slot, entityId, practitionerId, partySignerId }) => ({
    slot,
    entityId,
    practitionerId,
    partySignerId,
  }));
  // 詳情頁只要已指派的人，不必算選項與檢查
  if (request.nextUrl.searchParams.get('only') === 'printed') {
    return jsonOk({ data: { printed: await loadPrintedPractitioners(routing.facts, assignments, resolution) } });
  }
  const [options, printed, evaluation, annexReasons] = await Promise.all([
    loadSeatOptions(routing.facts, resolution, at),
    loadPrintedPractitioners(routing.facts, assignments, resolution),
    evaluateSend({ routing: routing.facts, contractType: contract.contract_type, fields: contract.fields, assignments, at }, resolution),
    // 現況確認附件頁缺少執業人員的簽署區域（MIL-71）。確認頁併入原因清單，與送簽時的檢查一致
    statusAnnexSendReasons(contract),
  ]);
  return jsonOk({
    data: {
      options,
      assignments,
      printed,
      evaluation: {
        ok: evaluation.ok && annexReasons.length === 0,
        reasons: [...evaluation.reasons, ...annexReasons],
        notices: evaluation.notices,
        // 同一人兼任而合併的席位，附上姓名給畫面提示（MIL-76）
        merges: evaluation.merges.map((m) => ({ ...m, name: printed[m.practitionerRuleId]?.name ?? '' })),
      },
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

const NOT_DRAFT = '僅草稿可改派；已送簽的合約請先撤回';

// 整批取代草稿的指派。只有草稿可改派；送簽後改派一律是撤回後衍生新草稿（ADR-0018 決議 11）。
export async function PUT(request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  const assignments = parseAssignments(await readJson(request));

  const read = await readInOrgTx((tx) => loadForAssignment(tx, id, 'contract.draft_send'));
  if (!read.ok) return read.response;
  if (!read.value) return contractNotFound();
  const { contract, routing, stored } = read.value;
  if (contract.status !== 'draft') return jsonError(409, NOT_DRAFT);
  if (!assignments) return jsonError(400, '指派資料的格式不正確');
  if (!routing.ok) return jsonError(400, routing.reason);
  const error = await validateAssignments(routing.facts, assignments, getPracticeRegistry(), stored);
  if (error) return jsonError(400, error);

  // 寫入時再鎖合約確認仍是草稿：驗證期間合約可能已被送簽
  return inOrgTx(async (tx) => {
    const locked = await getContract(tx, id, 'update');
    if (!locked) return contractNotFound();
    if (locked.status !== 'draft') return jsonError(409, NOT_DRAFT);
    await replaceAssignments(tx, id, assignments);
    return jsonOk({ data: { assignments } });
  });
}
