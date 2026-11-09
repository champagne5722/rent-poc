import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonOk, jsonError } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';
import {
  AnchorAlreadyKeyedError,
  AnchorKeyCollisionError,
  AnchorKeyRejectedError,
  getProperty,
  parseAnchorKey,
  setPropertyAnchorKey,
} from '@/lib/properties';
import { propertyNotFound } from '@/lib/properties/not-found';

type Ctx = { params: Promise<{ id: string }> };

// 與 [id]/route.ts 相同：格式錯誤、別的組織、不存在的 ID，回應必須逐位元相同（P0-02 AC1），
// 權限不足也走同一個回應（ADR-0023 決議 6），所以統一用 propertyNotFound()。

/** 補建號（MIL-143）。待驗證的錨點補上縣市、鄉鎮市區、段小段、建號、分號，沒有撞號時轉已建號。 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUlid(id)) return propertyNotFound();
  const body = await readJson(request);
  try {
    return await inOrgTx(async (tx) => {
      // 先 authorize（含確認物件存在）再驗本文：本文有誤時，也不洩漏別的組織的物件存在
      await authorize(tx, 'property.manage', { type: 'property', id });
      const current = await getProperty(tx, id);
      if (!current) return propertyNotFound();
      if (current.archived_at) return jsonError(409, '物件已封存，不能補建號');
      const key = parseAnchorKey(body);
      if (!key.ok) return jsonError(400, key.error);
      const anchor = await setPropertyAnchorKey(tx, id, key.value);
      return anchor ? jsonOk({ data: { id, anchor } }) : propertyNotFound();
    });
  } catch (error) {
    // 例外讓交易回滾（PostgreSQL 在函式丟錯後交易已中止）
    if (error instanceof AnchorKeyCollisionError || error instanceof AnchorAlreadyKeyedError) {
      return jsonError(409, error.message);
    }
    if (error instanceof AnchorKeyRejectedError) return jsonError(400, error.message);
    throw error;
  }
}
