import { NextRequest } from 'next/server';
import { authorize, authorizeIgnoringState } from '@/lib/authorize';
import { caseHasContracts, dispatch } from '@/lib/case-store';
import {
  deleteDraftContract,
  getContractCaseId,
  getContract,
  getContractRelations,
  saveDraft,
} from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { contractSubject, signing } from '@/lib/signing-module';
import { jsonOk, jsonError } from '@/lib/http';
import { inOrgTx, inOrgTxAs, readInOrgTx, readJson } from '@/lib/org-route';
import { routingInputError } from '@/lib/signature-routing';
import type { ContractFields, SignatureField } from '@/lib/types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// 詳情頁一次取回合約本體、衍生鏈鄰居（前身／後繼）與簽署進度，關聯合約分頁不必再發一次請求。
// 簽署進度是 null 代表沒有簽署任務：草稿，或沒有回填的舊合約。
export async function GET(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  const read = await readInOrgTx(async (tx) => {
    await authorize(tx, 'contract.read', { type: 'contract', id });
    const contract = await getContract(tx, id);
    return contract ? { contract, relations: await getContractRelations(tx, contract) } : null;
  });
  if (!read.ok) return read.response;
  if (!read.value) return contractNotFound();
  // 簽署任務還在 SQLite（MIL-85 搬走），在交易外讀
  return jsonOk({
    data: read.value.contract,
    relations: read.value.relations,
    signing_progress: await signing.getProgress(contractSubject(id)),
  });
}

export async function PUT(request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  const body = await readJson(request);
  return inOrgTx(async (tx) => {
    await authorizeIgnoringState(tx, 'contract.draft_send', { type: 'contract', id });
    // 鎖住這一列再讀：狀態檢查和寫入之間，送簽不能插進來
    const contract = await getContract(tx, id, 'update');
    if (!contract) return contractNotFound();
    if (contract.status !== 'draft') {
      return jsonError(409, '僅草稿可編輯；已送簽的合約請先撤回');
    }

    if (!isRecord(body)) return jsonError(400, '請求內容格式有誤');
    if (body.fields !== undefined && !isRecord(body.fields)) return jsonError(400, '合約欄位格式有誤');
    if (body.signature_fields !== undefined && !Array.isArray(body.signature_fields)) {
      return jsonError(400, '簽署區域格式有誤');
    }
    const routingError = routingInputError(isRecord(body.fields) ? body.fields.routing : undefined, contract.contract_type);
    if (routingError) return jsonError(400, routingError);

    const fields = { ...contract.fields, ...((body.fields as Partial<ContractFields> | undefined) ?? {}) };
    const signatureFields = (body.signature_fields as SignatureField[] | undefined) ?? contract.signature_fields;
    if (!(await saveDraft(tx, id, { fields, signature_fields: signatureFields }))) return contractNotFound();
    return jsonOk({ data: { id } });
  });
}

export async function DELETE(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  // 歷程隨合約保存，草稿刪除時一併移除；合約、歷程、稽核事件同交易
  return inOrgTxAs(async (tx, rc) => {
    await authorizeIgnoringState(tx, 'contract.draft_send', { type: 'contract', id });
    const caseId = await getContractCaseId(tx, id);
    const result = await deleteDraftContract(tx, id);
    if (result === 'not_found') return contractNotFound();
    if (result === 'not_draft') return jsonError(409, '僅草稿可刪除');
    // 草稿刪除後，案件下已經沒有任何合約（沒有撤回或拒簽留下的舊合約）時，放棄這個 draft 案件，不留下空的草稿案件。
    // 還有舊合約的案件保留：使用者可以再複製舊合約為新草稿
    if (caseId && !(await caseHasContracts(tx, caseId))) {
      await dispatch(tx, caseId, { type: 'abandon' }, { actor: { partyId: rc.partyId } });
    }
    return jsonOk({ data: { id } });
  });
}
