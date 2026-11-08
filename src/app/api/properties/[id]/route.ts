import { NextRequest } from 'next/server';
import { jsonOk, jsonError } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';
import { deleteProperty, getProperty, parsePropertyInput, updateProperty } from '@/lib/properties';

type Ctx = { params: Promise<{ id: string }> };

// 格式錯誤的 ID、別的組織的 ID、不存在的 ID，三者的回應必須逐位元相同（P0-02 AC1），
// 所以統一從這裡出，不得各寫各的訊息。
const notFound = () => jsonError(404, '物件不存在');

export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return notFound();
  return inOrgTx(async (tx) => {
    const property = await getProperty(tx, id);
    return property ? jsonOk({ data: property }) : notFound();
  });
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return notFound();
  const body = await readJson(request);
  return inOrgTx(async (tx) => {
    // 先確認物件存在再驗本文：本文有誤時，也不洩漏別的組織的物件存在
    if (!(await getProperty(tx, id))) return notFound();
    const parsed = parsePropertyInput(body);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const updated = await updateProperty(tx, id, parsed.value);
    return updated ? jsonOk({ data: { id: updated.id } }) : notFound();
  });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return notFound();
  return inOrgTx(async (tx) => ((await deleteProperty(tx, id)) ? jsonOk({ data: { id } }) : notFound()));
}
