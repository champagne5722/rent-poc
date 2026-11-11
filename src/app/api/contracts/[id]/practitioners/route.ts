import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { getContract, getContractCaseId, saveDraft } from '@/lib/contracts';
import { withParty } from '@/lib/contract-types';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { jsonError, jsonOk } from '@/lib/http';
import { loadLeasingAuthorityFacts } from '@/lib/ownership/send-facts';
import { inOrgTx, readInOrgTx, readJson } from '@/lib/org-route';
import type { OrgTx } from '@/lib/pg/with-tx';
import { getPracticeRegistry } from '@/lib/practice-registry';
import { loadBrokerChoice } from '@/lib/practitioner-assignment/broker-guard';
import { buildPractitionerPayload } from '@/lib/practitioner-assignment/payload';
import { getAssignments, replaceAssignments } from '@/lib/practitioner-assignment/repository';
import { requestContext } from '@/lib/current-request-context';
import type { OrgKind } from '@/lib/request-context';
import type { PractitionerAssignmentInput } from '@/lib/practitioner-assignment/seats';
import {
  loadPrintedPractitioners,
  resolveAssignmentFacts,
  validateAssignments,
} from '@/lib/practitioner-assignment/service';
import { loadContractRoutingFacts } from '@/lib/signature-routing/repository';

// 執業人員的指派（MIL-69）。人選一律來自 practiceRegistry，不接受手動輸入（ADR-0018 決議 10 第 6 項）。
// 登錄查詢在交易外（ADR-0012 決議 10）：先在交易內讀合約、分流條件與指派，再算選項與檢查。
// GET 回指派選項、目前的指派與送簽前檢查的結果，wizard 的指派欄位與確認頁共用。
// GET ?only=printed 只回簽署欄要印的執業人員，詳情頁用。
//
// 簽章人員只從自家組織指派（MIL-200，ADR-0029 決議 3）：登錄只回自家組織的人，別的組織的 ID 與不存在的 ID 回應相同。
// 回傳的選項只有姓名，不含 email。當事人簽署人的真實 email 由 PUT 在伺服端補進合約欄位，不經過瀏覽器。
// 合約掛在案件下時，指派存成案件成員（需要 case_member.manage）；沒有案件的舊合約仍存在合約的指派表（MIL-203 移除）。

/** 呼叫者的組織種類。要在交易外讀：請求脈絡自己會開交易查 session，不能巢狀在 `inOrgTx` 裡（ADR-0012 決議 10）。 */
async function callerOrgKind(): Promise<OrgKind> {
  const rc = await requestContext();
  return rc.kind === 'org' ? rc.orgKind : 'owner';
}

async function loadForAssignment(tx: OrgTx, id: string, action: 'contract.read' | 'contract.draft_send', orgKind: OrgKind) {
  await authorize(tx, action, { type: 'contract', id });
  // 居間選項的狀態：依呼叫者自己組織的經紀業別算，不看前端傳入的任何旗標
  const brokerChoice = await loadBrokerChoice(tx, orgKind);
  const contract = await getContract(tx, id);
  if (!contract) return null;
  // 送簽預覽與送簽用同一組權源事實，原因一致（MIL-205）
  const leasingAuthority = await loadLeasingAuthorityFacts(tx, contract);
  return {
    contract,
    routing: await loadContractRoutingFacts(tx, id),
    stored: await getAssignments(tx, id),
    leasingAuthority,
    brokerChoice,
  };
}

export async function GET(request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  const orgKind = await callerOrgKind();
  const read = await readInOrgTx((tx) => loadForAssignment(tx, id, 'contract.read', orgKind));
  if (!read.ok) return read.response;
  if (!read.value) return contractNotFound();
  const { contract, routing, stored, leasingAuthority, brokerChoice } = read.value;
  if (!routing.ok) return jsonError(400, routing.reason);

  const assignments = stored.map(({ slot, entityId, practitionerId, partySignerId }) => ({
    slot,
    entityId,
    practitionerId,
    partySignerId,
  }));
  // 詳情頁只要已指派的人，不必算選項與檢查
  if (request.nextUrl.searchParams.get('only') === 'printed') {
    return jsonOk({ data: { printed: await loadPrintedPractitioners(routing.facts, assignments, getPracticeRegistry()) } });
  }
  // 精靈頁的 server component 用同一個函式載入首屏資料（MIL-176）
  return jsonOk({ data: await buildPractitionerPayload({ contract, routing, assignments, leasingAuthority, brokerChoice }) });
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

  const orgKind = await callerOrgKind();
  const read = await readInOrgTx((tx) => loadForAssignment(tx, id, 'contract.draft_send', orgKind));
  if (!read.ok) return read.response;
  if (!read.value) return contractNotFound();
  const { contract, routing, stored } = read.value;
  if (contract.status !== 'draft') return jsonError(409, NOT_DRAFT);
  if (!assignments) return jsonError(400, '指派資料的格式不正確');
  if (!routing.ok) return jsonError(400, routing.reason);
  const resolution = getPracticeRegistry();
  const error = await validateAssignments(routing.facts, assignments, resolution, stored);
  if (error) return jsonError(400, error);
  // 案件成員要寫執業人員的 party，合約欄位要補當事人簽署人的真實 email。都在交易外查登錄（ADR-0012 決議 10）
  const resolved = await resolveAssignmentFacts(routing.facts, assignments, resolution);
  if (!resolved.ok) return jsonError(400, resolved.error);

  // 寫入時再鎖合約確認仍是草稿：驗證期間合約可能已被送簽
  return inOrgTx(async (tx) => {
    const locked = await getContract(tx, id, 'update');
    if (!locked) return contractNotFound();
    if (locked.status !== 'draft') return jsonError(409, NOT_DRAFT);
    // 合約掛在案件下時，指派是案件的成員，必須有管理案件成員的權限
    const caseId = await getContractCaseId(tx, id);
    if (caseId) await authorize(tx, 'case_member.manage', { type: 'case', id: caseId });
    await replaceAssignments(tx, id, assignments, resolved.value.seats);
    // 執業主體是甲方或乙方時，那一方的姓名與 email 由所選的當事人簽署人帶入（ADR-0018 決議 2）。email 在這裡補，不經過瀏覽器
    if (resolved.value.partyFills.length > 0) {
      let fields = locked.fields;
      for (const fill of resolved.value.partyFills) {
        fields = withParty({ contract_type: locked.contract_type, fields }, fill.role, { name: fill.name, email: fill.email });
      }
      await saveDraft(tx, id, { fields, signature_fields: locked.signature_fields });
    }
    return jsonOk({ data: { assignments } });
  });
}
