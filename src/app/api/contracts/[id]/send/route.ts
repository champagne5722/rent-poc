import { NextRequest } from 'next/server';
import { commitTransition, getContract } from '@/lib/db';
import { generateContractPdf } from '@/lib/pdf';
import { createSignTask } from '@/lib/dottedsign';

type Ctx = { params: Promise<{ id: string }> };

// 送簽：驗證欄位 → 產出 PDF → 建立點點簽簽署任務 → 進入「待乙方簽」
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const contract = getContract(Number(id));
  if (!contract) return Response.json({ error: '合約不存在' }, { status: 404 });
  if (contract.status !== 'draft') {
    return Response.json({ error: '僅草稿可送簽' }, { status: 409 });
  }

  const f = contract.fields;
  const missing: string[] = [];
  if (!f.landlordName.trim()) missing.push('甲方姓名');
  if (!/.+@.+\..+/.test(f.landlordEmail)) missing.push('甲方 Email');
  if (!f.tenantName.trim()) missing.push('乙方姓名');
  if (!/.+@.+\..+/.test(f.tenantEmail)) missing.push('乙方 Email');
  if (!f.startDate || !f.endDate) missing.push('租期起迄');
  if (f.rent == null) missing.push('租金');
  if (missing.length) {
    return Response.json({ error: `請先完成欄位：${missing.join('、')}` }, { status: 400 });
  }
  if (!contract.signature_fields.some((s) => s.signer === 'tenant')) {
    return Response.json({ error: '請至少為乙方設定一個簽署區域' }, { status: 400 });
  }
  if (!contract.signature_fields.some((s) => s.signer === 'landlord')) {
    return Response.json({ error: '請至少為甲方設定一個簽署區域' }, { status: 400 });
  }

  const pdf = await generateContractPdf(f);
  try {
    const { taskId, mock } = await createSignTask(contract, pdf);
    // 狀態與「送簽」歷程事件同交易寫入（ADR-0007）
    commitTransition(contract.id, {
      status: 'awaiting_tenant',
      event: { type: 'sent', actor: 'landlord', note: `寄送給乙方 ${contract.fields.tenantEmail}` },
      dottedsignTaskId: taskId,
    });
    return Response.json({ data: { id: contract.id, task_id: taskId, mock } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : '送簽失敗' }, { status: 502 });
  }
}
