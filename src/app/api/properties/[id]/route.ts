import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { listAvailableCaseKinds } from '@/lib/case-store';
import { jsonOk, jsonError } from '@/lib/http';
import { inOrgTx, inOrgTxAs, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';
import { getProperty, parsePropertyInput, removeProperty, updateProperty } from '@/lib/properties';
import { propertyNotFound } from '@/lib/properties/not-found';

type Ctx = { params: Promise<{ id: string }> };

// 格式錯誤的 ID、別的組織的 ID、不存在的 ID，三者的回應必須逐位元相同（P0-02 AC1），
// 所以統一用 propertyNotFound()，不得各寫各的訊息。權限不足也走同一個回應（ADR-0023 決議 6）。

// `available_case_kinds`（MIL-209）：目前組織能對這個物件建立的案件種類，順序是 lease、master_lease、sublease。
// 物件沒有通過核對時是空陣列。只看目前組織自己的節點與案件，不洩漏別的組織的狀態。
// 建立時伺服端會再檢查一次（POST /api/contracts 帶 case_kind），這個欄位只給畫面決定入口。
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return propertyNotFound();
  return inOrgTxAs(async (tx, rc) => {
    await authorize(tx, 'property.read', { type: 'property', id });
    const property = await getProperty(tx, id);
    if (!property) return propertyNotFound();
    // 平台營運者的組織沒有物件，也不建案件
    const available = rc.orgKind === 'platform' ? [] : await listAvailableCaseKinds(tx, { orgId: rc.orgId, orgKind: rc.orgKind }, property);
    return jsonOk({ data: { ...property, available_case_kinds: available } });
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
