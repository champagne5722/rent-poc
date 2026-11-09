import { jsonError } from '../http';
import { isUlid } from '../pg/ulid';

// 案件 route 共用的小工具（MIL-115），寫法照 src/lib/contracts/route.ts。

export type CaseRouteCtx = { params: Promise<{ id: string }> };

/** 格式錯誤的 ID、別的組織的 ID、不存在的 ID、沒有權限的 ID，四者的回應必須逐位元相同（P0-02 AC1）。 */
export const caseNotFound = () => jsonError(404, '案件不存在');

/** 取出路徑上的案件 ID。格式不是 ULID 時回 null，呼叫端回 caseNotFound()。 */
export async function caseIdOf(params: CaseRouteCtx['params']): Promise<string | null> {
  const { id } = await params;
  return isUlid(id) ? id : null;
}
