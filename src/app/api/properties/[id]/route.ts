import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonOk, jsonError } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';
import { deleteProperty, getProperty, parsePropertyInput, updateProperty } from '@/lib/properties';
import { propertyNotFound } from '@/lib/properties/not-found';

type Ctx = { params: Promise<{ id: string }> };

// 格式錯誤的 ID、別的組織的 ID、不存在的 ID，三者的回應必須逐位元相同（P0-02 AC1），
// 所以統一從這裡出，不得各寫各的訊息。
const notFound = propertyNotFound;

export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return notFound();
  return inOrgTx(async (tx) => {
    await authorize(tx, 'property.read', { type: 'property', id });
    const property = await getProperty(tx, id);
    return property ? jsonOk({ data: property }) : notFound();
  });
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return notFound();
  const body = await readJson(request);
  return inOrgTx(async (tx) => {
    // 先 authorize（含確認物件存在）再驗本文：本文有誤時，也不洩漏別的組織的物件存在
    await authorize(tx, 'property.manage', { type: 'property', id });
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
  return inOrgTx(async (tx) => {
    await authorize(tx, 'property.manage', { type: 'property', id });
    const result = await deleteProperty(tx, id);
    if (result === 'not_found') return notFound();
    // 物件有合約時只得封存（ADR-0025 決議 14）。封存功能屬 B 線，目前只擋刪除
    if (result === 'has_contracts') return jsonError(409, '物件已有合約，不能刪除，只能封存');
    return jsonOk({ data: { id } });
  });
}
