import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import {
  attachContract,
  CaseCreationBlocked,
  contractTypeForNewCase,
  createCaseFromProperty,
  createLeaseCase,
  routingForNewCase,
} from '@/lib/case-store';
import { isPropertyCaseKind } from '@/lib/cases';
import { buildSigningProgress } from '@/lib/contract-list-load';
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
import { canCreateCase, PROPERTY_NOT_VERIFIED_CODE, PROPERTY_NOT_VERIFIED_MESSAGE } from '@/lib/ownership/gate';
import { getOwnershipGate } from '@/lib/ownership/repository';
import { isUlid } from '@/lib/pg/ulid';
import { getProperty } from '@/lib/properties';
import { propertyNotFound } from '@/lib/properties/not-found';
import { BROKER_NOT_ALLOWED_CODE, BROKER_NOT_ALLOWED_MESSAGE } from '@/lib/practitioner-assignment/broker-choice';
import { canMediateBroker } from '@/lib/practitioner-assignment/broker-guard';
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

// 從物件與案件種類建立（MIL-209，ADR-0030）。body 帶 `case_kind` 時走這條新路徑，沒帶走下面的舊路徑，舊路徑行為不變。
// 舊路徑與過渡旗標由畫面段切換後移除，MIL-203 清掉。新路徑的規則：
// - 物件識別：`property_id` 是呼叫者組織自己的物件（一列一個租賃單位）。沒帶、格式錯誤、別的組織的、不存在、沒有權限，
//   回應與 GET /api/properties/[id] 的「不存在」逐位元相同（`propertyNotFound()`，ADR-0028）。
// - 案件種類：`lease`、`master_lease`、`sublease`。委託管理案件不綁單一物件，不走這裡（MIL-212）。
// - 檢查全部在伺服端重做：物件已核對、組織種類與案件種類相符、執業主體的業別與專任管理人員、
//   轉租案件的包租案件由伺服端用自家案件查，呼叫端不能傳上層案件的 ID，也不能傳 `lesseeIsMasterLessor`。
// - 合約類型由案件種類決定（`contractTypeForNewCase`）。分流條件由案件種類推出，body 只讀 `routing.brokerMediated`。
// 被擋下回 409：`property_not_verified`，或 decideCaseCreation 的原因碼（例如 `host_org_not_allowed`、`no_valid_master_lease`）。
async function createFromCaseKind(input: { contract_type?: unknown; property_id?: unknown; case_kind?: unknown; routing?: unknown }): Promise<Response> {
  if (!isPropertyCaseKind(input.case_kind)) return jsonError(400, '不認得的案件種類');
  const caseKind = input.case_kind;
  const type = contractTypeForNewCase(caseKind);
  if (input.contract_type !== undefined && input.contract_type !== type) return jsonError(400, '合約類型與案件種類不符');
  const routingInput = typeof input.routing === 'object' && input.routing !== null ? (input.routing as { brokerMediated?: unknown }) : {};
  const brokerMediated = routingInput.brokerMediated === true;
  if (!isUlid(input.property_id)) return propertyNotFound();
  const propertyId = input.property_id;

  return inOrgTxAs(async (tx, rc) => {
    // 平台營運者的組織沒有物件，也不建案件。與不存在同一個回應
    if (rc.orgKind === 'platform') return propertyNotFound();
    // 居間只限主辦組織自己兼營經紀業（MIL-200）：伺服端查呼叫者自己組織的經紀業別，不接受前端的旗標。
    // 屋主組織送 brokerMediated: true 在這裡被擋，在物件的授權之前，回應與沒有經紀業別的業者相同
    if (brokerMediated && !(await canMediateBroker(tx, rc.orgKind))) {
      return jsonError(409, BROKER_NOT_ALLOWED_MESSAGE, BROKER_NOT_ALLOWED_CODE);
    }
    // 以物件為對象授權：看不到的物件、不存在的物件與沒有權限，Forbidden 轉成同一個「不存在」回應
    await authorize(tx, 'contract.draft_send', { type: 'property', id: propertyId });
    const property = await getProperty(tx, propertyId);
    if (!property) return propertyNotFound();
    if (property.archived_at) return jsonError(409, '物件已封存，不能建立合約');
    // 未核對優先於案件種類的檢查。createLeaseCase 最前面還會再檢查一次
    if (!canCreateCase(await getOwnershipGate(tx, property.rental_unit_id))) return propertyNotVerified();
    let caseId: string;
    try {
      caseId = await createCaseFromProperty(tx, { orgId: rc.orgId, orgKind: rc.orgKind, lessorPartyId: rc.partyId, property, caseKind });
    } catch (error) {
      // createCaseFromProperty 在寫入任何資料前就丟錯，這裡回應不會留下半套資料
      if (error instanceof CaseCreationBlocked) {
        const reason = error.reasons[0];
        return reason.code === PROPERTY_NOT_VERIFIED_CODE ? propertyNotVerified() : jsonError(409, reason.message, reason.code);
      }
      throw error;
    }
    // 案件建成就代表組織種類能建這種案件，所以分流條件一定算得出來
    const routing = routingForNewCase(rc.orgKind, caseKind, brokerMediated);
    if (!routing) throw new Error('案件已建立，但分流條件算不出來');
    const fields = initialFieldsFor(type, { property, routing });
    const id = await createContract(tx, { property_id: property.id, fields, contract_type: type, case_id: caseId });
    await attachContract(tx, caseId, id, { actor: { partyId: rc.partyId } });
    return jsonOk({ data: { id, case_id: caseId, case_kind: caseKind } }, { status: 201 });
  });
}

export async function POST(request: NextRequest) {
  const body = await readJson(request);
  const input =
    typeof body === 'object' && body !== null
      ? (body as { contract_type?: unknown; property_id?: unknown; case_kind?: unknown; routing?: unknown })
      : {};
  if (input.case_kind !== undefined) return createFromCaseKind(input);
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
    // 舊路徑同樣由伺服端檢查居間（MIL-200）
    if ((routing as { brokerMediated?: unknown } | undefined)?.brokerMediated === true && !(await canMediateBroker(tx, rc.orgKind))) {
      return jsonError(409, BROKER_NOT_ALLOWED_MESSAGE, BROKER_NOT_ALLOWED_CODE);
    }
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
