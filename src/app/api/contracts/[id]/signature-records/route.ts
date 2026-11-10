import { authorize } from '@/lib/authorize';
import { getContract } from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { jsonOk } from '@/lib/http';
import { readInOrgTx } from '@/lib/org-route';
import { listSignatureRecords, listSignatureRecordSigners } from '@/lib/signature-records/repository';
import { signatureRecordDetails } from '@/lib/signature-records/detail';

// 合約的簽章紀錄（MIL-70），唯讀。只有包租與經紀居間等需要執業人員簽章的合約才有，兩方合約回空陣列。
// 執業主體名稱取自登錄，查不到時畫面退回 ID。登錄是外部來源，放在交易外查。
export async function GET(_request: Request, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  const read = await readInOrgTx(async (tx) => {
    await authorize(tx, 'contract.read', { type: 'contract', id });
    if (!(await getContract(tx, id))) return null;
    const records = await listSignatureRecords(tx, id);
    return { records, signers: records.length > 0 ? await listSignatureRecordSigners(tx, id) : new Map() };
  });
  if (!read.ok) return read.response;
  if (!read.value) return contractNotFound();
  const { records, signers } = read.value;
  return jsonOk({ data: await signatureRecordDetails(records, signers) });
}
