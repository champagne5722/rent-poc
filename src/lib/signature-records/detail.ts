import { getPracticeRegistry } from '../practice-registry';
import type { SignatureRecord, SignatureRecordDetail } from './types';

/**
 * 簽章紀錄加上簽署人與執業主體名稱（MIL-70）。GET /api/contracts/[id]/signature-records 與詳情頁的 server component 共用。
 * 執業主體名稱取自登錄，查不到時是 null，畫面退回 ID。登錄是外部來源，必須在交易外呼叫。
 */
export async function signatureRecordDetails(
  records: readonly SignatureRecord[],
  signers: ReadonlyMap<string, SignatureRecordDetail['signer']>
): Promise<SignatureRecordDetail[]> {
  if (records.length === 0) return [];
  const resolution = getPracticeRegistry();
  const entityNames = new Map<string, string | null>();
  for (const entityId of new Set(records.map((r) => r.entityId))) {
    try {
      entityNames.set(entityId, resolution.available ? ((await resolution.registry.getEntity(entityId))?.name ?? null) : null);
    } catch {
      entityNames.set(entityId, null);
    }
  }
  return records.flatMap((record) => {
    const signer = signers.get(record.signerId);
    return signer ? [{ ...record, signer, entityName: entityNames.get(record.entityId) ?? null }] : [];
  });
}
