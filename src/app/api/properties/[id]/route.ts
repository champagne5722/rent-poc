import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonOk, jsonError } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';
import { getProperty, parsePropertyInput, removeProperty, updateProperty } from '@/lib/properties';
import { propertyNotFound } from '@/lib/properties/not-found';

type Ctx = { params: Promise<{ id: string }> };

// 格式錯誤的 ID、別的組織的 ID、不存在的 ID，三者的回應必須逐位元相同（P0-02 AC1），
// 所以統一用 propertyNotFound()，不得各寫各的訊息。權限不足也走同一個回應（ADR-0023 決議 6）。

export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return propertyNotFound();
  return inOrgTx(async (tx) => {
    await authorize(tx, 'property.read', { type: 'property', id });
    const property = await getProperty(tx, id);
    return property ? jsonOk({ data: property }) : propertyNotFound();
  });
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return propertyNotFound();
  const body = await readJson(request);
  return inOrgTx(async (tx) => {
    // 先 authorize（含確認物件存在）再驗本文：本文有誤時，也不洩漏別的組織的物件存在
    await authorize(tx, 'property.manage', { type: 'property', id });
    const current = await getProperty(tx, id);
    if (!current) return propertyNotFound();
    if (current.archived_at) return jsonError(409, '物件已封存，不能編輯');
    const parsed = parsePropertyInput(body);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const updated = await updateProperty(tx, id, parsed.value);
    return updated ? jsonOk({ data: { id: updated.id } }) : propertyNotFound();
  });
}

/**
 * 刪除物件。物件有任何合約時改為封存（P0-06 AC8），回應的 result 告訴前端是 deleted 還是 archived。
 */
export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return propertyNotFound();
  return inOrgTx(async (tx) => {
    await authorize(tx, 'property.manage', { type: 'property', id });
    const result = await removeProperty(tx, id);
    return result === 'not_found' ? propertyNotFound() : jsonOk({ data: { id, result } });
  });
}
