import { getContract } from '@/lib/db';
import { getPracticeRegistry } from '@/lib/practice-registry';
import { listSignatureRecords, listSignatureRecordSigners } from '@/lib/signature-records/repository';
import type { SignatureRecordDetail } from '@/lib/signature-records/types';

type Ctx = { params: Promise<{ id: string }> };

// 合約的簽章紀錄（MIL-70），唯讀。只有包租與經紀居間等需要執業人員簽章的合約才有，兩方合約回空陣列。
// 執業主體名稱取自登錄，查不到時畫面退回 ID。
export async function GET(_request: Request, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });

  const records = await listSignatureRecords(contract.id);
  if (records.length === 0) return Response.json({ data: [] });

  const signers = await listSignatureRecordSigners(contract.id);
  const resolution = getPracticeRegistry();
  const entityNames = new Map<string, string | null>();
  for (const entityId of new Set(records.map((r) => r.entityId))) {
    try {
      entityNames.set(entityId, resolution.available ? ((await resolution.registry.getEntity(entityId))?.name ?? null) : null);
    } catch {
      entityNames.set(entityId, null);
    }
  }

  const data: SignatureRecordDetail[] = records.flatMap((record) => {
    const signer = signers.get(record.signerId);
    return signer ? [{ ...record, signer, entityName: entityNames.get(record.entityId) ?? null }] : [];
  });
  return Response.json({ data });
}
