import { NextRequest } from 'next/server';
import { authorize } from '@/lib/authorize';
import { jsonOk, jsonError } from '@/lib/http';
import { inOrgTx, readJson } from '@/lib/org-route';
import { isUlid } from '@/lib/pg/ulid';
import { AnchorKeyLockedError, AnchorKeyRejectedError, getProperty, parseAnchorKey, setPropertyAnchorKey } from '@/lib/properties';
import { propertyNotFound } from '@/lib/properties/not-found';

type Ctx = { params: Promise<{ id: string }> };

// 與 [id]/route.ts 相同：格式錯誤、別的組織、不存在的 ID，回應必須逐位元相同（P0-02 AC1），
// 權限不足也走同一個回應（ADR-0023 決議 6），所以統一用 propertyNotFound()。

/**
 * 補建號與修正建號（MIL-143、MIL-196）。物件通過文件核對前，使用者能自行填入或修正建號。
 * 回應與登錄物件相同（ADR-0028 決議 1）：鍵有沒有撞到別的組織、有沒有超過次數，回應都一樣。
 * 唯一的例外是鍵已被自己的組織登錄：回自己既有的那一筆。
 */
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
      const result = await setPropertyAnchorKey(tx, id, key.value);
      switch (result.kind) {
        case 'not_found':
          return propertyNotFound();
        case 'accepted':
          return jsonOk({ data: { id, anchor: result.anchor, verification_status: 'pending_verification' } });
        case 'existing':
          return jsonOk({ data: { id: result.propertyId, existing: true } });
      }
    });
  } catch (error) {
    // 例外讓交易回滾（PostgreSQL 在函式丟錯後交易已中止）
    if (error instanceof AnchorKeyLockedError) return jsonError(409, error.message);
    if (error instanceof AnchorKeyRejectedError) return jsonError(400, error.message);
    throw error;
  }
}
