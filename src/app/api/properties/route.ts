import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonOk, jsonError } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';
import { AnchorKeyCollisionError, createProperty, listProperties, parsePropertyInput } from '@/lib/properties';

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
  try {
    return await inOrgTx(async (tx) => {
      await authorize(tx, 'property.manage', { type: 'org' });
      const id = await createProperty(tx, parsed.value);
      return jsonOk({ data: { id } }, { status: 201 });
    });
  } catch (error) {
    // 填了鍵而且撞號：例外讓整個交易回滾，不留半成品錨點與物件。訊息固定，不分撞到誰（B3 才分流）
    if (error instanceof AnchorKeyCollisionError) return jsonError(409, error.message);
    throw error;
  }
}
