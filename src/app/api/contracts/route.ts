import { NextRequest } from 'next/server';
import { getProperty, insertContractWithEvent, listContracts } from '@/lib/db';
import { CONTRACT_TYPES, DEFAULT_CONTRACT_TYPE, contractTypeDefinition, initialFieldsFor } from '@/lib/contract-types';
import type { ContractFields } from '@/lib/types';
import type { ContractType } from '@/lib/labels';
import { routingInputError } from '@/lib/signature-routing';
import { contractSubject, signing, signingSubjectKey } from '@/lib/signing-module';
import type { SigningProgressById } from '@/lib/signing-steps';

// 清單與工作台共用。簽署進度一次批次查回整頁合約，以合約編號為鍵（MIL-72）。
// 沒有簽署任務的合約（草稿、沒有回填的舊合約）不在 signing_progress 裡。
// 清單只需要角色、姓名與狀態，不回簽署人的 email。
export async function GET() {
  const contracts = listContracts();
  const progress = await signing.getProgressBatch(contracts.map((c) => contractSubject(c.id)));
  const signingProgress: Record<string, NonNullable<SigningProgressById[string]>> = {};
  for (const c of contracts) {
    const entry = progress.get(signingSubjectKey(contractSubject(c.id)));
    if (!entry) continue;
    signingProgress[String(c.id)] = {
      status: entry.status,
      signers: entry.signers.map(({ role, name, status, concurrentRoles }) => ({
        role,
        name,
        status,
        ...(concurrentRoles ? { concurrentRoles } : {}),
      })),
    };
  }
  return Response.json({ data: contracts, signing_progress: signingProgress });
}

// 建立合約草稿，欄位快照由合約類型定義產生（綁定範本版本，見 contract-types）。`contract_type` 沒帶是租賃合約。
// - 租賃合約：從物件建立，物件資料帶入成快照。分流條件由建約 wizard 第一步填寫，存進欄位快照
//   隨草稿保存（ADR-0021 決議 1）；沒帶則視為自管。
// - 委託管理合約（MIL-74）：不綁單一物件，租賃單位在草稿建立後加入委託標的清單。
//   委託管理合約只存在於代管，沒有分流條件要填。
export async function POST(request: NextRequest) {
  const body = await request.json();
  const contractType: ContractType = body.contract_type ?? DEFAULT_CONTRACT_TYPE;
  if (!CONTRACT_TYPES.includes(contractType)) {
    return Response.json({ error: '不認得的合約類型' }, { status: 400 });
  }

  let propertyId: number | null = null;
  let fields: ContractFields;
  if (!contractTypeDefinition(contractType).requiresProperty) {
    fields = initialFieldsFor(contractType, {});
  } else {
    const property = getProperty(Number(body.property_id));
    if (!property) return Response.json({ error: '請指定有效的物件' }, { status: 400 });
    const routingError = routingInputError(body.routing, contractType);
    if (routingError) return Response.json({ error: routingError }, { status: 400 });
    propertyId = property.id;
    fields = initialFieldsFor(contractType, { property, routing: body.routing });
  }

  // 合約與「建立」歷程事件同交易寫入（ADR-0007）
  const id = insertContractWithEvent(
    { property_id: propertyId, fields: JSON.stringify(fields), contract_type: contractType },
    { type: 'created', actor: 'landlord' }
  );
  return Response.json({ data: { id } }, { status: 201 });
}
