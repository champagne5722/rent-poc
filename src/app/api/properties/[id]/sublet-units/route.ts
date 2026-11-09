import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonOk, jsonError } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';
import { SubletUnitRejectedError, createSubletUnit, getProperty, listSiblingUnits, parseSubletInput } from '@/lib/properties';
import { propertyNotFound } from '@/lib/properties/not-found';

type Ctx = { params: Promise<{ id: string }> };

// 與 [id]/route.ts 相同：格式錯誤、別的組織、不存在的 ID，回應必須逐位元相同（P0-02 AC1），
// 權限不足也走同一個回應（ADR-0023 決議 6），所以統一用 propertyNotFound()。

/** 同一產權錨點下，自己組織的物件與單位（物件頁「同一產權的單位」）。 */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return propertyNotFound();
  return inOrgTx(async (tx) => {
    await authorize(tx, 'property.read', { type: 'property', id });
    const units = await listSiblingUnits(tx, id);
    return units ? jsonOk({ data: units }) : propertyNotFound();
  });
}

/**
 * 新增分租單位（MIL-145，ADR-0025 決議 13）。在來源物件的錨點下建新單位與新物件，同交易。
 * 整戶有已完成且租期未屆滿的租賃合約時，第一次回 409 與 code，使用者確認後帶 confirmed: true 再送。
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return propertyNotFound();
  const body = await readJson(request);
  try {
    return await inOrgTx(async (tx) => {
      // 先 authorize（含確認物件存在）再驗本文：本文有誤時，也不洩漏別的組織的物件存在
      await authorize(tx, 'property.manage', { type: 'property', id });
      if (!(await getProperty(tx, id))) return propertyNotFound();
      const parsed = parseSubletInput(body);
      if (!parsed.ok) return jsonError(400, parsed.error);
      const result = await createSubletUnit(tx, id, parsed.value);
      switch (result.kind) {
        case 'created':
          return jsonOk({ data: { id: result.id, suffix: result.suffix } }, { status: 201 });
        case 'needs_confirmation':
          return jsonError(409, '整戶有已完成且租期未屆滿的租賃合約，新增分租單位前請先確認', 'whole_unit_active_lease');
        case 'archived':
          return jsonError(409, '物件已封存，不能新增分租單位');
        case 'not_found':
          return propertyNotFound();
      }
    });
  } catch (error) {
    // 例外讓交易回滾，不留下沒有物件的單位
    if (error instanceof SubletUnitRejectedError) return jsonError(400, error.message);
    throw error;
  }
}
