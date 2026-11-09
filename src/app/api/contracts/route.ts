import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { attachContract, createLeaseCase } from '@/lib/case-store';
import { createContract, listContracts } from '@/lib/contracts';
import {
  CONTRACT_TYPES,
  DEFAULT_CONTRACT_TYPE,
  contractTypeDefinition,
  initialFieldsFor,
  type InitialFieldsInput,
} from '@/lib/contract-types';
import type { ContractType } from '@/lib/labels';
import { inOrgTx, inOrgTxAs, readInOrgTx, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';
import { getProperty } from '@/lib/properties';
import { routingInputError } from '@/lib/signature-routing';
import { jsonOk, jsonError } from '@/lib/http';
import { contractSubject, signing, signingSubjectKey } from '@/lib/signing-module';
import type { SigningProgressById } from '@/lib/signing-steps';

// 清單與工作台共用。簽署進度一次批次查回整頁合約，以合約編號為鍵（MIL-72）。
// 沒有簽署任務的合約（草稿、沒有回填的舊合約）不在 signing_progress 裡。
// 清單只需要角色、姓名與狀態，不回簽署人的 email。
export async function GET() {
  const read = await readInOrgTx(async (tx) => {
    await authorize(tx, 'contract.read', { type: 'org' });
    return listContracts(tx);
  });
  if (!read.ok) return read.response;
  const contracts = read.value;
  // 簽署進度另開組織交易批次查，不佔著清單的連線。查詢次數與合約數量無關
  const progress = await signing.getProgressBatch(contracts.map((c) => contractSubject(c.id)));
  const signingProgress: Record<string, NonNullable<SigningProgressById[string]>> = {};
  for (const c of contracts) {
    const entry = progress.get(signingSubjectKey(contractSubject(c.id)));
    if (!entry) continue;
    signingProgress[c.id] = {
      status: entry.status,
      signers: entry.signers.map(({ role, name, status, concurrentRoles }) => ({
        role,
        name,
        status,
        ...(concurrentRoles ? { concurrentRoles } : {}),
      })),
    };
  }
  return jsonOk({ data: contracts, signing_progress: signingProgress });
}

// 建立合約草稿，欄位快照由合約類型定義產生（綁定範本版本，見 contract-types）。`contract_type` 沒帶是租賃合約。
// - 租賃合約：從物件建立，物件資料帶入成快照。分流條件由建約 wizard 第一步填寫，存進欄位快照
//   隨草稿保存（ADR-0021 決議 1）；沒帶則視為自管。
// - 委託管理合約（MIL-74）：不綁單一物件，租賃單位在草稿建立後加入委託標的清單。
//   委託管理合約只存在於代管，沒有分流條件要填。
//
// 建約第一步先建立案件，合約掛在案件下（ADR-0023 決議 1，MIL-115）。屋主組織的租賃合約只能建自管案件。
// 執業主體組織的代管與包租案件要查業別與委託，屬 MIL-116：這裡仍建沒有案件的合約，走原本的 uncased 路徑。
// 委託管理合約不建租賃案件（它的案件是 management 類型，屬 MIL-116、119），權限走 uncased_contract.write。
export async function POST(request: NextRequest) {
  const body = await readJson(request);
  const input = typeof body === 'object' && body !== null ? (body as { contract_type?: unknown; property_id?: unknown; routing?: unknown }) : {};
  const contractType = input.contract_type ?? DEFAULT_CONTRACT_TYPE;
  if (typeof contractType !== 'string' || !(CONTRACT_TYPES as readonly string[]).includes(contractType)) {
    return jsonError(400, '不認得的合約類型');
  }
  const type = contractType as ContractType;

  // 委託管理合約不綁單一物件：沒有物件與分流條件要讀，org.contracts.property_id 是空的
  if (!contractTypeDefinition(type).requiresProperty) {
    const fields = initialFieldsFor(type, {});
    return inOrgTx(async (tx) => {
      // 沒有案件的合約：authorize 把 contract.draft_send 對到 uncased_contract.write（admin、staff）
      await authorize(tx, 'contract.draft_send', { type: 'org' });
      // 合約、「建立」歷程事件與稽核事件同交易寫入（ADR-0007、ADR-0019）
      const id = await createContract(tx, { property_id: null, fields, contract_type: type });
      return jsonOk({ data: { id } }, { status: 201 });
    });
  }

  if (!isUlid(input.property_id)) return jsonError(400, '請指定有效的物件');
  const propertyId = input.property_id;
  // 分流條件由建約 wizard 第一步填寫，存進欄位快照隨草稿保存（ADR-0021 決議 1）；沒帶則視為自管
  const routing = input.routing;

  // 讀物件與建合約在同一個交易。別的組織的物件與不存在的物件同樣回 400；
  // 即使讀到之後物件被刪，複合外鍵 (org_id, property_id) 也會讓建立失敗並回滾
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'contract.draft_send', { type: 'org' });
    const property = await getProperty(tx, propertyId);
    if (!property) return jsonError(400, '請指定有效的物件');
    if (property.archived_at) return jsonError(409, '物件已封存，不能建立合約');
    const routingError = routingInputError(routing, type);
    if (routingError) return jsonError(400, routingError);

    const fields = initialFieldsFor(type, {
      property,
      routing: routing as InitialFieldsInput['routing'],
    });

    // 案件、合約、兩者的歷程事件與稽核事件同交易寫入（ADR-0007、ADR-0016、ADR-0019）
    const caseId =
      rc.orgKind === 'owner'
        ? await createLeaseCase(tx, {
            orgId: rc.orgId,
            orgKind: 'owner',
            businessType: 'self_managed',
            lessorPartyId: rc.partyId,
            property,
          })
        : null;
    const id = await createContract(tx, {
      property_id: property.id,
      fields,
      contract_type: type,
      case_id: caseId,
    });
    if (caseId) await attachContract(tx, caseId, id, { actor: { partyId: rc.partyId } });
    return jsonOk({ data: { id } }, { status: 201 });
  });
}
