import { jsonError } from '@/lib/http';
import { isUlid } from '@/lib/pg/ulid';

// 合約 route 共用的小工具（MIL-83）。

export type ContractRouteCtx = { params: Promise<{ id: string }> };

/** 格式錯誤的 ID、別的組織的 ID、不存在的 ID，三者的回應必須逐位元相同（P0-02 AC1），統一從這裡出。 */
export const contractNotFound = () => jsonError(404, '合約不存在');

/** 取出路徑上的合約 ID。格式不是 ULID 時回 null，呼叫端回 contractNotFound()。 */
export async function contractIdOf(params: ContractRouteCtx['params']): Promise<string | null> {
  const { id } = await params;
  return isUlid(id) ? id : null;
}
