import { NextRequest } from 'next/server';
import { getContract } from '@/lib/db';
import { isMockMode } from '@/lib/dottedsign';
import { applyDsEvent, DsEvent } from '@/lib/transitions';
import { saveContractFilesOnCompleted } from '@/lib/contract-files';

// 僅 mock 模式可用：模擬點點簽 webhook 推進狀態（與真 webhook 走同一套轉移邏輯）
export async function POST(request: NextRequest) {
  if (!isMockMode()) {
    return Response.json({ error: 'live 模式下請走真實 webhook' }, { status: 403 });
  }
  const body = await request.json();
  const contract = getContract(Number(body.contract_id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });

  const event = body.event as DsEvent;
  if (!['signed', 'completed', 'declined'].includes(event)) {
    return Response.json({ error: '不支援的事件' }, { status: 400 });
  }
  const next = applyDsEvent(contract, event, body.reason);
  if (!next) return Response.json({ error: `目前狀態（${contract.status}）不接受此事件` }, { status: 409 });

  // 與真 webhook 一致：完成後保存文件（mock 模式保存未簽版 PDF 充當已簽 PDF 示意）
  if (next === 'completed') await saveContractFilesOnCompleted(contract);

  return Response.json({ data: { id: contract.id, status: next } });
}
