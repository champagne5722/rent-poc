import { NextRequest } from 'next/server';
import { getContract } from '@/lib/db';
import { serveContractFile } from '@/lib/contract-files';

type Ctx = { params: Promise<{ id: string }> };

// 下載點點簽 Audit Trail File（file_types[]=audit_trail）：
// 回合約完成時保存下來的檔案；沒保存到就當場向點點簽補抓一次。
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  return serveContractFile(contract, 'audit_trail');
}
