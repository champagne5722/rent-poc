import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { attachContract, CaseCreationBlocked, createLeaseCase } from '@/lib/case-store';
import { buildSigningProgress } from '@/lib/contract-list-load';
import { createContract, listContracts } from '@/lib/contracts';
import {
  CONTRACT_TYPES,
  DEFAULT_CONTRACT_TYPE,
  contractTypeDefinition,
  initialFieldsFor,
  routingSnapshotFor,
  type InitialFieldsInput,
} from '@/lib/contract-types';
import type { ContractType } from '@/lib/labels';
import { inOrgTx, inOrgTxAs, readInOrgTx, readJson } from '@/lib/org-route';
import { canCreateCase, PROPERTY_NOT_VERIFIED_CODE, PROPERTY_NOT_VERIFIED_MESSAGE } from '@/lib/ownership/gate';
import { getOwnershipGate } from '@/lib/ownership/repository';
import { isUlid } from '@/lib/pg/ulid';
import { getProperty } from '@/lib/properties';
import { routingInputError } from '@/lib/signature-routing';
import { jsonOk, jsonError } from '@/lib/http';

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
  const signingProgress = await buildSigningProgress(contracts);
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
//
// 物件通過平台的文件核對後才能建立（ADR-0028 決議 5，MIL-205）。兩條路都擋，回 409 與 code `property_not_verified`：
// - 有案件的路：檢查在 createLeaseCase 裡，丟 CaseCreationBlocked，這裡轉成回應。
// - 沒有案件的路（代管業者與包租業者的組織）：不經 createLeaseCase，所以這裡用同一個讀取入口 getOwnershipGate 檢查。
function propertyNotVerified(): Response {
  return jsonError(409, PROPERTY_NOT_VERIFIED_MESSAGE, PROPERTY_NOT_VERIFIED_CODE);
}

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
  // 分流條件由建約 wizard 第一步填寫，存進欄位快照隨草稿保存（ADR-0021 決議 1）；沒帶則視為自管。
  // 包租合約與轉租合約的快照由合約類型決定（MIL-199，案件種類由合約類型決定），只有「是否有經紀業者居間」取自輸入
  const brokerMediated =
    typeof input.routing === 'object' && input.routing !== null && (input.routing as { brokerMediated?: unknown }).brokerMediated === true;
  const routing = routingSnapshotFor(type, brokerMediated) ?? input.routing;

  // 讀物件與建合約在同一個交易。別的組織的物件與不存在的物件同樣回 400；
  // 即使讀到之後物件被刪，複合外鍵 (org_id, property_id) 也會讓建立失敗並回滾
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'contract.draft_send', { type: 'org' });
    const property = await getProperty(tx, propertyId);
    if (!property) return jsonError(400, '請指定有效的物件');
    if (property.archived_at) return jsonError(409, '物件已封存，不能建立合約');
    // 轉租合約由包租業者擬定，屋主組織不辦轉租案件（ADR-0030 決議 1）
    if (type === 'sublease' && rc.orgKind === 'owner') return jsonError(400, '屋主組織不能建立轉租合約');
    const routingError = routingInputError(routing, type);
    if (routingError) return jsonError(400, routingError);
    // 沒有案件的路不經 createLeaseCase，所以在這裡檢查。有案件的路由 createLeaseCase 自己檢查
    if (rc.orgKind !== 'owner' && !canCreateCase(await getOwnershipGate(tx, property.rental_unit_id))) {
      return propertyNotVerified();
    }

    const checkedRouting = routing as InitialFieldsInput['routing'];
    const fields = initialFieldsFor(type, { property, routing: checkedRouting });

    // 案件、合約、兩者的歷程事件與稽核事件同交易寫入（ADR-0007、ADR-0016、ADR-0019）
    let caseId: string | null = null;
    if (rc.orgKind === 'owner') {
      try {
        caseId = await createLeaseCase(tx, {
          orgId: rc.orgId,
          orgKind: 'owner',
          businessType: 'self_managed',
          // 過渡：分流條件說承租人是包租業者時，案件歸為包租案件（ADR-0030）。MIL-203 移除
          lesseeIsMasterLessor: checkedRouting?.lesseeIsMasterLessor === true,
          lessorPartyId: rc.partyId,
          property,
        });
      } catch (error) {
        // createLeaseCase 在寫入任何資料前就丟錯，這裡回應不會留下半套資料
        if (error instanceof CaseCreationBlocked && error.reasons.some((r) => r.code === PROPERTY_NOT_VERIFIED_CODE)) {
          return propertyNotVerified();
        }
        throw error;
      }
    }
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
