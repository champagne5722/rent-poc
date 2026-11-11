import { jsonError, jsonOk } from '@/lib/http';
import { readJson } from '@/lib/org-route';
import { recordContactFlow } from '@/lib/ownership/conflict';
import { requireOwnershipOperator } from '@/lib/ownership/operator';
import { isUlid } from '@/lib/pg/ulid';

type Ctx = { params: Promise<{ id: string }> };

/**
 * 記一筆聯絡（MIL-208，ADR-0028 決議 4）。只有平台營運者。[id] 是後來的一方的審核項目編號。
 * body：{ target: 'earlier' | 'later', channel: 'phone' | 'email' | 'other', outcome, contacted_at? }。
 * outcome 是 500 字以內的結果文字。contacted_at 是 ISO 時間，不填取現在，不得晚於現在。記錄人由伺服器從登入身分取，body 不能指定。
 * 聯絡紀錄只存在平台的表和平台組織的鏈，不寫進任何一方的組織，也不通知任何一方。
 * 回 201 與 { data: { id } }。項目沒有衝突個案回 404，欄位不合格回 400 與 { field }。
 */
export async function POST(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  if (!isUlid(id)) return jsonError(404, '衝突個案不存在');
  const operator = await requireOwnershipOperator();
  if (!operator.ok) return operator.response;
  const body = (await readJson(request)) as Record<string, unknown> | null;
  let result;
  try {
    result = await recordContactFlow(operator.runs, id, {
      target: body?.target,
      channel: body?.channel,
      outcome: body?.outcome,
      contactedAt: body?.contacted_at,
    });
  } catch (error) {
    if ((error as { code?: string }).code === '22023') return jsonError(400, (error as Error).message, { extra: { field: 'contactedAt' } });
    throw error;
  }
  switch (result.status) {
    case 'recorded':
      return jsonOk({ data: { id: result.contactId } }, { status: 201 });
    case 'invalid':
      return jsonError(400, result.message, { extra: { field: result.field } });
    case 'not_found':
      return jsonError(404, '衝突個案不存在');
  }
}
