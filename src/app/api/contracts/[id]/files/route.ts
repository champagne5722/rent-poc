import { NextRequest } from 'next/server';
import { getContract, listContractFiles } from '@/lib/db';
import { saveContractFiles } from '@/lib/contract-files';

type Ctx = { params: Promise<{ id: string }> };

// GET：列出已保存的合約文件與其狀態（含保存失敗的原因）
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  return Response.json({ data: listContractFiles(contract.id) });
}

// POST：手動補抓。完成轉移當下抓檔失敗（點點簽暫時性錯誤、連結過期等）時的補救手段。
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  if (contract.status !== 'completed') {
    return Response.json({ error: '合約尚未完成簽署，沒有可保存的文件' }, { status: 409 });
  }

  const results = await saveContractFiles(contract, { force: true });
  const failed = results.filter((r) => !r.ok);
  return Response.json({ data: { results, files: listContractFiles(contract.id) } }, { status: failed.length ? 207 : 200 });
}
