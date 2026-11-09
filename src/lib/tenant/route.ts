import { forbiddenResponse, Forbidden } from '../authorize';
import { caseNotFound, caseIdOf, type CaseRouteCtx } from '../case-store/route';
import { requestContext } from '../current-request-context';
import { jsonError } from '../http';
import { Unauthenticated } from '../request-context';
import type { PartyRequestContext } from './service';

// /tenant 底下 route 與頁面共用的骨架（MIL-121）。
// - 一律是 party 脈絡。org 與 operator 脈絡的請求回 403，不接受（承租人端沒有組織的概念）。
// - Forbidden（不是成員、關係已結束、案件不存在、不是承租人關係）一律轉成與「案件不存在」相同的 404（P0-09 AC1）。
// - 格式錯誤的 ID 與不存在的 ID 回應逐位元相同。

export { caseIdOf, caseNotFound, type CaseRouteCtx };

export const PARTY_ONLY_MESSAGE = '此操作需要承租人身分';

/** 取得 party 脈絡。沒登入回 401，不是承租人身分回 403。 */
export async function partyContextOrResponse(): Promise<{ ok: true; rc: PartyRequestContext } | { ok: false; response: Response }> {
  try {
    const rc = await requestContext();
    if (rc.kind !== 'party') return { ok: false, response: jsonError(403, PARTY_ONLY_MESSAGE) };
    return { ok: true, rc };
  } catch (error) {
    if (error instanceof Unauthenticated) return { ok: false, response: jsonError(401, error.message) };
    throw error;
  }
}

/** 以 party 脈絡執行 handler，並把 Forbidden 轉成「案件不存在」。 */
export async function inTenantContext(handler: (rc: PartyRequestContext) => Promise<Response>): Promise<Response> {
  const context = await partyContextOrResponse();
  if (!context.ok) return context.response;
  try {
    return await handler(context.rc);
  } catch (error) {
    if (error instanceof Forbidden) return forbiddenResponse(error);
    throw error;
  }
}
