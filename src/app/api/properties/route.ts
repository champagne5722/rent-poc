import { NextRequest } from 'next/server';
import { jsonOk, jsonError } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';
import { createProperty, listProperties, parsePropertyInput } from '@/lib/properties';

export async function GET() {
  return inOrgTx(async (tx) => jsonOk({ data: await listProperties(tx) }));
}

export async function POST(request: NextRequest) {
  const parsed = parsePropertyInput(await readJson(request));
  if (!parsed.ok) return jsonError(400, parsed.error);
  // 建物件時同一個交易建待驗證錨點與 0000 單位，表單就地新增的自訂設備也一併補進詞彙庫
  return inOrgTx(async (tx) => {
    const id = await createProperty(tx, parsed.value);
    return jsonOk({ data: { id } }, { status: 201 });
  });
}
