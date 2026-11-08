import type { DbContext, OperatorContext, OrgContext, PartyContext } from './pg/with-tx';

// 請求脈絡（ADR-0022 決議 7，MIL-80、MIL-103）。
// 型別與 toDbContext 在這裡，讀 session 的實作在 current-request-context.ts 與 auth/。
// 這個檔案只放純資料，讓規則可以直接測。

export type OrgKind = 'owner' | 'practice' | 'platform';
export type OrgRole = 'admin' | 'staff' | 'viewer';

export type RequestContext =
  | { kind: 'org'; orgId: string; orgKind: OrgKind; userId: string; partyId: string; role: OrgRole; requestId: string }
  | { kind: 'party'; userId: string; partyId: string; requestId: string }
  | { kind: 'operator'; userId: string; partyId: string; requestId: string };

/** Unauthenticated 的原因，供頁面決定導向哪裡。對外的訊息一律相同，不洩漏細節。 */
export type UnauthenticatedReason =
  | 'no_session' // 沒有 cookie，或 cookie 查不到 session
  | 'expired' // session 已到期
  | 'no_identity' // 登入了，但帳號還沒有任何可用身分（MIL-106 的建組織流程接手）
  | 'membership_lost'; // 目前身分的成員資格已失效，session 已刪除並寫稽核

/** 沒有登入，或成員資格失效。頁面導向登入，route 回 401。 */
export class Unauthenticated extends Error {
  readonly reason: UnauthenticatedReason;
  constructor(message = '尚未登入或沒有存取權', reason: UnauthenticatedReason = 'no_session') {
    super(message);
    this.name = 'Unauthenticated';
    this.reason = reason;
  }
}

/** 登入了，但不是組織身分（例如承租人、平台營運者）。route 回 403。 */
export class OrgContextRequired extends Error {
  constructor(message = '此操作需要組織身分') {
    super(message);
    this.name = 'OrgContextRequired';
  }
}

/** 平台營運者對目標組織做事時，呼叫端另外帶的資料（ADR-0022 決議 7）。 */
export interface OperatorTarget {
  orgId: string;
  ticketId: string;
}

/** 把請求脈絡轉成 withTx 的脈絡。operator 必須另外帶目標組織與工單號，空工單號由 withTx 拒絕。 */
export function toDbContext(rc: Extract<RequestContext, { kind: 'org' }>): OrgContext;
export function toDbContext(rc: Extract<RequestContext, { kind: 'party' }>): PartyContext;
export function toDbContext(rc: Extract<RequestContext, { kind: 'operator' }>, target: OperatorTarget): OperatorContext;
export function toDbContext(rc: RequestContext, target?: OperatorTarget): DbContext;
export function toDbContext(rc: RequestContext, target?: OperatorTarget): DbContext {
  switch (rc.kind) {
    case 'org':
      return { kind: 'org', orgId: rc.orgId, partyId: rc.partyId };
    case 'party':
      return { kind: 'party', partyId: rc.partyId };
    case 'operator':
      if (!target) throw new Error('operator 脈絡必須另外帶目標組織與工單號');
      return { kind: 'operator', operatorId: rc.userId, orgId: target.orgId, ticketId: target.ticketId };
  }
}
