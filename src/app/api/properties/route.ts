import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonOk, jsonError } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';
import { COLLISION_LIMIT_MESSAGE, COLLISION_QUEUED_MESSAGE, listProperties, parsePropertyInput, registerProperty } from '@/lib/properties';

export async function GET() {
  return inOrgTx(async (tx) => {
    await authorize(tx, 'property.read', { type: 'org' });
    return jsonOk({ data: await listProperties(tx) });
  });
}

export async function POST(request: NextRequest) {
  const parsed = parsePropertyInput(await readJson(request));
  if (!parsed.ok) return jsonError(400, parsed.error);
  // 建物件時同一個交易建待驗證錨點與 0000 單位，表單就地新增的自訂設備也一併補進詞彙庫
  return inOrgTx(async (tx) => {
    await authorize(tx, 'property.manage', { type: 'org' });
    const result = await registerProperty(tx, parsed.value);
    switch (result.kind) {
      case 'created':
        return jsonOk({ data: { id: result.id } }, { status: 201 });
      case 'review_queued':
        // 撞到別的組織（MIL-144）：物件照樣建立。回應只有固定訊息與審核單號，不含對方的任何資料
        return jsonOk({ data: { id: result.id, review: { ticket: result.reviewTicket, message: COLLISION_QUEUED_MESSAGE } } }, { status: 201 });
      case 'existing':
        // 撞到自己組織：沒有建新物件，回自己既有的那筆
        return jsonOk({ data: { id: result.id, existing: true } });
      case 'rate_limited':
        // 不丟例外：稽核事件與營運者的審核台項目必須跟著這個交易提交
        return jsonError(429, COLLISION_LIMIT_MESSAGE);
    }
  });
}
