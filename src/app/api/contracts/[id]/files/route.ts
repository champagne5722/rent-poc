import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { getContract } from '@/lib/contracts';
import { contractIdOf, contractNotFound, type ContractRouteCtx } from '@/lib/contracts/route';
import { authorizeOnly, readInOrgTx } from '@/lib/org-route';
import { contractSubject, signing, signingErrorResponse } from '@/lib/signing-module';
import { jsonOk } from '@/lib/http';
import type { SignTaskFile } from '@/lib/signing-module/sign-task-files';

function omitObjectKey({ object_key, ...rest }: SignTaskFile) {
  void object_key;
  return rest;
}

// 文件紀錄改以簽署任務為鍵。回應仍帶 contract_id（現在是 ULID），形狀與改版前相同。
// 物件 key 是儲存層的位置，不對外；SHA-256 對外給（MIL-87 取代 rel_path）。
async function contractFiles(contractId: string) {
  const files = await signing.listFiles(contractSubject(contractId));
  return files.map((file) => ({ ...omitObjectKey(file), contract_id: contractId }));
}

// GET：列出已保存的合約文件與其狀態（含保存失敗的原因）
export async function GET(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  const read = await readInOrgTx(async (tx) => {
    await authorize(tx, 'contract.read', { type: 'contract', id });
    return getContract(tx, id);
  });
  if (!read.ok) return read.response;
  if (!read.value) return contractNotFound();
  return jsonOk({ data: await contractFiles(id) });
}

// POST：手動補抓，一律強制重抓。完成當下保存失敗時的補救手段。全成功回 200，有失敗回 207。
export async function POST(_request: NextRequest, { params }: ContractRouteCtx) {
  const id = await contractIdOf(params);
  if (!id) return contractNotFound();
  const denied = await authorizeOnly('contract.refetch_files', { type: 'contract', id });
  if (denied) return denied;
  try {
    const results = await signing.saveFiles(contractSubject(id), { force: true });
    const failed = results.filter((r) => !r.ok);
    return jsonOk(
      { data: { results, files: await contractFiles(id) } },
      { status: failed.length ? 207 : 200 }
    );
  } catch (e) {
    return signingErrorResponse(e, '補抓文件失敗');
  }
}
