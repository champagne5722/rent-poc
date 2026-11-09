import type { DbContext, OperatorContext, OrgContext, PartyContext } from './pg/with-tx';
import { isUlid } from './pg/ulid';

// 請求脈絡（ADR-0022 決議 7，MIL-80）。
// 過渡期：C 線完成登入（MIL-103）之前，org 脈絡取自環境變數指定的預設組織。
// C 線只換 current-request-context.ts 的 requestContext()，這個檔案的型別與 toDbContext 不動。
// 這個檔案只放純資料與純解析，讓規則可以直接測。

export type OrgKind = 'owner' | 'practice' | 'platform';
export type OrgRole = 'admin' | 'staff' | 'viewer';

export type RequestContext =
  | { kind: 'org'; orgId: string; orgKind: OrgKind; userId: string; partyId: string; role: OrgRole; requestId: string }
  | { kind: 'party'; userId: string; partyId: string; requestId: string }
  | { kind: 'operator'; userId: string; partyId: string; requestId: string };

/** 沒有登入，或成員資格失效。頁面導向登入，route 回 401。 */
export class Unauthenticated extends Error {
  constructor(message = '尚未登入或沒有存取權') {
    super(message);
    this.name = 'Unauthenticated';
  }
}

/** 登入了，但不是組織身分（例如承租人、平台營運者）。route 回 403。 */
export class OrgContextRequired extends Error {
  constructor(message = '此操作需要組織身分') {
    super(message);
    this.name = 'OrgContextRequired';
  }
}

/** 預設組織的環境變數。值必須是 control.orgs 裡的組織 ID。種子見 db/migrations/0002_control_orgs.sql。 */
export const DEFAULT_ORG_ENV = 'DEFAULT_ORG_ID';

// 過渡期沒有帳號表，org 脈絡的使用者與 party 用固定的假 ID（時間部分全 0，不會和真實 ULID 撞號）。
// C 線換成讀 session 後，這兩個值就不再使用。
export const TRANSITIONAL_USER_ID = '00000000000000000000000003';
export const TRANSITIONAL_PARTY_ID = '00000000000000000000000004';

/**
 * 過渡期的解析：環境變數指定預設組織，以該組織的 admin 身分運作。
 * 沒有設定、或不是合法的 ULID 時丟 Unauthenticated，不開放存取（fail closed）。
 */
export function resolveTransitionalContext(
  env: Readonly<Record<string, string | undefined>>,
  requestId: string,
): RequestContext {
  const orgId = env[DEFAULT_ORG_ENV]?.trim();
  if (!orgId) throw new Unauthenticated(`沒有設定 ${DEFAULT_ORG_ENV}，不開放存取`);
  if (!isUlid(orgId)) throw new Unauthenticated(`${DEFAULT_ORG_ENV} 不是合法的組織 ID`);
  return {
    kind: 'org',
    orgId,
    // 預設組織不寫死成執業主體；C 線把它轉成屋主組織（SEED_OWNER_EMAIL 指定的帳號是 admin）
    orgKind: 'owner',
    userId: TRANSITIONAL_USER_ID,
    partyId: TRANSITIONAL_PARTY_ID,
    role: 'admin',
    requestId,
  };
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
